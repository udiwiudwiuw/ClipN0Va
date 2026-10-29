import type { Account } from "@prisma/client";
import { decryptToken, encryptToken } from "./crypto";
import { prisma } from "./db";
import { log } from "./log";
import { clientForAccount } from "./platforms";
import { PublishError, type AccountWithTokens, type ConnectedProfile } from "./platforms/types";
import { getSettings, type Settings } from "./settings";

/** Ververs tokens die binnen deze marge verlopen. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export function withTokens(account: Account): AccountWithTokens {
  return { ...account, accessToken: decryptToken(account.accessToken), refreshToken: decryptToken(account.refreshToken) };
}

/** Haalt tokens nooit naar de browser. */
export function publicAccount(a: Account & { _count?: { posts: number } }) {
  const { accessToken, refreshToken, ...rest } = a;
  return { ...rest, hasToken: Boolean(accessToken), hasRefreshToken: Boolean(refreshToken) };
}

export async function markNeedsReauth(accountId: string, reason: string) {
  await prisma.account.update({ where: { id: accountId }, data: { status: "needs_reauth", lastError: reason } });
  await log("warn", `Account moet opnieuw worden geautoriseerd: ${reason}`, { accountId });
}

/**
 * Zorgt dat het account een geldig access token heeft; ververst indien nodig.
 * Bij een auth-fout wordt het account op `needs_reauth` gezet.
 */
export async function ensureFreshToken(account: Account, settings?: Settings, force = false): Promise<AccountWithTokens> {
  const acc = withTokens(account);
  const expiring = !acc.tokenExpiresAt || acc.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;
  if (!force && !expiring && acc.accessToken) return acc;

  const s = settings ?? (await getSettings());
  try {
    const tok = await clientForAccount(acc).refresh(acc, s);
    const updated = await prisma.account.update({
      where: { id: acc.id },
      data: {
        accessToken: encryptToken(tok.accessToken),
        refreshToken: encryptToken(tok.refreshToken ?? acc.refreshToken),
        tokenExpiresAt: tok.expiresAt ?? null,
        status: acc.status === "paused" ? "paused" : "active",
        lastError: null,
        lastSyncAt: new Date(),
      },
    });
    await log("info", `Token ververst voor ${acc.platform} @${acc.handle}`, { accountId: acc.id });
    return withTokens(updated);
  } catch (err) {
    const e = err instanceof PublishError ? err : new PublishError((err as Error).message, "transient");
    if (e.kind === "auth") await markNeedsReauth(acc.id, e.message);
    else await log("warn", `Token verversen mislukt (${e.message}); later opnieuw`, { accountId: acc.id });
    throw e;
  }
}

/**
 * Slaat een (her)gekoppeld account op. Bestaat het al (zelfde platform +
 * externe id), dan worden alleen de tokens vernieuwd en gaan posts die op
 * herautorisatie wachtten terug in de wachtrij.
 */
export async function saveConnectedProfile(platform: string, profile: ConnectedProfile, isMock: boolean) {
  const s = await getSettings();
  const tokenData = {
    accessToken: encryptToken(profile.accessToken),
    refreshToken: encryptToken(profile.refreshToken ?? null),
    tokenExpiresAt: profile.expiresAt ?? null,
    scopes: profile.scopes ?? null,
    status: "active",
    lastError: null,
    lastSyncAt: new Date(),
  };
  const existing = await prisma.account.findUnique({
    where: { platform_externalId: { platform, externalId: profile.externalId } },
  });
  const account = existing
    ? await prisma.account.update({
        where: { id: existing.id },
        data: { ...tokenData, handle: profile.handle, displayName: profile.displayName, avatarUrl: profile.avatarUrl ?? null },
      })
    : await prisma.account.create({
        data: {
          ...tokenData,
          platform,
          externalId: profile.externalId,
          handle: profile.handle,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl ?? null,
          isMock,
          timezone: s.DEFAULT_TIMEZONE,
          postingTimes: s.DEFAULT_POSTING_TIMES,
          dailyLimit: Number(s.DEFAULT_DAILY_LIMIT) || 3,
        },
      });
  if (existing) {
    const { count } = await prisma.post.updateMany({
      where: { accountId: account.id, status: "needs_reauth" },
      data: { status: "queued", nextAttemptAt: null, lastError: null, attempts: 0 },
    });
    await log("info", `Account opnieuw geautoriseerd: ${platform} @${account.handle}${count ? ` — ${count} post(s) terug in de wachtrij` : ""}`, {
      accountId: account.id,
    });
  } else {
    await log("info", `Account gekoppeld: ${platform} @${account.handle}${isMock ? " (mock)" : ""}`, { accountId: account.id });
  }
  return account;
}

/** Onderhoud: ververs tokens die binnen 24 uur verlopen (houdt refresh tokens levend). */
export async function refreshExpiringTokens() {
  const soon = new Date(Date.now() + 24 * 3600_000);
  const accounts = await prisma.account.findMany({
    where: { status: "active", tokenExpiresAt: { lt: soon } },
  });
  const s = await getSettings();
  for (const a of accounts) {
    try {
      await ensureFreshToken(a, s, true);
    } catch {
      /* al gelogd */
    }
  }
  return accounts.length;
}
