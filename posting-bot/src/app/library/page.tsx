"use client";

import { Archive, CalendarPlus, Check, FolderInput, Grid3x3, List, Pencil, Search, Sparkles, Trash2, Upload, Video } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/sidebar";
import { ClipStatus, MockBadge, PlatformIcon, PostStatus } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import { api, toLocalInput } from "@/lib/client";
import { PLATFORM_LABELS, PLATFORMS, type Platform } from "@/lib/constants";
import { usePoll } from "@/lib/use-poll";
import { cn, formatBytes } from "@/lib/utils";

type Clip = {
  id: string;
  filename: string;
  sizeBytes: number;
  durationSec: number | null;
  source: string;
  campaign: string | null;
  creator: string | null;
  title: string;
  caption: string;
  hashtags: string;
  status: string;
  createdAt: string;
  posts: { id: string; status: string; platform: string; accountId: string; scheduledAt: string }[];
};
type Data = { clips: Clip[]; campaigns: string[]; creators: string[] };
type Account = { id: string; platform: Platform; handle: string; displayName: string; status: string; isMock: boolean };

function VideoThumb({ id, className }: { id: string; className?: string }) {
  return (
    <video
      src={`/api/media/${id}#t=0.5`}
      preload="metadata"
      muted
      playsInline
      loop
      className={cn("h-full w-full bg-slate-900 object-cover", className)}
      onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
      onMouseLeave={(e) => {
        e.currentTarget.pause();
        e.currentTarget.currentTime = 0.5;
      }}
    />
  );
}

function PostDots({ posts }: { posts: Clip["posts"] }) {
  const active = posts.filter((p) => p.status !== "cancelled");
  if (!active.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {active.slice(0, 6).map((p) => (
        <span key={p.id} title={`${PLATFORM_LABELS[p.platform as Platform]} — ${p.status}`} className="relative">
          <PlatformIcon platform={p.platform} className="h-5 w-5" />
          <span
            className={cn("absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-1 ring-white", {
              "bg-emerald-500": p.status === "success",
              "bg-blue-500": p.status === "queued",
              "bg-slate-400": p.status === "draft",
              "bg-amber-500": p.status === "processing",
              "bg-red-500": p.status === "failed" || p.status === "needs_reauth",
            })}
          />
        </span>
      ))}
      {active.length > 6 && <span className="text-xs text-slate-500">+{active.length - 6}</span>}
    </div>
  );
}

