import { parseSource, SearchError, type RawVideo, type SearchCampaign } from "./types";

/**
 * Openbare YouTube-kanaalfeeds (geen API-sleutel nodig). Levert de laatste
 * ~15 uploads per kanaal, zonder duur en zonder transcript.
 */
const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : "";
};
const attr = (xml: string, name: string, a: string) => xml.match(new RegExp(`<${name}[^>]*\\s${a}="([^"]*)"`))?.[1] ?? "";

export function parseFeed(xml: string): RawVideo[] {
  const entries = xml.split("<entry>").slice(1);
  return entries.map((e) => {
    const id = tag(e, "yt:videoId");
    const views = attr(e, "media:statistics", "views");
    const likes = attr(e, "media:starRating", "count");
    return {
      platform: "youtube" as const,
      externalId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: tag(e, "title"),
      description: tag(e, "media:description"),
      channelId: tag(e, "yt:channelId"),
      channelTitle: tag(e.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? "", "name"),
      thumbnailUrl: attr(e, "media:thumbnail", "url"),
      publishedAt: tag(e, "published") ? new Date(tag(e, "published")) : null,
      durationSec: null,
      language: null,
      viewCount: views ? Number(views) : null,
      likeCount: likes ? Number(likes) : null,
      commentCount: null,
      tags: [],
      transcript: null,
      source: "rss" as const,
    };
  }).filter((v) => v.externalId);
}

/** Zoekt het kanaal-ID op de openbare kanaalpagina (voor @handles). */
async function resolveHandle(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}`, { signal: AbortSignal.timeout(15_000), headers: { "Accept-Language": "en" } });
    const html = await res.text();
    return html.match(/"(?:externalId|channelId)":"(UC[\w-]{22})"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function searchRss(c: SearchCampaign, log: (m: string) => void): Promise<RawVideo[]> {
  const out: RawVideo[] = [];
  const channels: string[] = [];
  for (const raw of c.sources) {
    const ref = parseSource(raw);
    if (ref.type === "channel") channels.push(ref.channelId);
    else if (ref.type === "handle") {
      const id = await resolveHandle(ref.handle);
      if (id) channels.push(id);
      else log(`RSS: kanaal-ID voor @${ref.handle} niet gevonden`);
    }
  }
  for (const id of channels) {
    try {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new SearchError(`HTTP ${res.status}`);
      const items = parseFeed(await res.text());
      log(`RSS ${id}: ${items.length} video's`);
      out.push(...items);
    } catch (err) {
      log(`RSS ${id} mislukt: ${(err as Error).message}`);
    }
  }
  return out;
}

export function hasChannelSources(c: SearchCampaign) {
  return c.sources.some((s) => ["channel", "handle"].includes(parseSource(s).type));
}
