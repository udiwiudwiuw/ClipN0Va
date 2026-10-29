import { z } from "zod";
import type { TranscriptSegment } from "../search/types";
import { clamp, formatTimestamp, parseTimestamp } from "../utils";

/** Wat de analyse over de campagne weet (incl. feedback). */
export interface CampaignContext {
  name: string;
  brand: string;
  description: string;
  audience: string;
  keywords: string[];
  people: string[];
  topics: string[];
  excludedTopics: string[];
  language: string;
  minMinutes: number | null;
  maxMinutes: number | null;
  rules: string;
  usageRights: string;
  feedback: {
    prefer: string[];
    avoid: string[];
    notes: string[];
    approved: { title: string; channel: string; reason?: string }[];
    rejected: { title: string; channel: string; reason?: string }[];
  };
}

/** Feitelijke metadata die de analyse krijgt. */
export interface VideoContext {
  title: string;
  description: string;
  channelTitle: string;
  durationSec: number | null;
  language: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  publishedAt: Date | null;
  tags: string[];
  transcript: TranscriptSegment[] | null;
}

export const ClipTimestamp = z.object({
  start: z.string(),
  end: z.string(),
  reason: z.string(),
  hook: z.string().default(""),
});

export const AnalysisSchema = z.object({
  matchScore: z.number(),
  clipScore: z.number(),
  verdict: z.enum(["geschikt", "twijfel", "ongeschikt"]),
  reasoning: z.string(),
  ruleViolations: z.array(z.string()).default([]),
  detectedTopics: z.array(z.string()).default([]),
  timestamps: z.array(ClipTimestamp).default([]),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** JSON Schema voor structured outputs (OpenAI) en tool input (Anthropic). */
export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matchScore", "clipScore", "verdict", "reasoning", "ruleViolations", "detectedTopics", "timestamps"],
  properties: {
    matchScore: { type: "integer", description: "0-100: hoe goed past de video bij de campagne en haar regels" },
    clipScore: { type: "integer", description: "0-100: geschiktheid voor korte clips op TikTok/Shorts/Reels" },
    verdict: { type: "string", enum: ["geschikt", "twijfel", "ongeschikt"] },
    reasoning: { type: "string", description: "2-4 zinnen onderbouwing in het Nederlands" },
    ruleViolations: { type: "array", items: { type: "string" }, description: "Overtreden campagneregels of uitgesloten onderwerpen" },
    detectedTopics: { type: "array", items: { type: "string" } },
    timestamps: {
      type: "array",
      description: "Max. 5 aanbevolen fragmenten (15-90 s), alleen gebaseerd op transcript of hoofdstukken",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "reason", "hook"],
        properties: {
          start: { type: "string", description: "mm:ss of h:mm:ss" },
          end: { type: "string", description: "mm:ss of h:mm:ss" },
          reason: { type: "string" },
          hook: { type: "string", description: "Openingszin/hook van het fragment" },
        },
      },
    },
  },
} as const;

/** Maakt de uitkomst van elke provider veilig: scores 0-100, geldige tijdstempels. */
export function sanitizeAnalysis(raw: unknown, durationSec: number | null): Analysis {
  const a = AnalysisSchema.parse(raw);
  const timestamps = a.timestamps
    .map((t) => ({ ...t, s: parseTimestamp(t.start), e: parseTimestamp(t.end) }))
    .filter((t) => t.s != null && t.e != null && t.e > t.s && t.e - t.s <= 180 && (durationSec == null || t.e <= durationSec + 1))
    .sort((x, y) => x.s! - y.s!)
    .slice(0, 5)
    .map((t) => ({ start: formatTimestamp(t.s!), end: formatTimestamp(t.e!), reason: t.reason.trim(), hook: t.hook.trim() }));
  return {
    ...a,
    matchScore: clamp(a.matchScore),
    clipScore: clamp(a.clipScore),
    reasoning: a.reasoning.trim(),
    ruleViolations: a.ruleViolations.map((v) => v.trim()).filter(Boolean).slice(0, 10),
    detectedTopics: a.detectedTopics.map((v) => v.trim()).filter(Boolean).slice(0, 10),
    timestamps,
  };
}