function UploadDialog({ open, onClose, onDone, campaigns }: { open: boolean; onClose: () => void; onDone: () => void; campaigns: string[] }) {
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [meta, setMeta] = useState({ campaign: "", creator: "", hashtags: "" });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      Object.entries(meta).forEach(([k, v]) => fd.append(k, v));
      const r = await api("/api/clips", { method: "POST", body: fd });
      toast(`${r.imported} geüpload${r.duplicates ? `, ${r.duplicates} dubbel overgeslagen` : ""}${r.errors.length ? `, ${r.errors.length} fout` : ""}`, r.errors.length ? "error" : "ok");
      setFiles([]);
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Clips uploaden"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button onClick={submit} disabled={!files.length || busy}>
            {busy ? <Spinner /> : <Upload className="h-4 w-4" />} Upload {files.length || ""}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-slate-200 px-4 py-8 text-sm text-slate-500 hover:border-brand-500">
          <Upload className="h-6 w-6" />
          {files.length ? `${files.length} bestand(en) gekozen (${formatBytes(files.reduce((n, f) => n + f.size, 0))})` : "Kies video's (mp4, mov, webm) — meerdere tegelijk mogelijk"}
          <input type="file" multiple accept="video/mp4,video/quicktime,video/webm,.m4v" className="hidden" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Campagne">
            <Input list="campaigns" value={meta.campaign} onChange={(e) => setMeta({ ...meta, campaign: e.target.value })} />
            <datalist id="campaigns">{campaigns.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Creator">
            <Input value={meta.creator} onChange={(e) => setMeta({ ...meta, creator: e.target.value })} />
          </Field>
        </div>
        <Field label="Hashtags voor alle clips">
          <Input placeholder="#podcast #clips" value={meta.hashtags} onChange={(e) => setMeta({ ...meta, hashtags: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [source, setSource] = useState<"clipnova" | "folder">("clipnova");
  const [form, setForm] = useState({ path: "", campaign: "", creator: "" });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const r = await api("/api/clips/import", { method: "POST", json: { source, ...form } });
      toast(`${r.imported} geïmporteerd, ${r.duplicates} al aanwezig${r.errors.length ? `, ${r.errors.length} fout` : ""}`, r.errors.length ? "error" : "ok");
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bulk-import"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner /> : <FolderInput className="h-4 w-4" />} Importeren
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-2">
          {(["clipnova", "folder"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={cn("rounded-lg border p-3 text-left text-sm", source === s ? "border-brand-500 bg-brand-50" : "border-slate-200")}
            >
              <div className="font-medium">{s === "clipnova" ? "Uit ClipNova" : "Uit map"}</div>
              <div className="text-xs text-slate-500">
                {s === "clipnova" ? "Leest backend/storage/<job>/job.json incl. titels, bijschriften en hashtags" : "Alle video's in een map (+ optioneel <naam>.json met metadata)"}
              </div>
            </button>
          ))}
        </div>
        <Field label="Pad op de server" hint={`Leeg = standaard uit Instellingen (${source === "clipnova" ? "CLIPNOVA_STORAGE_DIR" : "IMPORT_DIR"})`}>
          <Input placeholder={source === "clipnova" ? "/pad/naar/clipparty/backend/storage" : "./storage/inbox"} value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Campagne (optioneel)">
            <Input value={form.campaign} onChange={(e) => setForm({ ...form, campaign: e.target.value })} />
          </Field>
          <Field label="Creator (optioneel)">
            <Input value={form.creator} onChange={(e) => setForm({ ...form, creator: e.target.value })} />
          </Field>
        </div>
        <p className="text-xs text-slate-500">Dubbele video&apos;s (zelfde inhoud) worden automatisch overgeslagen.</p>
      </div>
    </Dialog>
  );
}

function EditClipDialog({ clip, onClose, onSaved }: { clip: Clip | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState<Partial<Clip>>({});
  const [ai, setAi] = useState<Platform | null>(null);
  const current = clip && form.id === clip.id ? form : clip ?? {};
  if (!clip) return null;
  const set = (patch: Partial<Clip>) => setForm({ ...current, ...patch, id: clip.id });
  async function save() {
    try {
      await api(`/api/clips/${clip!.id}`, {
        method: "PATCH",
        json: { title: current.title, caption: current.caption, hashtags: current.hashtags, campaign: current.campaign || null, creator: current.creator || null, status: current.status },
      });
      toast("Clip opgeslagen");
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  async function suggest(platform: Platform) {
    setAi(platform);
    try {
      const r = await api("/api/captions/preview", { method: "POST", json: { clipId: clip!.id, platform } });
      set({ title: r.title || current.title, caption: r.caption, hashtags: r.hashtags });
      toast(r.source === "ai" ? "AI-suggestie ingevuld" : "Sjabloon-suggestie ingevuld (geen OpenAI-sleutel)");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setAi(null);
    }
  }
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Clip bewerken"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button onClick={save}>Opslaan</Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[200px_1fr]">
        <div className="aspect-[9/16] overflow-hidden rounded-lg">
          <video src={`/api/media/${clip.id}`} controls className="h-full w-full bg-black object-contain" />
        </div>
        <div className="grid content-start gap-3">
          <div className="text-xs text-slate-500">
            {clip.filename} · {formatBytes(clip.sizeBytes)} · bron: {clip.source}
          </div>
          <Field label="Titel">
            <Input value={current.title ?? ""} onChange={(e) => set({ title: e.target.value })} />
          </Field>
          <Field label="Bijschrift">
            <Textarea rows={4} value={current.caption ?? ""} onChange={(e) => set({ caption: e.target.value })} />
          </Field>
          <Field label="Hashtags">
            <Input value={current.hashtags ?? ""} onChange={(e) => set({ hashtags: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Sparkles className="h-3.5 w-3.5 text-brand-600" /> Suggestie voor:
            {PLATFORMS.map((p) => (
              <Button key={p} size="sm" variant="outline" disabled={!!ai} onClick={() => suggest(p)}>
                {ai === p ? <Spinner className="h-3 w-3" /> : <PlatformIcon platform={p} className="h-4 w-4" />} {PLATFORM_LABELS[p]}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Campagne">
              <Input value={current.campaign ?? ""} onChange={(e) => set({ campaign: e.target.value })} />
            </Field>
            <Field label="Creator">
              <Input value={current.creator ?? ""} onChange={(e) => set({ creator: e.target.value })} />
            </Field>
            <Field label="Status">
              <Select className="w-full" value={current.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="draft">Nieuw</option>
                <option value="ready">Klaar</option>
                <option value="archived">Gearchiveerd</option>
              </Select>
            </Field>
          </div>
          {clip.posts.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t pt-3">
              {clip.posts.map((p) => (
                <span key={p.id} className="flex items-center gap-1 text-xs">
                  <PlatformIcon platform={p.platform} className="h-4 w-4" /> <PostStatus status={p.status} />
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ScheduleDialog({ clipIds, open, onClose, onDone }: { clipIds: string[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data } = usePoll<{ accounts: Account[] }>(open ? "/api/accounts" : null);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"auto" | "at">("auto");
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 3600_000)));
  const [spacing, setSpacing] = useState(60);
  const [generate, setGenerate] = useState(true);
  const [approve, setApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const accounts = data?.accounts ?? [];
  const toggle = (id: string) => setAccountIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  async function submit() {
    setBusy(true);
    try {
      const r = await api("/api/posts", {
        method: "POST",
        json: { clipIds, accountIds, mode, at: mode === "at" ? new Date(at).toISOString() : undefined, spacingMinutes: spacing, generateCaptions: generate, approve },
      });
      toast(`${r.created} post(s) gepland${r.skipped.length ? ` · ${r.skipped.length} overgeslagen (al gepland)` : ""}`);
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={`${clipIds.length} clip(s) inplannen`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button onClick={submit} disabled={!accountIds.length || busy}>
            {busy ? <Spinner /> : <CalendarPlus className="h-4 w-4" />} {clipIds.length * accountIds.length} post(s) plannen
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Accounts</span>
            <button className="text-xs text-brand-600" onClick={() => setAccountIds(accountIds.length === accounts.length ? [] : accounts.map((a) => a.id))}>
              {accountIds.length === accounts.length ? "Niets" : "Alles"} selecteren
            </button>
          </div>
          {accounts.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {accounts.map((a) => (
                <label key={a.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm", accountIds.includes(a.id) ? "border-brand-500 bg-brand-50" : "border-slate-200")}>
                  <input type="checkbox" checked={accountIds.includes(a.id)} onChange={() => toggle(a.id)} />
                  <PlatformIcon platform={a.platform} />
                  <span className="truncate">@{a.handle}</span>
                  {a.isMock && <MockBadge />}
                  {a.status !== "active" && <Badge className="bg-orange-100 text-orange-800">{a.status}</Badge>}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Nog geen accounts gekoppeld — ga naar Accounts.</p>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <button onClick={() => setMode("auto")} className={cn("rounded-lg border p-3 text-left text-sm", mode === "auto" ? "border-brand-500 bg-brand-50" : "border-slate-200")}>
            <div className="font-medium">Automatisch</div>
            <div className="text-xs text-slate-500">Volgende vrije posttijden per account (eigen tijdzone en daglimiet)</div>
          </button>
          <button onClick={() => setMode("at")} className={cn("rounded-lg border p-3 text-left text-sm", mode === "at" ? "border-brand-500 bg-brand-50" : "border-slate-200")}>
            <div className="font-medium">Vast moment</div>
            <div className="text-xs text-slate-500">Vanaf een tijdstip, met vaste tussenruimte per clip</div>
          </button>
        </div>
        {mode === "at" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start (jouw lokale tijd)">
              <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
            <Field label="Minuten tussen clips">
              <Input type="number" min={0} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
            </Field>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={generate} onChange={(e) => setGenerate(e.target.checked)} />
          <span>
            <b>Slimme bijschriften</b> — per platform geoptimaliseerd en per account gevarieerd (OpenAI indien ingesteld). Uit = tekst van de clip.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
          <span>
            <b>Direct goedkeuren</b> — anders komen de posts als concept in de wachtrij zodat je teksten eerst kunt nakijken.
          </span>
        </label>
      </div>
    </Dialog>
  );
}

export default function LibraryPage() {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: "", campaign: "", creator: "", status: "", source: "" });
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<"upload" | "import" | "schedule" | null>(null);
  const [editing, setEditing] = useState<Clip | null>(null);
  const qs = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString(), [filters]);
  const { data, reload, loading } = usePoll<Data>(`/api/clips?${qs}`, 15000);
  const clips = data?.clips ?? [];
  const lastClicked = useRef<number | null>(null);

  const toggle = (id: string, idx: number, shift: boolean) => {
    if (shift && lastClicked.current !== null) {
      const [a, b] = [lastClicked.current, idx].sort((x, y) => x - y);
      const range = clips.slice(a, b + 1).map((c) => c.id);
      setSelected((s) => Array.from(new Set([...s, ...range])));
    } else {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    }
    lastClicked.current = idx;
  };

  async function bulk(action: "archive" | "delete" | "ready") {
    if (action === "delete" && !confirm(`${selected.length} clip(s) en hun geplande posts verwijderen?`)) return;
    let ok = 0;
    for (const id of selected) {
      try {
        if (action === "delete") await api(`/api/clips/${id}`, { method: "DELETE" });
        else await api(`/api/clips/${id}`, { method: "PATCH", json: { status: action === "archive" ? "archived" : "ready" } });
        ok++;
      } catch (e) {
        toast((e as Error).message, "error");
      }
    }
    toast(`${ok} clip(s) bijgewerkt`);
    setSelected([]);
    reload();
  }

  return (
    <>
      <PageHeader
        title="Videobibliotheek"
        description="Alle clips op één plek. Selecteer clips (shift-klik voor een reeks) om ze in te plannen."
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog("import")}>
              <FolderInput className="h-4 w-4" /> Bulk-import
            </Button>
            <Button onClick={() => setDialog("upload")}>
              <Upload className="h-4 w-4" /> Uploaden
            </Button>
          </>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input className="pl-8" placeholder="Zoek op titel, bijschrift, hashtag…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
        </div>
        <Select value={filters.campaign} onChange={(e) => setFilters({ ...filters, campaign: e.target.value })}>
          <option value="">Alle campagnes</option>
          {data?.campaigns.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select value={filters.creator} onChange={(e) => setFilters({ ...filters, creator: e.target.value })}>
          <option value="">Alle creators</option>
          {data?.creators.map((c) => <option key={c}>{c}</option>)}
        </Select>
        <Select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">Actief</option>
          <option value="draft">Nieuw</option>
          <option value="ready">Klaar</option>
          <option value="archived">Gearchiveerd</option>
        </Select>
        <Select value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
          <option value="">Alle bronnen</option>
          <option value="upload">Upload</option>
          <option value="folder">Map</option>
          <option value="clipnova">ClipNova</option>
        </Select>
        <div className="flex rounded-lg border">
          <Button size="icon" variant={view === "grid" ? "secondary" : "ghost"} onClick={() => setView("grid")} aria-label="Raster">
            <Grid3x3 className="h-4 w-4" />
          </Button>
          <Button size="icon" variant={view === "list" ? "secondary" : "ghost"} onClick={() => setView("list")} aria-label="Lijst">
            <List className="h-4 w-4" />
          </Button>
        </div>
      </Card>

      {selected.length > 0 && (
        <div className="sticky top-2 z-30 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 shadow-sm">
          <span className="text-sm font-medium">{selected.length} geselecteerd</span>
          <Button size="sm" onClick={() => setDialog("schedule")}>
            <CalendarPlus className="h-3.5 w-3.5" /> Inplannen
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulk("ready")}>
            <Check className="h-3.5 w-3.5" /> Markeer klaar
          </Button>
          <Button size="sm" variant="outline" onClick={() => bulk("archive")}>
            <Archive className="h-3.5 w-3.5" /> Archiveren
          </Button>
          <Button size="sm" variant="outline" className="text-red-600" onClick={() => bulk("delete")}>
            <Trash2 className="h-3.5 w-3.5" /> Verwijderen
          </Button>
          <button className="ml-auto text-xs text-slate-600" onClick={() => setSelected(selected.length === clips.length ? [] : clips.map((c) => c.id))}>
            {selected.length === clips.length ? "Selectie wissen" : `Alle ${clips.length} selecteren`}
          </button>
        </div>
      )}

      {!loading && !clips.length ? (
        <Card>
          <EmptyState icon={<Video className="h-5 w-5" />} title="Nog geen clips">
            Upload video&apos;s of importeer ze in bulk uit ClipNova of een map.
          </EmptyState>
        </Card>
      ) : view === "grid" ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {clips.map((c, i) => (
            <Card key={c.id} className={cn("group overflow-hidden", selected.includes(c.id) && "ring-2 ring-brand-500")}>
              <div className="relative aspect-[9/16]">
                <VideoThumb id={c.id} />
                <label className="absolute left-2 top-2 flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-white/90" onClick={(e) => { e.preventDefault(); toggle(c.id, i, e.shiftKey); }}>
                  <input type="checkbox" readOnly checked={selected.includes(c.id)} className="pointer-events-none" />
                </label>
                <div className="absolute right-2 top-2">
                  <ClipStatus status={c.status} />
                </div>
                <button className="absolute bottom-2 right-2 rounded-md bg-white/90 p-1.5 opacity-0 transition-opacity group-hover:opacity-100" onClick={() => setEditing(c)} aria-label="Bewerken">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-1.5 p-3">
                <div className="line-clamp-2 text-sm font-medium" title={c.title}>{c.title || c.filename}</div>
                <div className="truncate text-xs text-slate-500">{[c.campaign, c.creator].filter(Boolean).join(" · ") || c.source}</div>
                <PostDots posts={c.posts} />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2">Clip</th>
                <th className="px-3 py-2">Campagne</th>
                <th className="px-3 py-2">Creator</th>
                <th className="px-3 py-2">Hashtags</th>
                <th className="px-3 py-2">Posts</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {clips.map((c, i) => (
                <tr key={c.id} className={cn(selected.includes(c.id) && "bg-brand-50")}>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={selected.includes(c.id)} onChange={() => {}} onClick={(e) => toggle(c.id, i, e.shiftKey)} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-3">
                      <div className="h-14 w-8 shrink-0 overflow-hidden rounded"><VideoThumb id={c.id} /></div>
                      <div className="min-w-0">
                        <div className="max-w-xs truncate font-medium">{c.title || c.filename}</div>
                        <div className="text-xs text-slate-500">{c.filename} · {formatBytes(c.sizeBytes)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">{c.campaign ?? "—"}</td>
                  <td className="px-3 py-2">{c.creator ?? "—"}</td>
                  <td className="max-w-[200px] truncate px-3 py-2 text-xs text-slate-500">{c.hashtags}</td>
                  <td className="px-3 py-2"><PostDots posts={c.posts} /></td>
                  <td className="px-3 py-2"><ClipStatus status={c.status} /></td>
                  <td className="px-3 py-2">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(c)} aria-label="Bewerken"><Pencil className="h-3.5 w-3.5" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <UploadDialog open={dialog === "upload"} onClose={() => setDialog(null)} onDone={reload} campaigns={data?.campaigns ?? []} />
      <ImportDialog open={dialog === "import"} onClose={() => setDialog(null)} onDone={reload} />
      <ScheduleDialog open={dialog === "schedule"} clipIds={selected} onClose={() => setDialog(null)} onDone={() => { setSelected([]); reload(); }} />
      <EditClipDialog clip={editing} onClose={() => setEditing(null)} onSaved={reload} />
    </>
  );
}
