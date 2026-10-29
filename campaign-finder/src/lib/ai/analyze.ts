import type { Campaign, Feedback, Video } from "@prisma/client";
import { aiModel, aiProvider, type AiProvider } from "../config";
import { prisma } from "../db";
import type { TranscriptSegment } from "../search/types";
import { parseJson, splitList } from "../utils";
import { analyzeHeuristic } from "./heuristic";
import { buildUserPrompt } from "./prompt";
import { callAnthropic, callOpenAI } from "./providers";
import { sanitizeAnalysis, type Analysis, type CampaignContext, type VideoContext } from "./types";

type FeedbackWithMatch = Feedback & { match: { video: { title: string; channelTitle: string } } | null };

export function campaignContext(c: Campaign, feedback: FeedbackWithMatch[]): CampaignContext {
  const active = feedback.filter((f) => f.active);
  const example = (f: FeedbackWithMatch) => ({ title: f.match?.video.title ?? "", channel: f.match?.video.channelTitle ?? "", reason: f.text || undefined });
  return {
    name: c.name,
    brand: c.brand,
    description: c.description,
    audience: c.audience,
    keywords: splitList(c.keywords),
    people: splitList(c.people),
    topics: splitList(c.topics),
    excludedTopics: splitList(c.excludedTopics),
    language: c.language,
    minMinutes: c.minMinutes,
    maxMinutes: c.maxMinutes,
    rules: c.rules,
    usageRights: c.usageRights,
    feedback: {
      prefer: active.filter((f) => f.kind === "prefer").flatMap((f) => splitList(f.text)),
      avoid: active.filter((f) => f.kind === "avoid").flatMap((f) => splitList(f.text)),
      notes: active.filter((f) => f.kind === "note").map((f) => f.text),
      approved: active.filter((f) => f.kind === "approve" && f.match).map(example),
      rejected: active.filter((f) => f.kind === "reject" && f.match).map(example),
    },
  };
}

export function videoContext(v: Video): VideoContext {
  return {
    title: v.title,
    description: v.description,
    channelTitle: v.channelTitle,
    durationSec: v.durationSec,
    language: v.language,
    viewCount: v.viewCount,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
    publishedAt: v.publishedAt,
    tags: splitList(v.tags),
    transcript: parseJson<TranscriptSegment[] | null>(v.transcript, null),
  };
}

export interface AnalysisResult {
  analysis: Analysis;
  provider: AiProvider;
  model: string;
  fallbackError?: string;
}

/** Analyseert met de ingestelde provider; bij een fout valt hij terug op de heuristiek. */
export async function runAnalysis(c: CampaignContext, v: VideoContext, provider = aiProvider()): Promise<AnalysisResult> {
  if (provider === "heuristic") return { analysis: sanitizeAnalysis(analyzeHeuristic(c, v), v.durationSec), provider, model: aiModel(provider) };
  const model = aiModel(provider);
  try {
    const raw = provider === "openai" ? await callOpenAI(buildUserPrompt(c, v), model) : await callAnthropic(buildUserPrompt(c, v), model);
    return { analysis: sanitizeAnalysis(raw, v.durationSec), provider, model };
  } catch (err) {
    const msg = `${provider} mislukt: ${(err as Error).message}`;
    console.error("[finder]", msg);
    return { analysis: sanitizeAnalysis(analyzeHeuristic(c, v), v.durationSec), provider: "heuristic", model: aiModel("heuristic"), fallbackError: msg };
  }
}

export async function loadCampaignContext(campaignId: string) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const feedback = await prisma.feedback.findMany({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    take: 60,
    include: { match: { select: { video: { select: { title: true, channelTitle: true } } } } },
  });
  return campaignContext(campaign, feedback);
}

/** Analyseert één campagne-video en slaat het resultaat op. */
export async function analyzeMatch(matchId: string, ctx?: CampaignContext) {
  const match = await prisma.campaignVideo.findUniqueOrThrow({ where: { id: matchId }, include: { video: true } });
  const c = ctx ?? (await loadCampaignContext(match.campaignId));
  const r = await runAnalysis(c, videoContext(match.video));
  return prisma.campaignVideo.update({
    where: { id: matchId },
    data: {
      matchScore: r.analysis.matchScore,
      clipScore: r.analysis.clipScore,
      verdict: r.analysis.verdict,
      reasoning: r.analysis.reasoning,
      timestamps: JSON.stringify(r.analysis.timestamps),
      violations: JSON.stringify(r.analysis.ruleViolations),
      detectedTopics: JSON.stringify(r.analysis.detectedTopics),
      analysisSource: r.provider,
      aiModel: r.model,
      analyzedAt: new Date(),
      analysisError: r.fallbackError ?? null,
    },
  });
}
