import { beforeEach, describe, expect, it } from "vitest";
import { saveConnectedProfile } from "@/lib/accounts";
import { prisma } from "@/lib/db";
import { backoffMs, processDuePosts, retryPost, STALE_LOCK_MS } from "@/lib/queue";
import { schedulePosts } from "@/lib/scheduler";
import { saveSettings } from "@/lib/settings";
import { encryptToken } from "@/lib/crypto";
import { fakeClip, mockAccount, resetDb } from "./helpers";

const past = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(async () => {
  await resetDb();
});

describe("planning & duplicaatpreventie", () => {
  it("plant clips × accounts en weigert dubbele planning", async () => {
    const [a, b] = [await mockAccount("tiktok"), await mockAccount("youtube")];
    const [c1, c2] = [await fakeClip("Een"), await fakeClip("Twee")];

    const first = await schedulePosts({ clipIds: [c1.id, c2.id], accountIds: [a.id, b.id], mode: "auto", generateCaptions: true });
    expect(first.created).toBe(4);
    expect(first.skipped).toHaveLength(0);

    const again = await schedulePosts({ clipIds: [c1.id, c2.id], accountIds: [a.id, b.id], mode: "auto" });
    expect(again.created).toBe(0);
    expect(again.skipped).toHaveLength(4);
    expect(await prisma.post.count()).toBe(4);
  });

  it("geeft elk account een eigen bijschrift-variant en eigen slots", async () => {
    const accounts = [await mockAccount("instagram"), await mockAccount("instagram"), await mockAccount("instagram")];
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: accounts.map((a) => a.id), mode: "auto", generateCaptions: true });
    const posts = await prisma.post.findMany();
    expect(new Set(posts.map((p) => p.caption + p.hashtags)).size).toBeGreaterThan(1);
    expect(posts.every((p) => p.status === "draft" && !p.approved)).toBe(true);
  });

  it("verdeelt meerdere clips over de posttijden van één account", async () => {
    const acc = await mockAccount("tiktok", { postingTimes: "10:00,18:00", dailyLimit: 2, timezone: "UTC" });
    const clips = [await fakeClip("a"), await fakeClip("b"), await fakeClip("c")];
    await schedulePosts({ clipIds: clips.map((c) => c.id), accountIds: [acc.id], mode: "auto" });
    const posts = await prisma.post.findMany({ orderBy: { scheduledAt: "asc" } });
    const hours = posts.map((p) => p.scheduledAt.getUTCHours());
    expect(hours.every((h) => h === 10 || h === 18)).toBe(true);
    expect(new Set(posts.map((p) => p.scheduledAt.getTime())).size).toBe(3);
  });
});

