"use client";

import { AlertTriangle, ExternalLink, RefreshCw, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ClipChips } from "@/components/clip-links";
import { AiLabel, ScoreBadge, StatusBadge, VerdictBadge } from "@/components/scores";
import { useToast } from "@/components/toast";
import { Badge, Button, Dialog, Spinner, Textarea } from "@/components/ui";
import { api, fmtDate, fmtRelative } from "@/lib/client";
import type { Match } from "@/lib/types-ui";
import { cn, formatCount, formatDuration, formatTimestamp, parseTimestamp } from "@/lib/utils";

type Segment = { start: number; dur: number; text: string };

const SOURCE_LABEL: Record<string, string> = { youtube_api: "YouTube Data API v3", rss: "YouTube RSS-feed", mock: "Demo Data Engine (fictief)" };

export function VideoDialog({
  matchId,
  onClose,
  onChanged,
  onDecide,
}: {
  matchId: string | null;
  onClose: () => void;
  onChanged: (m: Match) => void;
  onDecide: (m: Match, status: "approved" | "rejected") => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<{ match: Match; transcript: Segment[] | null } | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setData(null);
    if (!matchId) return;
    api(`/api/matches/${matchId}`).then((d) => {
      setData(d);
      setNotes(d.match.notes);
    }, (e) => toast((e as Error).message, "error"));
  }, [matchId, toast]);

  const ranges = useMemo(
    () => (data?.match.timestamps ?? []).map((t) => [parseTimestamp(t.start) ?? 0, parseTimestamp(t.end) ?? 0] as const),
    [data],
  );

  if (!matchId) return null;
  const m = data?.match;
  const v = m?.video;

  async function reanalyze() {
    setBusy(true);
    try {
      const r = await api(`/api/matches/${matchId}/analyze`, { method: "POST" });
      setData((d) => (d ? { ...d, match: r.match } : d));
      onChanged(r.match);
      toast("Opnieuw geanalyseerd");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveNotes() {
    try {
      const r = await api(`/api/matches/${matchId}`, { method: "PATCH", json: { notes } });
      onChanged(r.match);
      toast("Notitie opgeslagen");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={m ? <span className="flex items-center gap-2"><StatusBadge status={m.status} /> <span className="line-clamp-1">{v!.title}</span></span> : "Laden…"}
      footer={
        m && (
          <>
            <Button variant="outline" className="mr-auto" onClick={reanalyze} disabled={busy}>
              {busy ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Opnieuw analyseren
            </Button>
            <Button variant="outline" className="text-red-700" onClick={() => onDecide(m, "rejected")}>
              <ThumbsDown className="h-4 w-4" /> Afwijzen
            </Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => onDecide(m, "approved")}>
              <ThumbsUp className="h-4 w-4" /> Goedkeuren
            </Button>
          </>
        )
      }
    >
      {!m || !v ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Feitelijke metadata */}
          <section>
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Feitelijke metadata · bron: {SOURCE_LABEL[v.source] ?? v.source}</h3>
            {v.source === "mock" && (
              <p className="mb-2 rounded-md bg-violet-50 px-2 py-1.5 text-xs text-violet-800">Demo-video: gegenereerd voor testen, bestaat niet echt op YouTube.</p>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="mb-3 aspect-video w-full rounded-lg object-cover" />}
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-500">Kanaal</dt><dd>{v.channelTitle || "—"}</dd>
              <dt className="text-slate-500">Duur</dt><dd>{formatDuration(v.durationSec)}</dd>
              <dt className="text-slate-500">Taal</dt><dd>{v.language?.toUpperCase() ?? "onbekend"}</dd>
              <dt className="text-slate-500">Gepubliceerd</dt><dd>{fmtDate(v.publishedAt)}</dd>
              <dt className="text-slate-500">Views</dt><dd>{formatCount(v.viewCount)}</dd>
              <dt className="text-slate-500">Likes / reacties</dt><dd>{formatCount(v.likeCount)} / {formatCount(v.commentCount)}</dd>
              <dt className="text-slate-500">Tags</dt><dd className="truncate">{v.tags || "—"}</dd>
              <dt className="text-slate-500">Link</dt>
              <dd>
                <a href={v.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                  {v.platform} <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
            </dl>
            {v.description && <p className="mt-3 max-h-32 overflow-y-auto whitespace-pre-line rounded-md bg-slate-50 p-2 text-xs text-slate-600">{v.description}</p>}
            <h4 className="mb-1 mt-4 text-xs font-semibold text-slate-500">Transcript {data?.transcript ? `(${data.transcript.length} regels, voorgestelde fragmenten gemarkeerd)` : ""}</h4>
            {data?.transcript ? (
              <div className="scrollbar-thin max-h-64 overflow-y-auto rounded-md border text-xs">
                {data.transcript.map((s, i) => {
                  const hit = ranges.some(([a, b]) => s.start >= a && s.start < b);
                  return (
                    <div key={i} className={cn("flex gap-2 px-2 py-0.5", hit && "bg-amber-50")}>
                      <span className="shrink-0 font-mono text-slate-400">{formatTimestamp(s.start)}</span>
                      <span>{s.text}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Geen transcript beschikbaar (YouTube API levert captions alleen aan de video-eigenaar).</p>
            )}
          </section>

          {/* AI-schatting */}
          <section className="rounded-lg border border-brand-100 bg-brand-50/30 p-4">
            <div className="mb-3 flex items-center justify-between">
              <AiLabel source={m.analysisSource} />
              <VerdictBadge verdict={m.verdict} />
            </div>
            <div className="flex gap-2">
              <ScoreBadge label="Match" value={m.matchScore} />
              <ScoreBadge label="Clip" value={m.clipScore} />
            </div>
            <p className="mt-3 text-sm text-slate-700">{m.reasoning ?? "Nog niet geanalyseerd."}</p>
            {m.violations.length > 0 && (
              <ul className="mt-3 space-y-1">
                {m.violations.map((x) => (
                  <li key={x} className="flex items-start gap-1.5 text-xs text-red-700"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{x}</li>
                ))}
              </ul>
            )}
            {m.detectedTopics.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {m.detectedTopics.map((t) => <Badge key={t} className="bg-white text-slate-700 ring-1 ring-slate-200">{t}</Badge>)}
              </div>
            )}
            <h4 className="mb-1 mt-4 text-xs font-semibold text-slate-500">Voorgestelde fragmenten</h4>
            <ClipChips clips={m.timestamps} url={v.url} isDemo={v.source === "mock"} max={5} />
            {m.timestamps.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-slate-500">
                {m.timestamps.map((t, i) => <li key={i}><span className="font-mono">{t.start}</span>: {t.reason}</li>)}
              </ul>
            )}
            <p className="mt-4 text-[11px] text-slate-400">
              {m.aiModel ?? "—"} · {m.analyzedAt ? fmtRelative(m.analyzedAt) : "niet geanalyseerd"}
              {m.analysisError && <span className="block text-amber-700">Terugval naar heuristiek: {m.analysisError}</span>}
            </p>
            <h4 className="mb-1 mt-4 text-xs font-semibold text-slate-500">Notities (eigen, geen AI)</h4>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== m.notes && saveNotes()} placeholder="Bijv. vanaf 12:00 sterk, intro overslaan" />
          </section>
        </div>
      )}
    </Dialog>
  );
}
