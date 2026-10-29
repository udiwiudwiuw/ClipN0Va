"use client";

import { ChevronDown, Download, Loader2, Pencil, Plus, Radar, RefreshCw, Search, Video } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackPanel } from "@/components/feedback-panel";
import { PageHeader } from "@/components/header";
import { ReasonDialog } from "@/components/reject-dialog";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner } from "@/components/ui";
import { VideoCard } from "@/components/video-card";
import { VideoDialog } from "@/components/video-dialog";
import { api, fmtRelative } from "@/lib/client";
import type { Campaign, Match, Run } from "@/lib/types-ui";
import { usePoll } from "@/lib/use-poll";
import { cn, splitList } from "@/lib/utils";

const STATUS_TABS = [
  { key: "", label: "Alles" },
  { key: "new", label: "Nieuw" },
  { key: "approved", label: "Goedgekeurd" },
  { key: "rejected", label: "Afgewezen" },
];

type Filters = { status: string; platform: string; language: string; minScore: string; minClipScore: string; source: string; sort: string; q: string };
const DEFAULT_FILTERS: Filters = { status: "new", platform: "", language: "", minScore: "", minClipScore: "", source: "", sort: "match", q: "" };

function RunStatus({ run }: { run: Run | undefined }) {
  const [open, setOpen] = useState(false);
  if (!run) return null;
  const busy = run.status === "queued" || run.status === "running";
  return (
    <div className="text-xs text-slate-500">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 hover:text-slate-800">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-600" /> : null}
        {busy
          ? `Zoeken… ${run.found ? `${run.found} gevonden, ${run.analyzed}/${run.newVideos} geanalyseerd` : ""}`
          : run.status === "failed"
            ? <span className="text-red-600">Laatste zoekronde mislukt: {run.error}</span>
            : `Laatste zoekronde ${fmtRelative(run.finishedAt ?? run.createdAt)}: ${run.found} gevonden, ${run.newVideos} nieuw, ${run.skipped} overgeslagen (${run.sources.join(" + ")})`}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="scrollbar-thin mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
          {run.log.join("\n") || "Nog geen log"}
        </pre>
      )}
    </div>
  );
}

