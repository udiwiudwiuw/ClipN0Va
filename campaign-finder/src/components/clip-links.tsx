"use client";

import { Scissors } from "lucide-react";
import type { Clip } from "@/lib/types-ui";
import { parseTimestamp } from "@/lib/utils";

/** Link naar de video op het juiste tijdstip (alleen voor echte YouTube-video's). */
export function clipHref(url: string, start: string, isDemo: boolean) {
  if (isDemo) return undefined;
  const s = parseTimestamp(start) ?? 0;
  return `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(s)}s`;
}

export function ClipChips({ clips, url, isDemo, max = 3 }: { clips: Clip[]; url: string; isDemo: boolean; max?: number }) {
  if (!clips.length) return <p className="text-xs text-slate-400">Geen fragmenten voorgesteld</p>;
  return (
    <ul className="space-y-1">
      {clips.slice(0, max).map((c, i) => {
        const href = clipHref(url, c.start, isDemo);
        const inner = (
          <>
            <Scissors className="mt-0.5 h-3 w-3 shrink-0 text-brand-600" />
            <span className="shrink-0 font-mono font-semibold tabular-nums">
              {c.start}–{c.end}
            </span>
            <span className="line-clamp-1 text-slate-600" title={c.hook || c.reason}>
              {c.hook ? `“${c.hook}”` : c.reason}
            </span>
          </>
        );
        return (
          <li key={i}>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="flex gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-brand-50">
                {inner}
              </a>
            ) : (
              <span className="flex gap-1.5 px-1 py-0.5 text-xs">{inner}</span>
            )}
          </li>
        );
      })}
      {clips.length > max && <li className="px-1 text-xs text-slate-400">+{clips.length - max} meer</li>}
    </ul>
  );
}
