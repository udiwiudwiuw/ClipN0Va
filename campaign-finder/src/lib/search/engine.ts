import type { Campaign } from "@prisma/client";
import { analyzeMatch, loadCampaignContext } from "../ai/analyze";
import { analysisConcurrency, searchMode, youtubeKey } from "../config";
import { prisma } from "../db";
import { mapLimit, parseJson, splitList } from "../utils";
import { searchMock } from "./mock";
import { hasChannelSources, searchRss } from "./rss";
import { SearchError, type RawVideo, type SearchCampaign } from "./types";
import { searchYouTube } from "./youtube";

export function toSearchCampaign(c: Campaign): SearchCampaign {
  return {
    id: c.id,
    name: c.name,
    brand: c.brand,
    sources: parseJson<string[]>(c.sources, []),
    keywords: splitList(c.keywords),
    people: splitList(c.people),
    topics: splitList(c.topics),
    excludedTopics: splitList(c.excludedTopics),
    language: c.language,
    minMinutes: c.minMinutes,
    maxMinutes: c.maxMinutes,
  };
}

/** Kiest de zoekbronnen op basis van SEARCH_MODE en beschikbare sleutels. */
export function plannedSources(c: SearchCampaign): ("youtube_api" | "rss" | "mock")[] {
  const mode = searchMode();
  if (mode === "mock") return ["mock"];
  if (mode === "youtube") return ["youtube_api"];
  if (mode === "rss") return ["rss"];
  if (youtubeKey()) return ["youtube_api"];
  return hasChannelSources(c) ? ["rss", "mock"] : ["mock"];
}

/** Collecteert video's van alle bronnen. Een falende bron stopt de rest niet. */
export async function collect(c: SearchCampaign, runIndex: number, log: (m: string) => void) {
  const sources = plannedSources(c);
  const videos: RawVideo[] = [];
  const errors: string[] = [];
  for (const s of sources) {
    try {
      if (s === "youtube_api") videos.push(...(await searchYouTube(c, youtubeKey(), log)));
      else if (s === "rss") videos.push(...(await searchRss(c, log)));
      else {
        const items = searchMock(c, runIndex);
        log(`Demo-data: ${items.length} video's`);
        videos.push(...items);
      }
    } catch (err) {
      const msg = err instanceof SearchError ? err.message : `Onverwachte fout: ${(err as Error).message}`;
      errors.push(`${s}: ${msg}`);
      log(`Bron ${s} mislukt: ${msg}`);
    }
  }
  return { sources, videos, errors };
}

/** Filtert op videolengte (alleen als de duur bekend is). */
export function withinDuration(v: RawVideo, c: SearchCampaign): boolean {
  if (v.durationSec == null) return true;
  const min = v.durationSec / 60;
  if (c.minMinutes != null && min < c.minMinutes) return false;
  if (c.maxMinutes != null && min > c.maxMinutes) return false;
  return true;
}

/** Slaat een video op (dedup op platform+id en URL) en geeft het DB-id terug. */
export async function upsertVideo(v: RawVideo) {
  const existing = await prisma.video.findFirst({ where: { OR: [{ platform: v.platform, externalId: v.externalId }, { url: v.url }] } });
  const stats = { viewCount: v.viewCount, likeCount: v.likeCount, commentCount: v.commentCount };
  if (existing) {
    // Alleen tellers en ontbrekende velden bijwerken; transcript nooit overschrijven met niets.
    return prisma.video.update({
      where: { id: existing.id },
      data: {
        ...stats,
        durationSec: existing.durationSec ?? v.durationSec,
        language: existing.language ?? v.language,
        transcript: existing.transcript ?? (v.transcript ? JSON.stringify(v.transcript) : null),
      },
    });
  }
  return prisma.video.create({
    data: {
      platform: v.platform,
      externalId: v.externalId,
      url: v.url,
      title: v.title,
      description: v.description,
      channelId: v.channelId,
      channelTitle: v.channelTitle,
      thumbnailUrl: v.thumbnailUrl,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      language: v.language,
      ...stats,
      tags: v.tags.join(", "),
      transcript: v.transcript ? JSON.stringify(v.transcript) : null,
      source: v.source,
    },
  });
}

/** Voert een zoekronde uit: zoeken → filteren → dedupliceren → opslaan → analyseren. */
export async function executeRun(runId: string) {
  const run = await prisma.searchRun.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() }, include: { campaign: true } });
  const lines: string[] = [];
  const log = (m: string) => {
    lines.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
  };
  const flush = (data: Record<string, unknown> = {}) => prisma.searchRun.update({ where: { id: runId }, data: { log: JSON.stringify(lines), ...data } });

  try {
    const c = toSearchCampaign(run.campaign);
    const runIndex = await prisma.searchRun.count({ where: { campaignId: c.id, status: "done" } });
    const { sources, videos, errors } = await collect(c, runIndex, log);
    if (!videos.length && errors.length) throw new Error(errors.join("; "));

    // Dedup binnen deze ronde
    const unique = [...new Map(videos.map((v) => [`${v.platform}:${v.externalId}`, v])).values()];
    const fitting = unique.filter((v) => withinDuration(v, c));
    log(`${videos.length} gevonden, ${unique.length} uniek, ${unique.length - fitting.length} buiten lengte-eisen`);

    const newMatchIds: string[] = [];
    let skipped = unique.length - fitting.length;
    for (const v of fitting) {
      const video = await upsertVideo(v);
      const exists = await prisma.campaignVideo.findUnique({ where: { campaignId_videoId: { campaignId: c.id, videoId: video.id } } });
      if (exists) {
        skipped++;
        continue;
      }
      const m = await prisma.campaignVideo.create({ data: { campaignId: c.id, videoId: video.id, foundByRunId: runId } });
      newMatchIds.push(m.id);
    }
    log(`${newMatchIds.length} nieuw voor deze campagne, ${skipped} overgeslagen (dubbel of te kort/lang)`);
    await flush({ sources: JSON.stringify(sources), found: videos.length, newVideos: newMatchIds.length, skipped });

    const ctx = await loadCampaignContext(c.id);
    let analyzed = 0;
    await mapLimit(newMatchIds, analysisConcurrency(), async (id) => {
      try {
        await analyzeMatch(id, ctx);
      } catch (err) {
        await prisma.campaignVideo.update({ where: { id }, data: { analysisError: (err as Error).message } });
      }
      analyzed++;
      if (analyzed % 5 === 0) await flush({ analyzed });
    });
    log(`${analyzed} video's geanalyseerd`);
    if (errors.length) log(`Waarschuwing: ${errors.join("; ")}`);
    await prisma.campaign.update({ where: { id: c.id }, data: { lastSearchedAt: new Date() } });
    await flush({ status: "done", analyzed, finishedAt: new Date(), error: errors.length ? errors.join("; ") : null });
  } catch (err) {
    log(`Mislukt: ${(err as Error).message}`);
    await flush({ status: "failed", error: (err as Error).message, finishedAt: new Date() });
  }
  return prisma.searchRun.findUniqueOrThrow({ where: { id: runId } });
}
