export type Campaign = {
  id: string;
  name: string;
  brand: string;
  description: string;
  audience: string;
  sources: string;
  keywords: string;
  people: string;
  topics: string;
  language: string;
  minMinutes: number | null;
  maxMinutes: number | null;
  rules: string;
  usageRights: string;
  excludedTopics: string;
  active: boolean;
  searchIntervalHours: number;
  lastSearchedAt: string | null;
  createdAt: string;
  counts?: Record<string, number>;
};

export type Clip = { start: string; end: string; reason: string; hook: string };

export type Match = {
  id: string;
  campaignId: string;
  status: "new" | "approved" | "rejected";
  matchScore: number | null;
  clipScore: number | null;
  verdict: string | null;
  reasoning: string | null;
  timestamps: Clip[];
  violations: string[];
  detectedTopics: string[];
  analysisSource: string | null;
  aiModel: string | null;
  analyzedAt: string | null;
  analysisError: string | null;
  notes: string;
  createdAt: string;
  video: {
    id: string;
    platform: string;
    externalId: string;
    url: string;
    title: string;
    description: string;
    channelTitle: string;
    thumbnailUrl: string;
    publishedAt: string | null;
    durationSec: number | null;
    language: string | null;
    viewCount: number | null;
    likeCount: number | null;
    commentCount: number | null;
    tags: string;
    source: string;
    hasTranscript: boolean;
  };
};

export type Run = {
  id: string;
  status: string;
  trigger: string;
  sources: string[];
  found: number;
  newVideos: number;
  skipped: number;
  analyzed: number;
  error: string | null;
  log: string[];
  createdAt: string;
  finishedAt: string | null;
};

export type FeedbackItem = {
  id: string;
  kind: "approve" | "reject" | "prefer" | "avoid" | "note";
  text: string;
  active: boolean;
  createdAt: string;
  match: { id: string; video: { title: string; channelTitle: string } } | null;
};
