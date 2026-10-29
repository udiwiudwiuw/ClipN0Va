export interface TranscriptSegment {
  start: number;
  dur: number;
  text: string;
}

/** Genormaliseerde video zoals een zoekbron hem aanlevert (feitelijke metadata). */
export interface RawVideo {
  platform: "youtube";
  externalId: string;
  url: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string;
  publishedAt: Date | null;
  durationSec: number | null;
  language: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  tags: string[];
  transcript: TranscriptSegment[] | null;
  source: "youtube_api" | "rss" | "mock";
}

/** Wat een zoekbron nodig heeft van de campagne. */
export interface SearchCampaign {
  id: string;
  name: string;
  brand: string;
  sources: string[];
  keywords: string[];
  people: string[];
  topics: string[];
  excludedTopics: string[];
  language: string;
  minMinutes: number | null;
  maxMinutes: number | null;
}

export class SearchError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
    this.name = "SearchError";
  }
}

export type SourceRef =
  | { type: "channel"; channelId: string; raw: string }
  | { type: "handle"; handle: string; raw: string }
  | { type: "video"; videoId: string; raw: string }
  | { type: "unknown"; raw: string };

/** Herkent YouTube-kanaal-, handle- en video-URL's. */
export function parseSource(raw: string): SourceRef {
  const s = raw.trim();
  let m = s.match(/(?:youtube\.com\/channel\/|^)(UC[\w-]{22})(?:[/?#]|$)/);
  if (m) return { type: "channel", channelId: m[1], raw: s };
  m = s.match(/(?:youtube\.com\/|^)@([\w.-]{3,30})(?:[/?#]|$)/);
  if (m) return { type: "handle", handle: m[1], raw: s };
  m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/))([\w-]{11})/);
  if (m) return { type: "video", videoId: m[1], raw: s };
  return { type: "unknown", raw: s };
}
