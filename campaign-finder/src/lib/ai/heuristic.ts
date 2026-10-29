import { clamp, formatTimestamp, normalize, parseTimestamp } from "../utils";
import type { TranscriptSegment } from "../search/types";
import type { Analysis, CampaignContext, VideoContext } from "./types";

/**
 * Regelgebaseerde analyse zonder LLM: transparant, deterministisch en
 * offline. Wordt gebruikt als er geen OpenAI/Anthropic-sleutel is (of als
 * fallback bij een fout).
 */
const HOOK_RE =
  /[!?]|\b(nooit|niemand|waarheid|geheim|serieus|haha\w*|wow|wacht|tips?|beste|fout|eerlijk|verwacht|never|nobody|truth|secret|seriously|wait|best|wrong|honestly|expected)\b/gi;

const has = (text: string, term: string) => {
  const t = normalize(term).trim();
  return t.length > 1 && text.includes(t);
};

export function parseChapters(description: string, durationSec: number | null): { start: number; end: number; title: string }[] {
  const lines = description.split("\n");
  const ch: { start: number; title: string }[] = [];
  for (const l of lines) {
    const m = l.trim().match(/^((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—:]?\s*(.+)$/);
    if (m) {
      const s = parseTimestamp(m[1]);
      if (s != null) ch.push({ start: s, title: m[2].trim() });
    }
  }
  return ch.map((c, i) => ({ ...c, end: ch[i + 1]?.start ?? durationSec ?? c.start + 60 }));
}

interface Window {
  start: number;
  end: number;
  score: number;
  hooks: number;
  terms: string[];
  bestLine: string;
  excluded: boolean;
}

function windows(segs: TranscriptSegment[], terms: string[], excluded: string[]): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < segs.length; i++) {
    let j = i;
    let hooks = 0;
    const found = new Set<string>();
    let excl = false;
    let bestLine = "";
    let bestLineScore = 0;
    while (j < segs.length && segs[j].start + segs[j].dur - segs[i].start <= 75) {
      const text = normalize(segs[j].text);
      const h = segs[j].text.match(HOOK_RE)?.length ?? 0;
      hooks += h;
      const segTerms = terms.filter((t) => has(text, t));
      segTerms.forEach((t) => found.add(t));
      // Sterkste zin als hook: hook-signalen tellen dubbel, campagnetermen enkel
      const lineScore = h * 2 + segTerms.length;
      if (lineScore > bestLineScore) {
        bestLineScore = lineScore;
        bestLine = segs[j].text;
      }
      if (excluded.some((e) => has(text, e))) excl = true;
      j++;
    }
    const end = segs[j - 1].start + segs[j - 1].dur;
    if (end - segs[i].start < 20) continue;
    out.push({ start: segs[i].start, end, hooks, terms: [...found], bestLine, excluded: excl, score: hooks * 2 + found.size * 3 - (excl ? 8 : 0) });
  }
  return out;
}

/** Beste niet-overlappende fragmenten. */
export function bestWindows(segs: TranscriptSegment[], terms: string[], excluded: string[], max = 3): Window[] {
  const picked: Window[] = [];
  for (const w of windows(segs, terms, excluded).sort((a, b) => b.score - a.score)) {
    if (picked.length >= max || w.score < 5) break;
    if (picked.some((p) => w.start < p.end && p.start < w.end)) continue;
    picked.push(w);
  }
  return picked.sort((a, b) => a.start - b.start);
}