describe("wachtrij", () => {
  it("publiceert goedgekeurde posts die aan de beurt zijn (mock) en slaat concepten over", async () => {
    const acc = await mockAccount("tiktok");
    const [c1, c2] = [await fakeClip("a"), await fakeClip("b")];
    await schedulePosts({ clipIds: [c1.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    await schedulePosts({ clipIds: [c2.id], accountIds: [acc.id], mode: "at", at: past(), approve: false });

    const res = await processDuePosts();
    expect(res.processed).toEqual([expect.objectContaining({ outcome: "success" })]);
    const done = await prisma.post.findFirstOrThrow({ where: { clipId: c1.id } });
    expect(done.status).toBe("success");
    expect(done.externalId).toMatch(/^7\d{18}$/);
    expect(done.externalUrl).toContain(`tiktok.com/@${acc.handle}/video/`);
    expect((await prisma.post.findFirstOrThrow({ where: { clipId: c2.id } })).status).toBe("draft");
  });

  it("publiceert geen posts in de toekomst", async () => {
    const acc = await mockAccount("youtube");
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: new Date(Date.now() + 3600_000).toISOString(), approve: true });
    expect((await processDuePosts()).processed).toHaveLength(0);
  });

  it("verwerkt per account maximaal één post tegelijk, accounts parallel", async () => {
    const [a, b] = [await mockAccount("tiktok"), await mockAccount("instagram")];
    const clips = [await fakeClip("1"), await fakeClip("2"), await fakeClip("3")];
    await schedulePosts({ clipIds: clips.map((c) => c.id), accountIds: [a.id, b.id], mode: "at", at: past(), spacingMinutes: 0, approve: true });
    const r1 = await processDuePosts();
    expect(r1.processed).toHaveLength(2);
    expect(new Set(r1.processed.map((p) => p.postId)).size).toBe(2);
    await processDuePosts();
    await processDuePosts();
    expect(await prisma.post.count({ where: { status: "success" } })).toBe(6);
  });

  it("claimt atomair: twee workers tegelijk publiceren een post nooit dubbel", async () => {
    const acc = await mockAccount("tiktok");
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    const [r1, r2] = await Promise.all([processDuePosts({ workerId: "w1" }), processDuePosts({ workerId: "w2" })]);
    expect(r1.processed.length + r2.processed.length).toBe(1);
    const post = await prisma.post.findFirstOrThrow();
    expect(post.attempts).toBe(1);
  });

  it("probeert tijdelijke fouten opnieuw met backoff en geeft na maxAttempts op", async () => {
    await saveSettings({ MOCK_FAILURE_RATE: "1" });
    const acc = await mockAccount("youtube");
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });

    const r = await processDuePosts();
    expect(r.processed[0].outcome).toBe("retry");
    let post = await prisma.post.findFirstOrThrow();
    expect(post.status).toBe("queued");
    expect(post.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(post.lastError).toMatch(/mock/);

    // Niet opnieuw vóór nextAttemptAt
    expect((await processDuePosts()).processed).toHaveLength(0);

    // Tijd vooruit: blijf falen tot maxAttempts
    for (let i = 0; i < 5; i++) {
      await processDuePosts({ now: new Date(Date.now() + 10 * 3600_000) });
    }
    post = await prisma.post.findFirstOrThrow();
    expect(post.status).toBe("failed");
    expect(post.attempts).toBe(post.maxAttempts);

    // Handmatig opnieuw, nu zonder fouten
    await saveSettings({ MOCK_FAILURE_RATE: "0" });
    await retryPost(post.id);
    expect((await processDuePosts()).processed[0].outcome).toBe("success");
  });

  it("backoff groeit exponentieel en is begrensd", () => {
    const fixed = () => 0.5;
    expect(backoffMs(1, fixed)).toBe(30_000);
    expect(backoffMs(2, fixed)).toBe(120_000);
    expect(backoffMs(3, fixed)).toBe(480_000);
    expect(backoffMs(20, fixed)).toBe(3600_000);
  });

  it("ververst verlopen tokens automatisch vóór het uploaden", async () => {
    const acc = await mockAccount("tiktok", { tokenExpiresAt: new Date(Date.now() - 1000) });
    const oldToken = acc.accessToken;
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    expect((await processDuePosts()).processed[0].outcome).toBe("success");
    const fresh = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(fresh.accessToken).not.toBe(oldToken);
    expect(fresh.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("zet account en post op needs_reauth bij ingetrokken autorisatie, en hervat na herkoppelen", async () => {
    const acc = await mockAccount("instagram", {
      tokenExpiresAt: new Date(Date.now() - 1000),
      refreshToken: encryptToken("mock_revoked"),
    });
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });

    expect((await processDuePosts()).processed[0].outcome).toBe("needs_reauth");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).status).toBe("needs_reauth");
    expect((await prisma.post.findFirstOrThrow()).status).toBe("needs_reauth");

    // Herautorisatie (zelfde extern account) zet de post terug in de wachtrij
    await saveConnectedProfile("instagram", {
      externalId: acc.externalId,
      handle: acc.handle,
      displayName: acc.displayName,
      accessToken: "mock_instagram_at_new",
      refreshToken: "mock_instagram_rt_new",
      expiresAt: new Date(Date.now() + 3600_000),
    }, true);
    expect((await prisma.post.findFirstOrThrow()).status).toBe("queued");
    expect((await processDuePosts()).processed[0].outcome).toBe("success");
  });

  it("is idempotent: een post met externalId wordt niet opnieuw geüpload", async () => {
    const acc = await mockAccount("tiktok");
    const clip = await fakeClip();
    const { postIds } = await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    await prisma.post.update({ where: { id: postIds[0] }, data: { externalId: "already-live-123" } });
    expect((await processDuePosts()).processed[0].outcome).toBe("success");
    const post = await prisma.post.findUniqueOrThrow({ where: { id: postIds[0] } });
    expect(post.externalId).toBe("already-live-123");
  });

  it("herstelt vastgelopen posts: mock terug in wachtrij, echt account naar failed", async () => {
    const mock = await mockAccount("tiktok");
    const real = await prisma.account.create({
      data: { platform: "youtube", externalId: "UCreal", handle: "real", displayName: "Real", isMock: false, accessToken: "x", tokenExpiresAt: new Date(Date.now() + 3600_000) },
    });
    const [c1, c2] = [await fakeClip("a"), await fakeClip("b")];
    const stale = new Date(Date.now() - STALE_LOCK_MS - 1000);
    for (const [clip, acc] of [[c1, mock], [c2, real]] as const) {
      await prisma.post.create({
        data: { clipId: clip.id, accountId: acc.id, platform: acc.platform, scheduledAt: stale, status: "processing", approved: true, lockedAt: stale, lockedBy: "dead", attempts: 1, idempotencyKey: `${clip.id}:${acc.id}` },
      });
    }
    const res = await processDuePosts();
    expect(res.recovered).toBe(2);
    expect((await prisma.post.findFirstOrThrow({ where: { accountId: mock.id } })).status).toBe("success");
    const realPost = await prisma.post.findFirstOrThrow({ where: { accountId: real.id } });
    expect(realPost.status).toBe("failed");
    expect(realPost.lastError).toMatch(/Controleer op het platform/);
  });

  it("markeert een post als mislukt als het videobestand ontbreekt", async () => {
    const acc = await mockAccount("tiktok");
    const clip = await fakeClip();
    await prisma.clip.update({ where: { id: clip.id }, data: { filePath: "/bestaat/niet.mp4" } });
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    expect((await processDuePosts()).processed[0].outcome).toBe("failed");
  });

  it("slaat gepauzeerde accounts over", async () => {
    const acc = await mockAccount("tiktok", { status: "paused" });
    const clip = await fakeClip();
    await schedulePosts({ clipIds: [clip.id], accountIds: [acc.id], mode: "at", at: past(), approve: true });
    expect((await processDuePosts()).processed).toHaveLength(0);
  });
});
