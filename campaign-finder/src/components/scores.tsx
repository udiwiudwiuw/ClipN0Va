"use client";

import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

export function scoreColor(n: number | null) {
  if (n == null) return "bg-slate-100 text-slate-500";
  if (n >= 70) return "bg-emerald-100 text-emerald-800";
  if (n >= 45) return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-700";
}

export function ScoreBadge({ label, value, title }: { label: string; value: number | null; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-baseline gap-1 rounded-lg px-2 py-1 text-xs font-medium", scoreColor(value))}>
      {label}
      <span className="text-base font-bold tabular-nums">{value ?? "—"}</span>
    </span>
  );
}

export function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return null;
  const cls = verdict === "geschikt" ? "bg-emerald-100 text-emerald-800" : verdict === "twijfel" ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700";
  return <Badge className={cls}>{verdict}</Badge>;
}

/** Duidelijk label dat iets een AI-schatting is (en geen feit). */
export function AiLabel({ source, className }: { source?: string | null; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-brand-700", className)}>
      <Sparkles className="h-3 w-3" /> AI-schatting{source === "heuristic" ? " (heuristiek)" : ""}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    new: ["Nieuw", "bg-blue-100 text-blue-700"],
    approved: ["Goedgekeurd", "bg-emerald-100 text-emerald-700"],
    rejected: ["Afgewezen", "bg-red-100 text-red-700"],
  };
  const [label, cls] = map[status] ?? [status, "bg-slate-100"];
  return <Badge className={cls}>{label}</Badge>;
}