export function analyzeHeuristic(c: CampaignContext, v: VideoContext): Analysis {
  const transcriptText = (v.transcript ?? []).map((s) => s.text).join(" ");
  const titleN = normalize(v.title);
  const all = normalize([v.title, v.description, v.tags.join(" "), transcriptText].join(" "));
  const reasons: string[] = [];
  const violations: string[] = [];

  // ── Match score ──
  let match = 20;
  const kwFound = c.keywords.filter((k) => has(all, k));
  const peopleFound = c.people.filter((p) => has(all, p));
  const topicsFound = c.topics.filter((t) => has(all, t));
  if (c.keywords.length) match += Math.round((kwFound.length / c.keywords.length) * 35);
  else match += 15;
  if (peopleFound.length) match += 15;
  else if (c.people.length) reasons.push(`Geen van de personen (${c.people.join(", ")}) gevonden.`);
  if (topicsFound.length) match += Math.min(10, topicsFound.length * 5);
  if ([...c.keywords, ...c.people].some((t) => has(titleN, t))) match += 10;
  if (kwFound.length || peopleFound.length) reasons.push(`Noemt ${[...peopleFound, ...kwFound].slice(0, 4).join(", ")}.`);

  if (v.language) {
    if (v.language.slice(0, 2) === c.language.slice(0, 2)) match += 5;
    else {
      match -= 15;
      reasons.push(`Taal is ${v.language}, campagne vraagt ${c.language}.`);
    }
  }
  if (v.durationSec != null) {
    const min = v.durationSec / 60;
    if ((c.minMinutes != null && min < c.minMinutes) || (c.maxMinutes != null && min > c.maxMinutes)) {
      match -= 25;
      violations.push(`Lengte ${Math.round(min)} min valt buiten ${c.minMinutes ?? 0}–${c.maxMinutes ?? "∞"} min`);
    } else match += 5;
  }
  for (const ex of c.excludedTopics) {
    if (has(all, ex)) violations.push(`Bevat uitgesloten onderwerp: ${ex}`);
  }
  for (const a of c.feedback.avoid) {
    if (has(all, a)) {
      match -= 15;
      reasons.push(`Bevat "${a}" (feedback: vermijden).`);
    }
  }
  const preferred = c.feedback.prefer.filter((p) => has(all, p));
  if (preferred.length) {
    match += Math.min(16, preferred.length * 8);
    reasons.push(`Sluit aan bij voorkeur: ${preferred.join(", ")}.`);
  }
  const channel = normalize(v.channelTitle);
  if (c.feedback.approved.some((a) => normalize(a.channel) === channel)) {
    match += 6;
    reasons.push("Kanaal eerder goedgekeurd.");
  }
  if (c.feedback.rejected.filter((r) => normalize(r.channel) === channel).length >= 2) {
    match -= 12;
    reasons.push("Kanaal meerdere keren afgewezen.");
  }
  if (violations.some((x) => x.startsWith("Bevat uitgesloten"))) match = Math.min(match - 40, 35);

  // ── Clip score ──
  let clip = 25;
  const terms = [...c.keywords, ...c.people, ...c.topics, ...c.feedback.prefer];
  let timestamps: Analysis["timestamps"] = [];
  if (v.transcript?.length) {
    const best = bestWindows(v.transcript, terms, [...c.excludedTopics, ...c.feedback.avoid]);
    const minutes = Math.max(1, (v.transcript.at(-1)!.start + v.transcript.at(-1)!.dur) / 60);
    const hookRate = (transcriptText.match(HOOK_RE)?.length ?? 0) / minutes;
    clip += Math.min(30, best.reduce((n, w) => n + w.score, 0));
    clip += Math.min(10, Math.round(hookRate * 4));
    timestamps = best.map((w) => ({
      start: formatTimestamp(w.start),
      end: formatTimestamp(w.end),
      reason: `${w.hooks} hook-signalen${w.terms.length ? `, noemt ${w.terms.slice(0, 3).join(", ")}` : ""}${w.excluded ? " (let op: raakt uitgesloten onderwerp)" : ""}`,
      hook: w.bestLine,
    }));
    if (best.length) reasons.push(`${best.length} sterke fragmenten in het transcript.`);
    else reasons.push("Transcript bevat weinig duidelijke hooks.");
  } else {
    const chapters = parseChapters(v.description, v.durationSec).filter((ch) => terms.some((t) => has(normalize(ch.title), t)));
    timestamps = chapters.slice(0, 3).map((ch) => ({
      start: formatTimestamp(ch.start),
      end: formatTimestamp(Math.min(ch.end, ch.start + 90)),
      reason: `Hoofdstuk "${ch.title}" (uit beschrijving, niet geverifieerd met transcript)`,
      hook: "",
    }));
    clip += chapters.length ? 10 : 0;
    reasons.push(chapters.length ? "Geen transcript; fragmenten op basis van hoofdstukken." : "Geen transcript; clip-inschatting alleen op metadata.");
  }
  if (v.viewCount && v.likeCount) {
    const ratio = v.likeCount / v.viewCount;
    if (ratio > 0.03) clip += 10;
    else if (ratio > 0.015) clip += 5;
  }
  if (v.viewCount && v.viewCount > 100_000) clip += 10;
  else if (v.viewCount && v.viewCount > 10_000) clip += 5;
  if (v.durationSec != null && v.durationSec < 60) clip -= 15;
  if (match < 30) clip -= 10;

  const matchScore = clamp(match);
  const clipScore = clamp(clip);
  const verdict = violations.some((x) => x.startsWith("Bevat uitgesloten")) || matchScore < 45 ? "ongeschikt" : matchScore >= 70 && !violations.length ? "geschikt" : "twijfel";
  return {
    matchScore,
    clipScore,
    verdict,
    reasoning: reasons.join(" ") || "Weinig aanknopingspunten met de campagne.",
    ruleViolations: violations,
    detectedTopics: [...new Set([...peopleFound, ...kwFound, ...topicsFound])],
    timestamps,
  };
}
