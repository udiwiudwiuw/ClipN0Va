import type { findMatches } from "./matches";
import { formatTimestamp } from "./utils";

type Match = Awaited<ReturnType<typeof findMatches>>[number];

/** Platte rij: feitelijke metadata en AI-schattingen gescheiden door prefixes. */
export function exportRow(m: Match) {
  return {
    url: m.video.url,
    titel: m.video.title,
    kanaal: m.video.channelTitle,
    platform: m.video.platform,
    taal: m.video.language ?? "",
    duur: m.video.durationSec != null ? formatTimestamp(m.video.durationSec) : "",
    views: m.video.viewCount ?? "",
    gepubliceerd: m.video.publishedAt ? new Date(m.video.publishedAt).toISOString().slice(0, 10) : "",
    bron: m.video.source,
    status: m.status,
    ai_match_score: m.matchScore ?? "",
    ai_clip_score: m.clipScore ?? "",
    ai_oordeel: m.verdict ?? "",
    ai_onderbouwing: m.reasoning ?? "",
    ai_fragmenten: m.timestamps.map((t) => `${t.start}-${t.end} ${t.reason}`).join(" | "),
    ai_overtredingen: m.violations.join(" | "),
    ai_model: m.aiModel ?? "",
    notities: m.notes,
  };
}

function csvCell(v: unknown): string {
  let s = String(v ?? "");
  // Voorkom formule-injectie in Excel/Sheets
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return "﻿" + [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\r\n");
}
