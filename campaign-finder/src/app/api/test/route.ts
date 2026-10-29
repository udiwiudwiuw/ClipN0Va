import { NextResponse } from "next/server";
import { runAnalysis } from "@/lib/ai/analyze";
import type { CampaignContext } from "@/lib/ai/types";
import { handler } from "@/lib/api";
import { status } from "@/lib/config";
import { collect, withinDuration } from "@/lib/search/engine";
import type { SearchCampaign } from "@/lib/search/types";
import { splitList } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Testroute voor zoekmachine + AI-analyse, zonder iets op te slaan.
 * Voorbeeld: /api/test?keywords=podcast,ondernemen&people=Sam&lang=nl&min=5&max=90&exclude=gokken&limit=3
 */
export const GET = handler(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const search: SearchCampaign = {
    id: "test",
    name: "Testcampagne",
    brand: q.get("brand") ?? "Test",
    sources: splitList(q.get("sources")),
    keywords: splitList(q.get("keywords") ?? "podcast, ondernemen"),
    people: splitList(q.get("people")),
    topics: splitList(q.get("topics")),
    excludedTopics: splitList(q.get("exclude")),
    language: q.get("lang") ?? "nl",
    minMinutes: q.get("min") ? Number(q.get("min")) : null,
    maxMinutes: q.get("max") ? Number(q.get("max")) : null,
  };
  const ctx: CampaignContext = {
    ...search,
    description: "",
    audience: "",
    rules: q.get("rules") ?? "",
    usageRights: "",
    feedback: { prefer: splitList(q.get("prefer")), avoid: splitList(q.get("avoid")), notes: [], approved: [], rejected: [] },
  };
  const log: string[] = [];
  const started = Date.now();
  const { sources, videos, errors } = await collect(search, 0, (m) => log.push(m));
  const fitting = videos.filter((v) => withinDuration(v, search));
  const limit = Math.min(10, Number(q.get("limit")) || 3);
  const analyses = [];
  for (const v of fitting.slice(0, limit)) {
    const r = await runAnalysis(ctx, { ...v, tags: v.tags });
    analyses.push({
      feitelijk: { titel: v.title, kanaal: v.channelTitle, url: v.url, duurSec: v.durationSec, taal: v.language, bron: v.source, transcript: Boolean(v.transcript) },
      aiSchatting: { ...r.analysis, provider: r.provider, model: r.model, fallbackError: r.fallbackError },
    });
  }
  return NextResponse.json({ config: status(), bronnen: sources, gevonden: videos.length, binnenLengte: fitting.length, fouten: errors, log, analyses, durationMs: Date.now() - started });
});
