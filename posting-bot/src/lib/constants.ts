export const PLATFORMS = ["tiktok", "youtube", "instagram"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
};

export const POST_STATUSES = [
  "draft",
  "queued",
  "processing",
  "success",
  "failed",
  "needs_reauth",
  "cancelled",
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const ACCOUNT_STATUSES = ["active", "needs_reauth", "error", "paused"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Platformlimieten voor tekst. */
export const CAPTION_LIMITS: Record<Platform, { caption: number; title: number; maxHashtags: number }> = {
  tiktok: { caption: 2200, title: 150, maxHashtags: 6 },
  youtube: { caption: 5000, title: 100, maxHashtags: 3 },
  instagram: { caption: 2200, title: 0, maxHashtags: 10 },
};

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}
