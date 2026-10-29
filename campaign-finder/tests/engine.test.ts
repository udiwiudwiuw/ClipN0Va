import { beforeEach, describe, expect, it } from "vitest";
import { analyzeMatch } from "@/lib/ai/analyze";
import { prisma } from "@/lib/db";
import { runSearchNow } from "@/lib/queue";
import { dueCampaigns } from "@/lib/scheduler";
import { mockPool, searchMock } from "@/lib/search/mock";
import { toSearchCampaign, upsertVideo } from "@/lib/search/engine";
import { makeCampaign, resetDb } from "./helpers";

beforeEach(resetDb);

describe("demo data engine", () => {
  it("is deterministisch en levert realistische velden", async () => {
    const c = toSearchCampaign(await makeCampaign());
    const a = mockPool(c);
    const b = mockPool(c);
    expect(a.map((v) => v.externalId)).toEqual(b.map((v) => v.externalId));
    expect(a.every((v) => v.externalId.length === 11 && v.url.includes(v.externalId))).toBe(true);
    expect(a.some((v) => v.transcript?.length)).toBe(true);
    expect(a.some((v) => /Sam de Vries|ondernemen|geld|sparen/.test(v.title))).toBe(true);
  });

  it("opeenvolgende rondes overlappen gedeeltelijk", async () => {
    const c = toSearchCampaign(await makeCampaign());
    const r0 = new Set(searchMock(c, 0).map((v) => v.externalId));
    const r1 = searchMock(c, 1).map((v) => v.externalId);
    const overlap = r1.filter((id) => r0.has(id)).length;
    expect(overlap).toBeGreaterThan(0);
    expect(overlap).toBeLessThan(r1.length);
  });
});

describe("zoekronde", () => {
  it("zoekt, filtert op lengte, slaat op en analyseert", async () => {
    const campaign = await makeCampaign();
    const run = await runSearchNow(campaign.id);
    expect(run.status).toBe("done");
    expect(run.found).toBeGreaterThan(0);
    expect(run.newVideos).toBeGreaterThan(0);
    expect(run.analyzed).toBe(run.newVideos);

    const matches = await prisma.campaignVideo.findMany({ where: { campaignId: campaign.id }, include: { video: true } });
    expect(matches).toHaveLength(run.newVideos);
    for (const m of matches) {
      expect(m.matchScore).not.toBeNull();
      expect(m.clipScore).not.toBeNull();
      expect(m.analysisSource).toBe("heuristic");
      const min = m.video.durationSec! / 60;
      expect(min).toBeGreaterThanOrEqual(5);
      expect(min).toBeLessThanOrEqual(120);
    }
  });

  it("dedupliceert over rondes heen", async () => {
    const campaign = await makeCampaign();
    const r1 = await runSearchNow(campaign.id);
    const r2 = await runSearchNow(campaign.id);
    const total = await prisma.campaignVideo.count({ where: { campaignId: campaign.id } });
    expect(total).toBe(r1.newVideos + r2.newVideos);
    expect(r2.skipped).toBeGreaterThan(0);
    // Geen dubbele video-rijen
    const videos = await prisma.video.findMany();
    expect(new Set(videos.map((v) => v.url)).size).toBe(videos.length);
  });

  it("deelt video's tussen campagnes maar beoordeelt per campagne", async () => {
    const a = await makeCampaign();
    const b = await makeCampaign({ name: "Andere", excludedTopics: "" });
    const raw = mockPoolVideo(toSearchCampaign(a));
    const v1 = await upsertVideo(raw);
    const v2 = await upsertVideo({ ...raw, viewCount: 999 });
    expect(v2.id).toBe(v1.id);
    expect(v2.viewCount).toBe(999);
    const m1 = await prisma.campaignVideo.create({ data: { campaignId: a.id, videoId: v1.id } });
    const m2 = await prisma.campaignVideo.create({ data: { campaignId: b.id, videoId: v1.id } });
    await analyzeMatch(m1.id);
    await analyzeMatch(m2.id);
    expect(await prisma.video.count()).toBe(1);
    expect(await prisma.campaignVideo.count()).toBe(2);
  });

  it("feedback telt mee bij herbeoordeling", async () => {
    const campaign = await makeCampaign();
    await runSearchNow(campaign.id);
    const m = await prisma.campaignVideo.findFirstOrThrow({ where: { campaignId: campaign.id }, orderBy: { matchScore: "desc" }, include: { video: true } });
    const before = m.matchScore!;
    const term = m.video.tags.split(",")[0].trim();
    await prisma.feedback.create({ data: { campaignId: campaign.id, kind: "avoid", text: term } });
    const after = await analyzeMatch(m.id);
    expect(after.matchScore!).toBeLessThan(before);
    expect(after.reasoning).toMatch(/vermijden/);
  });

  it("geeft een duidelijke fout bij een onbekende campagne", async () => {
    await expect(runSearchNow("bestaat-niet")).rejects.toThrow();
  });
});

describe("planner", () => {
  it("selecteert actieve campagnes waarvan het interval verstreken is", async () => {
    const due = await makeCampaign({ searchIntervalHours: 6, lastSearchedAt: new Date(Date.now() - 7 * 3600_000) });
    await makeCampaign({ searchIntervalHours: 6, lastSearchedAt: new Date(Date.now() - 3600_000) });
    await makeCampaign({ searchIntervalHours: 0 });
    await makeCampaign({ searchIntervalHours: 1, active: false });
    const never = await makeCampaign({ searchIntervalHours: 24 });
    const ids = (await dueCampaigns()).map((c) => c.id).sort();
    expect(ids).toEqual([due.id, never.id].sort());
  });
});

function mockPoolVideo(c: ReturnType<typeof toSearchCampaign>) {
  return mockPool(c)[0];
}
