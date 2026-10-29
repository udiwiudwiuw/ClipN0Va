import { parseIsoDuration } from "../utils";
import { parseSource, SearchError, type RawVideo, type SearchCampaign } from "./types";

// YouTube Data API v3 — https://developers.google.com/youtube/v3/docs
const API = "https://www.googleapis.com/youtube/v3";

async function call(path: string, params: Record<string, string | number | undefined>, key: string) {
  const qs = new URLSearchParams({ key });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${API}/${path}?${qs}`, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new SearchError(`YouTube niet bereikbaar: ${(err as Error).message}`, true);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? "";
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    if (reason === "quotaExceeded") throw new SearchError("YouTube API-quotum voor vandaag is op", false);
    if (res.status === 400 || res.status === 403) throw new SearchError(`YouTube API: ${msg}`, false);
    throw new SearchError(`YouTube API: ${msg}`, res.status >= 500);
  }
  return body;
}

/** Kies de videoDuration-filter van search.list op basis van min/max minuten. */
export function durationFilter(min: number | null, max: number | null): "short" | "medium" | "long" | undefined {
  if (min != null && min >= 20) return "long";
  if (max != null && max <= 4) return "short";
  if (min != null && min >= 4 && max != null && max <= 20) return "medium";
  return undefined;
}

/** Bouwt de zoekopdrachten: zoekwoorden + personen, max. 4 queries (quota!). */
export function buildQueries(c: SearchCampaign): string[] {
  const kw = c.keywords.slice(0, 6);
  const people = c.people.slice(0, 3);
  const queries: string[] = [];
  if (people.length && kw.length) for (const p of people) queries.push(`"${p}" ${kw.slice(0, 3).join(" | ")}`);
  else if (people.length) queries.push(people.map((p) => `"${p}"`).join(" | "));
  if (kw.length) queries.push(kw.join(" | "));
  if (!queries.length && c.brand) queries.push(c.brand);
  return queries.slice(0, 4);
}

export async function searchYouTube(c: SearchCampaign, key: string, log: (m: string) => void): Promise<RawVideo[]> {
  const max = Math.min(50, Math.max(1, Number(process.env.YOUTUBE_MAX_RESULTS) || 15));
  const ids = new Set<string>();
  const videoDuration = durationFilter(c.minMinutes, c.maxMinutes);
  const base = { part: "snippet", type: "video", maxResults: max, relevanceLanguage: c.language || undefined, videoDuration, order: "relevance" };

  // 1. Toegestane bronnen: kanalen (zoeken binnen kanaal) en losse video's.
  const channelIds: string[] = [];
  for (const raw of c.sources) {
    const ref = parseSource(raw);
    if (ref.type === "video") ids.add(ref.videoId);
    else if (ref.type === "channel") channelIds.push(ref.channelId);
    else if (ref.type === "handle") {
      const body = await call("channels", { part: "id", forHandle: ref.handle }, key);
      const id = body.items?.[0]?.id;
      if (id) channelIds.push(id);
      else log(`Kanaal @${ref.handle} niet gevonden`);
    } else log(`Bron niet herkend: ${raw}`);
  }
  const q = [...c.keywords, ...c.people].slice(0, 6).join(" | ");
  for (const channelId of channelIds) {
    const body = await call("search", { ...base, channelId, q: q || undefined, order: q ? "relevance" : "date" }, key);
    for (const it of body.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
    log(`Kanaal ${channelId}: ${body.items?.length ?? 0} resultaten`);
  }

  // 2. Vrij zoeken op zoekwoorden/personen (alleen als er geen kanaalbronnen zijn
  //    of als er ook zoekwoorden zijn).
  if (!channelIds.length || c.keywords.length) {
    for (const query of buildQueries(c)) {
      const body = await call("search", { ...base, q: query }, key);
      for (const it of body.items ?? []) if (it.id?.videoId) ids.add(it.id.videoId);
      log(`Zoekopdracht "${query}": ${body.items?.length ?? 0} resultaten`);
    }
  }
  return fetchVideoDetails([...ids], key);
}

export async function fetchVideoDetails(ids: string[], key: string): Promise<RawVideo[]> {
  const out: RawVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const body = await call("videos", { part: "snippet,contentDetails,statistics", id: ids.slice(i, i + 50).join(",") }, key);
    for (const v of body.items ?? []) {
      const s = v.snippet ?? {};
      const num = (x: unknown) => (x == null ? null : Number(x));
      out.push({
        platform: "youtube",
        externalId: v.id,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        title: s.title ?? "",
        description: s.description ?? "",
        channelId: s.channelId ?? "",
        channelTitle: s.channelTitle ?? "",
        thumbnailUrl: s.thumbnails?.high?.url ?? s.thumbnails?.medium?.url ?? s.thumbnails?.default?.url ?? "",
        publishedAt: s.publishedAt ? new Date(s.publishedAt) : null,
        durationSec: parseIsoDuration(v.contentDetails?.duration),
        language: (s.defaultAudioLanguage ?? s.defaultLanguage ?? null)?.slice(0, 2) ?? null,
        viewCount: num(v.statistics?.viewCount),
        likeCount: num(v.statistics?.likeCount),
        commentCount: num(v.statistics?.commentCount),
        tags: s.tags ?? [],
        // Captions vereisen OAuth van de video-eigenaar; zonder transcript werkt de
        // analyse op titel, beschrijving, tags en hoofdstukken.
        transcript: null,
        source: "youtube_api",
      });
    }
  }
  return out;
}