export default function CampaignDashboard({ params }: { params: { id: string } }) {
  const id = params.id;
  const router = useRouter();
  const toast = useToast();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decide, setDecide] = useState<{ match: Match; mode: "approved" | "rejected" } | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [feedbackVersion, setFeedbackVersion] = useState(0);

  useEffect(() => {
    try {
      localStorage.setItem("finder:lastCampaign", id);
    } catch {}
  }, [id]);

  const { data: campaigns, reload: reloadCampaigns } = usePoll<{ campaigns: Campaign[] }>("/api/campaigns");
  const campaign = campaigns?.campaigns.find((c) => c.id === id);
  const qs = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]).toString(), [filters]);
  const { data, reload, setData } = usePoll<{ matches: Match[]; languages: string[] }>(`/api/campaigns/${id}/videos?${qs}`);
  const { data: runsData, reload: reloadRuns } = usePoll<{ runs: Run[] }>(`/api/campaigns/${id}/search`);
  const latest = runsData?.runs[0];
  const searching = latest?.status === "queued" || latest?.status === "running";

  // Tijdens een zoekronde de voortgang en resultaten pollen
  const wasSearching = useRef(false);
  useEffect(() => {
    if (!searching) {
      if (wasSearching.current) {
        reload();
        reloadCampaigns();
        wasSearching.current = false;
      }
      return;
    }
    wasSearching.current = true;
    const t = setInterval(() => {
      reloadRuns();
      reload();
    }, 1500);
    return () => clearInterval(t);
  }, [searching, reload, reloadRuns, reloadCampaigns]);

  async function startSearch() {
    try {
      const r = await api(`/api/campaigns/${id}/search`, { method: "POST" });
      toast(r.alreadyQueued ? "Er loopt al een zoekronde" : "Zoekronde gestart");
      reloadRuns();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function reanalyze() {
    setReanalyzing(true);
    try {
      const r = await api(`/api/campaigns/${id}/reanalyze`, { method: "POST", json: { status: "new" } });
      toast(`${r.analyzed} nieuwe video's opnieuw beoordeeld met de huidige regels en feedback`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setReanalyzing(false);
    }
  }

  const replace = useCallback((m: Match) => setData((d) => (d ? { ...d, matches: d.matches.map((x) => (x.id === m.id ? m : x)) } : d)), [setData]);

  async function setStatus(m: Match, status: Match["status"], reason?: string) {
    try {
      const r = await api(`/api/matches/${m.id}`, { method: "PATCH", json: { status, reason } });
      // Verdwijnt uit de huidige tab als die op status filtert
      setData((d) => (d ? { ...d, matches: filters.status && filters.status !== status ? d.matches.filter((x) => x.id !== m.id) : d.matches.map((x) => (x.id === m.id ? r.match : x)) } : d));
      setFeedbackVersion((v) => v + 1);
      reloadCampaigns();
      toast(status === "approved" ? "Goedgekeurd 👍" : status === "rejected" ? "Afgewezen 👎" : "Teruggezet naar nieuw");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const matches = data?.matches ?? [];
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  if (campaigns && !campaign) {
    return (
      <Card>
        <EmptyState icon={<Radar className="h-5 w-5" />} title="Campagne niet gevonden">
          <Link href="/campaigns" className="text-brand-600">Naar alle campagnes</Link>
        </EmptyState>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="Campagne kiezen"
              className="h-10 max-w-[360px] text-base font-semibold"
              value={id}
              onChange={(e) => (e.target.value === "__new" ? router.push("/campaigns/new") : router.push(`/campaigns/${e.target.value}`))}
            >
              {campaigns?.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.active ? "" : " (inactief)"}
                </option>
              ))}
              <option value="__new">+ Nieuwe campagne…</option>
            </Select>
            {campaign && !campaign.active && <Badge className="bg-slate-200 text-slate-600">inactief</Badge>}
          </span>
        }
        description={
          campaign && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{campaign.brand || "—"}</span>
              <span>· {campaign.language.toUpperCase()}</span>
              {(campaign.minMinutes != null || campaign.maxMinutes != null) && <span>· {campaign.minMinutes ?? 0}–{campaign.maxMinutes ?? "∞"} min</span>}
              {splitList(campaign.keywords).slice(0, 5).map((k) => (
                <Badge key={k} className="bg-slate-100 text-slate-600">{k}</Badge>
              ))}
            </span>
          )
        }
        actions={
          <>
            <Link href={`/campaigns/${id}/edit`}>
              <Button variant="outline"><Pencil className="h-4 w-4" /> Bewerken</Button>
            </Link>
            <div className="flex">
              <a href={`/api/campaigns/${id}/export?format=csv`}>
                <Button variant="outline" className="rounded-r-none"><Download className="h-4 w-4" /> CSV</Button>
              </a>
              <a href={`/api/campaigns/${id}/export?format=json`}>
                <Button variant="outline" className="-ml-px rounded-l-none">JSON</Button>
              </a>
            </div>
            <Button onClick={startSearch} disabled={searching}>
              {searching ? <Spinner /> : <Search className="h-4 w-4" />} {searching ? "Bezig met zoeken" : "Video's zoeken"}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        {campaign?.counts && (
          <div className="flex gap-4 text-sm">
            <span><b>{campaign.counts.new ?? 0}</b> nieuw</span>
            <span className="text-emerald-700"><b>{campaign.counts.approved ?? 0}</b> goedgekeurd</span>
            <span className="text-red-700"><b>{campaign.counts.rejected ?? 0}</b> afgewezen</span>
          </div>
        )}
        <RunStatus run={latest} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          {/* Filter- en sorteerbalk */}
          <Card className="mb-4 p-3">
            <div className="mb-3 flex flex-wrap gap-1">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => set({ status: t.key })}
                  className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", filters.status === t.key ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-100")}
                >
                  {t.label}
                </button>
              ))}
              <span className="ml-auto self-center text-xs text-slate-500">{matches.length} video&apos;s</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                <Input className="pl-8" placeholder="Zoek in titel, kanaal…" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
              </div>
              <Select value={filters.platform} onChange={(e) => set({ platform: e.target.value })} aria-label="Platform">
                <option value="">Alle platforms</option>
                <option value="youtube">YouTube</option>
              </Select>
              <Select value={filters.language} onChange={(e) => set({ language: e.target.value })} aria-label="Taal">
                <option value="">Alle talen</option>
                {data?.languages.map((l) => <option key={l} value={l}>{l.toUpperCase()}</option>)}
              </Select>
              <Select value={filters.minScore} onChange={(e) => set({ minScore: e.target.value })} aria-label="Min. match score">
                <option value="">Min. match: alle</option>
                {[30, 50, 60, 70, 80].map((n) => <option key={n} value={n}>Match ≥ {n}</option>)}
              </Select>
              <Select value={filters.minClipScore} onChange={(e) => set({ minClipScore: e.target.value })} aria-label="Min. clip score">
                <option value="">Min. clip: alle</option>
                {[30, 50, 60, 70, 80].map((n) => <option key={n} value={n}>Clip ≥ {n}</option>)}
              </Select>
              <Select value={filters.source} onChange={(e) => set({ source: e.target.value })} aria-label="Bron">
                <option value="">Alle bronnen</option>
                <option value="youtube_api">YouTube API</option>
                <option value="rss">RSS</option>
                <option value="mock">Demo</option>
              </Select>
              <Select value={filters.sort} onChange={(e) => set({ sort: e.target.value })} aria-label="Sorteren">
                <option value="match">Sorteer: Match score</option>
                <option value="clip">Sorteer: Clip score</option>
                <option value="date">Sorteer: Publicatiedatum</option>
                <option value="found">Sorteer: Laatst gevonden</option>
              </Select>
              {JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) && (
                <Button size="sm" variant="ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</Button>
              )}
            </div>
          </Card>

          {data && !matches.length ? (
            <Card>
              <EmptyState icon={<Video className="h-5 w-5" />} title={filters.status === "new" && !filters.q ? "Geen nieuwe video's" : "Geen video's met deze filters"}>
                <p>Klik op “Video&apos;s zoeken” om nieuwe kandidaten te vinden en te laten scoren.</p>
                <Button className="mt-3" onClick={startSearch} disabled={searching}><Plus className="h-4 w-4" /> Nu zoeken</Button>
              </EmptyState>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {matches.map((m) => (
                <VideoCard
                  key={m.id}
                  m={m}
                  onOpen={() => setOpenId(m.id)}
                  onApprove={() => setStatus(m, "approved")}
                  onReject={() => setDecide({ match: m, mode: "rejected" })}
                  onReset={() => setStatus(m, "new")}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <FeedbackPanel campaignId={id} version={feedbackVersion} onReanalyze={reanalyze} />
          {reanalyzing && (
            <p className="flex items-center gap-2 text-xs text-slate-500"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Bezig met herbeoordelen…</p>
          )}
        </aside>
      </div>

      <VideoDialog
        matchId={openId}
        onClose={() => setOpenId(null)}
        onChanged={replace}
        onDecide={(m, mode) => {
          setOpenId(null);
          setDecide({ match: m, mode });
        }}
      />
      <ReasonDialog
        match={decide?.match ?? null}
        mode={decide?.mode ?? "rejected"}
        onClose={() => setDecide(null)}
        onSubmit={(reason) => {
          if (decide) setStatus(decide.match, decide.mode, reason);
          setDecide(null);
        }}
      />
    </>
  );
}
