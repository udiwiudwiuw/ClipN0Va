import crypto from "node:crypto";
import fs from "node:fs";
import { ensureFreshToken, markNeedsReauth } from "./accounts";
import { prisma } from "./db";
import { log } from "./log";
import { clientForAccount } from "./platforms";
import { PublishError } from "./platforms/types";
import { getSettings } from "./settings";

export const WORKER_ID = `worker-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
/** Na deze tijd geldt een post in `processing` als vastgelopen. */
export const STALE_LOCK_MS = 15 * 60_000;

/** Exponentiële backoff met jitter: 30s, 2m, 8m, 32m … max 1 uur. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000 * 4 ** Math.max(0, attempt - 1), 3600_000);
  return Math.round(base * (0.85 + random() * 0.3));
}

/**
 * Posts die in `processing` bleven hangen (bijv. server herstart tijdens upload).
 * Mock-accounts gaan veilig terug in de wachtrij. Bij echte accounts weten we
 * niet of het platform de upload al had ontvangen; om dubbele posts te
 * voorkomen gaan die naar `failed` zodat je eerst zelf kunt kijken.
 */
export async function recoverStaleLocks(now = new Date()) {
  const stale = await prisma.post.findMany({
    where: { status: "processing", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
    include: { account: true },
  });
  for (const p of stale) {
    if (p.externalId) {
      await prisma.post.update({ where: { id: p.id }, data: { status: "success", lockedAt: null, lockedBy: null, publishedAt: p.publishedAt ?? now } });
      continue;
    }
    const safe = p.account.isMock;
    await prisma.post.update({
      where: { id: p.id },
      data: safe
        ? { status: "queued", lockedAt: null, lockedBy: null, nextAttemptAt: now, lastError: "Onderbroken — opnieuw in wachtrij" }
        : {
            status: "failed",
            lockedAt: null,
            lockedBy: null,
            lastError: "Onderbroken tijdens upload. Controleer op het platform of de post er al staat voordat je opnieuw probeert.",
          },
    });
    await log("warn", `Vastgelopen post hersteld (${safe ? "terug in wachtrij" : "gemarkeerd als mislukt"})`, { postId: p.id, accountId: p.accountId });
  }
  return stale.length;
}

/** Claimt een post atomair (alleen als hij nog `queued` is). */
async function claim(postId: string, workerId: string): Promise<boolean> {
  const { count } = await prisma.post.updateMany({
    where: { id: postId, status: "queued" },
    data: { status: "processing", lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
  });
  return count === 1;
}

export type ProcessOutcome = "success" | "retry" | "failed" | "needs_reauth" | "skipped";

/** Verwerkt één geclaimde post. */
export async function processPost(postId: string): Promise<ProcessOutcome> {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { clip: true, account: true } });
  if (!post || post.status !== "processing") return "skipped";
  const { clip, account } = post;
  const ctx = { postId: post.id, accountId: account.id };

  const finish = (data: Parameters<typeof prisma.post.update>[0]["data"]) =>
    prisma.post.update({ where: { id: post.id }, data: { ...data, lockedAt: null, lockedBy: null } });

  // Idempotent: is de upload al eerder geaccepteerd, dan niet opnieuw posten.
  if (post.externalId) {
    await finish({ status: "success", publishedAt: post.publishedAt ?? new Date() });
    return "success";
  }
  if (account.status === "needs_reauth") {
    await finish({ status: "needs_reauth", lastError: "Account moet opnieuw worden geautoriseerd", attempts: { decrement: 1 } });
    return "needs_reauth";
  }
  if (!fs.existsSync(clip.filePath)) {
    await finish({ status: "failed", lastError: `Videobestand niet gevonden: ${clip.filePath}` });
    await log("error", `Bestand ontbreekt voor clip ${clip.filename}`, ctx);
    return "failed";
  }

  const settings = await getSettings();
  try {
    const acc = await ensureFreshToken(account, settings);
    await log("info", `Publiceren naar ${account.platform} @${account.handle} (poging ${post.attempts}/${post.maxAttempts})${account.isMock ? " [mock]" : ""}`, ctx);
    const res = await clientForAccount(acc).publish({ post, clip, account: acc, settings });
    await finish({
      status: "success",
      externalId: res.externalId,
      externalUrl: res.url ?? null,
      publishedAt: new Date(),
      lastError: null,
      nextAttemptAt: null,
    });
    await log("info", `Gepubliceerd: ${res.url ?? res.externalId}`, { ...ctx, meta: res.raw });
    return "success";
  } catch (err) {
    const e = err instanceof PublishError ? err : new PublishError((err as Error).message || String(err), "transient");
    if (e.kind === "auth") {
      if (account.status !== "needs_reauth") await markNeedsReauth(account.id, e.message);
      await finish({ status: "needs_reauth", lastError: e.message });
      return "needs_reauth";
    }
    if (e.kind === "transient" && post.attempts < post.maxAttempts) {
      const wait = Math.max(e.retryAfterMs ?? 0, backoffMs(post.attempts));
      await finish({ status: "queued", lastError: e.message, nextAttemptAt: new Date(Date.now() + wait) });
      await log("warn", `Tijdelijke fout, nieuwe poging over ${Math.round(wait / 1000)}s: ${e.message}`, ctx);
      return "retry";
    }
    await finish({ status: "failed", lastError: e.message });
    await log("error", `Publiceren mislukt: ${e.message}`, ctx);
    return "failed";
  }
}

export interface TickResult {
  recovered: number;
  processed: { postId: string; outcome: ProcessOutcome }[];
}

/**
 * Eén ronde van de worker: herstel vastgelopen posts, claim posts die aan de
 * beurt zijn (max. één tegelijk per account) en verwerk ze.
 */
export async function processDuePosts(opts: { limit?: number; now?: Date; workerId?: string; postIds?: string[] } = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const recovered = await recoverStaleLocks(now);

  const busy = await prisma.post.findMany({ where: { status: "processing" }, select: { accountId: true } });
  const busyAccounts = new Set(busy.map((b) => b.accountId));

  const candidates = await prisma.post.findMany({
    where: {
      status: "queued",
      approved: true,
      account: { status: { in: ["active", "needs_reauth", "error"] } },
      ...(opts.postIds ? { id: { in: opts.postIds } } : { scheduledAt: { lte: now } }),
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { scheduledAt: "asc" },
    take: (opts.limit ?? 10) * 3,
  });

  const picked: string[] = [];
  for (const c of candidates) {
    if (picked.length >= (opts.limit ?? 10)) break;
    if (busyAccounts.has(c.accountId)) continue;
    if (await claim(c.id, opts.workerId ?? WORKER_ID)) {
      busyAccounts.add(c.accountId);
      picked.push(c.id);
    }
  }

  // Accounts parallel, per account sequentieel (er is per account max. één geclaimd).
  const processed = await Promise.all(picked.map(async (id) => ({ postId: id, outcome: await processPost(id) })));
  return { recovered, processed };
}

/** Handmatig opnieuw proberen (mislukt / needs_reauth / geannuleerd). */
export async function retryPost(postId: string, now = new Date()) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new Error("Post niet gevonden");
  if (post.status === "success") throw new Error("Deze post is al gepubliceerd");
  if (post.status === "processing") throw new Error("Deze post wordt nu verwerkt");
  return prisma.post.update({
    where: { id: postId },
    data: {
      status: "queued",
      approved: true,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      scheduledAt: post.scheduledAt < now ? now : post.scheduledAt,
    },
  });
}

export async function queueStats() {
  const groups = await prisma.post.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of groups) out[g.status] = g._count._all;
  return out;
}
