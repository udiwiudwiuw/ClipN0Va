import { z } from "zod";

const optNum = z.preprocess((v) => (v === "" || v === null || v === undefined ? null : Number(v)), z.number().min(0).max(1440).nullable());

export const CampaignInput = z
  .object({
    name: z.string().trim().min(1, "Naam is verplicht").max(120),
    brand: z.string().trim().max(120).default(""),
    description: z.string().max(4000).default(""),
    audience: z.string().max(2000).default(""),
    sources: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
    keywords: z.string().max(2000).default(""),
    people: z.string().max(1000).default(""),
    topics: z.string().max(1000).default(""),
    language: z.string().trim().min(2).max(10).default("nl"),
    minMinutes: optNum.default(null),
    maxMinutes: optNum.default(null),
    rules: z.string().max(4000).default(""),
    usageRights: z.string().max(4000).default(""),
    excludedTopics: z.string().max(2000).default(""),
    active: z.boolean().default(true),
    searchIntervalHours: z.coerce.number().int().min(0).max(24 * 30).default(0),
  })
  .refine((c) => c.minMinutes == null || c.maxMinutes == null || c.minMinutes <= c.maxMinutes, {
    message: "Minimale lengte mag niet groter zijn dan maximale lengte",
    path: ["maxMinutes"],
  });

export type CampaignInputT = z.infer<typeof CampaignInput>;

export function toDb(input: Partial<CampaignInputT>) {
  const { sources, ...rest } = input;
  return { ...rest, ...(sources !== undefined ? { sources: JSON.stringify(sources) } : {}) };
}
