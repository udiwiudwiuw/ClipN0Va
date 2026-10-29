"use client";

import { AlertTriangle, Eye, Info, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { ClipChips } from "@/components/clip-links";
import { AiLabel, ScoreBadge, StatusBadge, VerdictBadge } from "@/components/scores";
import { Badge, Button, Card } from "@/components/ui";
import { fmtDate } from "@/lib/client";
import type { Match } from "@/lib/types-ui";
import { cn, formatCount, formatDuration } from "@/lib/utils";

export function VideoCard({
  m,
  onApprove,
  onReject,
  onReset,
  onOpen,
}: {
  m: Match;
  onApprove: () => void;
  onReject: () => void;
  onReset: () => void;
  onOpen: () => void;
}) {
  const v = m.video;
  const isDemo = v.source === "mock";
  return (
    <Card className={cn("flex flex-col overflow-hidden", m.status === "approved" && "ring-2 ring-emerald-400", m.status === "rejected" && "opacity-70")}>
      <button onClick={onOpen} className="relative block aspect-video bg-slate-200 text-left">
        {v.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : null}
        <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-xs text-white">{formatDuration(v.durationSec)}</span>
        <span className="absolute left-2 top-2 flex gap-1">
          <StatusBadge status={m.status} />
          {isDemo && <Badge className="bg-violet-600 text-white">demo</Badge>}
          {v.source === "rss" && <Badge className="bg-orange-500 text-white">rss</Badge>}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-3 p-4">
        {/* Feitelijke metadata */}
        <div>
          <button onClick={onOpen} className="line-clamp-2 text-left font-semibold leading-snug hover:text-brand-700" title={v.title}>
            {v.title}
          </button>
          <div className="mt-1 truncate text-sm text-slate-500">{v.channelTitle}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" />{formatCount(v.viewCount)}</span>
            <span>{fmtDate(v.publishedAt)}</span>
            <span className="uppercase">{v.language ?? "?"}</span>
            <span>{v.hasTranscript ? "transcript" : "geen transcript"}</span>
          </div>
        </div>

        {/* AI-schatting */}
        <div className="rounded-lg border border-brand-100 bg-brand-50/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <AiLabel source={m.analysisSource} />
            <VerdictBadge verdict={m.verdict} />
          </div>
          {m.analyzedAt ? (
            <>
              <div className="flex gap-2">
                <ScoreBadge label="Match" value={m.matchScore} title="Match met campagne-regels (0-100)" />
                <ScoreBadge label="Clip" value={m.clipScore} title="Geschiktheid voor TikTok/Shorts/Reels (0-100)" />
              </div>
              {m.reasoning && <p className="mt-2 line-clamp-3 text-xs text-slate-700">{m.reasoning}</p>}
              {m.violations.length > 0 && (
                <p className="mt-1.5 flex items-start gap-1 text-xs text-red-700">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {m.violations.join(" · ")}
                </p>
              )}
              <div className="mt-2 border-t border-brand-100 pt-2">
                <ClipChips clips={m.timestamps} url={v.url} isDemo={isDemo} />
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">{m.analysisError ? `Analyse mislukt: ${m.analysisError}` : "Wordt geanalyseerd…"}</p>
          )}
        </div>

        <div className="mt-auto flex gap-2">
          {m.status === "new" ? (
            <>
              <Button size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={onApprove}>
                <ThumbsUp className="h-3.5 w-3.5" /> Goedkeuren
              </Button>
              <Button size="sm" variant="outline" className="flex-1 text-red-700 hover:bg-red-50" onClick={onReject}>
                <ThumbsDown className="h-3.5 w-3.5" /> Afwijzen
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="flex-1" onClick={onReset}>
              <RotateCcw className="h-3.5 w-3.5" /> Terug naar nieuw
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onOpen} aria-label="Details">
            <Info className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
