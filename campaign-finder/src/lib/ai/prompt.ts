import { formatTimestamp } from "../utils";
import type { CampaignContext, VideoContext } from "./types";

const MAX_TRANSCRIPT_CHARS = 14_000;

export const SYSTEM_PROMPT = `Je bent een ervaren clip-researcher voor korte video (TikTok, YouTube Shorts, Instagram Reels).
Je beoordeelt of een lange bronvideo geschikt is voor een clipcampagne.

Regels:
- Beoordeel ALLEEN op basis van de aangeleverde feiten (metadata, transcript, hoofdstukken). Verzin geen inhoud.
- matchScore (0-100): inhoudelijke match met campagne, zoekwoorden, personen, taal, lengte en regels.
  Een uitgesloten onderwerp of overtreden regel → noem het in ruleViolations en geef maximaal 35.
- clipScore (0-100): potentie voor virale korte clips: sterke hooks, emotie, humor, controverse,
  duidelijke uitspraken, afgeronde momenten van 15-90 seconden.
- timestamps: alleen momenten die echt in het transcript of de hoofdstukken staan, 15-90 s lang, in mm:ss.
  Geen transcript en geen hoofdstukken → lege lijst.
- Weeg de feedback van de campagne zwaar mee: voorkeuren, vermijden, eerder goedgekeurde en afgewezen video's.
- Schrijf reasoning in het Nederlands, 2-4 zinnen, concreet (noem wat je zag).`;

export function formatTranscript(v: VideoContext): string {
  if (!v.transcript?.length) return "(geen transcript beschikbaar)";
  let out = "";
  for (const seg of v.transcript) {
    const line = `[${formatTimestamp(seg.start)}] ${seg.text}\n`;
    if (out.length + line.length > MAX_TRANSCRIPT_CHARS) {
      out += `[… transcript afgekapt na ${formatTimestamp(seg.start)}]\n`;
      break;
    }
    out += line;
  }
  return out;
}

export function buildUserPrompt(c: CampaignContext, v: VideoContext): string {
  const campaign = {
    naam: c.name,
    merk_creator: c.brand,
    beschrijving: c.description,
    doelgroep: c.audience,
    zoekwoorden: c.keywords,
    personen: c.people,
    onderwerpen: c.topics,
    uitgesloten_onderwerpen: c.excludedTopics,
    taal: c.language,
    lengte_minuten: { min: c.minMinutes, max: c.maxMinutes },
    regels: c.rules,
    gebruiksrechten: c.usageRights,
  };
  const feedback = {
    voorkeur: c.feedback.prefer,
    vermijden: c.feedback.avoid,
    notities: c.feedback.notes,
    goedgekeurd_voorbeelden: c.feedback.approved.slice(0, 10),
    afgewezen_voorbeelden: c.feedback.rejected.slice(0, 10),
  };
  const video = {
    titel: v.title,
    kanaal: v.channelTitle,
    duur: v.durationSec != null ? formatTimestamp(v.durationSec) : "onbekend",
    taal: v.language ?? "onbekend",
    views: v.viewCount,
    likes: v.likeCount,
    reacties: v.commentCount,
    gepubliceerd: v.publishedAt?.toISOString().slice(0, 10) ?? null,
    tags: v.tags.slice(0, 20),
    beschrijving: v.description.slice(0, 3000),
  };
  return [
    `## Campagne\n${JSON.stringify(campaign, null, 2)}`,
    `## Feedback van de campagne (stuurt de beoordeling)\n${JSON.stringify(feedback, null, 2)}`,
    `## Feitelijke metadata van de video\n${JSON.stringify(video, null, 2)}`,
    `## Transcript\n${formatTranscript(v)}`,
    "Geef je beoordeling.",
  ].join("\n\n");
}
