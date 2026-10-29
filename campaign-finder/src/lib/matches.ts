import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { parseJson } from "./utils";

export interface MatchFilters {
  status?: string | null;
  platform?: string | null;
  language?: string | null;
  minScore?: number | null;
  minClipScore?: number | null;
  source?: string | null;
  q?: string | null;
  sort?: string | null;
}

/** Zoekt de video's van een campagne met filters en sortering. */
export async function findMatches(campaignId: string, f: MatchFilters, take = 500) {
  const where: Prisma.CampaignVideoWhereInput = { campaignId };
  if (f.status) where.status = { in: f.status.split(",") };
  if (f.minScore) where.matchScore = { gte: f.minScore };
  if (f.minClipScore) where.clipScore = { gte: f.minClipScore };
  const video: Prisma.VideoWhereInput = {};
  if (f.platform) video.platform = f.platform;
  if (f.language) video.language = f.language;
  if (f.source) video.source = f.source;
  if (f.q) video.OR = [{ title: { contains: f.q } }, { channelTitle: { contains: f.q } }, { description: { contains: f.q } }];
  if (Object.keys(video).length) where.video = video;

  const orderBy: Prisma.CampaignVideoOrderByWithRelationInput[] =
    f.sort === "clip"
      ? [{ clipScore: { sort: "desc", nulls: "last" } }, { matchScore: { sort: "desc", nulls: "last" } }]
      : f.sort === "date"
        ? [{ video: { publishedAt: { sort: "desc", nulls: "last" } } }]
        : f.sort === "found"
          ? [{ createdAt: "desc" }]
          : [{ matchScore: { sort: "desc", nulls: "last" } }, { clipScore: { sort: "desc", nulls: "last" } }];

  const rows = await prisma.campaignVideo.findMany({ where, orderBy, take, include: { video: true } });
  return rows.map(serializeMatch);
}

export function serializeMatch<T extends { timestamps: string; violations: string; detectedTopics: string; video: { transcript: string | null } }>(m: T) {
  const { transcript, ...video } = m.video;
  return {
    ...m,
    timestamps: parseJson<{ start: string; end: string; reason: string; hook: string }[]>(m.timestamps, []),
    violations: parseJson<string[]>(m.violations, []),
    detectedTopics: parseJson<string[]>(m.detectedTopics, []),
    video: { ...video, hasTranscript: Boolean(transcript) },
  };
}
