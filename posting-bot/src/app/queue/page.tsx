"use client";

import { Ban, Check, ExternalLink, ListChecks, Play, RotateCcw, ScrollText } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PostDialog, type PostRow } from "@/components/post-dialog";
import { PageHeader } from "@/components/sidebar";
import { MockBadge, PlatformIcon, PostStatus } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState, Select } from "@/components/ui";
import { api, fmtDateTime, fmtRelative } from "@/lib/client";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

const TABS = [
  { key: "draft,queued,processing", label: "Actief" },
  { key: "draft", label: "Concept" },
  { key: "queued", label: "In wachtrij" },
  { key: "processing", label: "Bezig" },
  { key: "success", label: "Gepubliceerd" },
  { key: "failed,needs_reauth", label: "Mislukt" },
  { key: "cancelled", label: "Geannuleerd" },
];

type Log = { id: string; level: string; message: string; createdAt: string; postId: string | null; account: { handle: string; platform: string } | null };

function QueuePage() {
  const params = useSearchParams();
  const toast = useToast();
  const [tab, setTab] = useState(params.get("status") ?? TABS[0].key);
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<PostRow | null>(null);
  const [level, setLevel] = useState("");
  const order = tab === "success" || tab.startsWith("failed") || tab === "cancelled" ? "desc" : "asc";
  const { data, reload } = usePoll<{ posts: PostRow[] }>(`/api/posts?status=${tab}&order=${order}&limit=300`, 3000);
  const { data: q, reload: reloadStats } = usePoll<{ stats: Record<string, number> }>("/api/queue", 3000);
  const { data: logs } = usePoll<{ logs: Log[] }>(`/api/logs?limit=150${level ? `&level=${level}` : ""}`, 3000);
  const posts = data?.posts ?? [];

  const count = (key: string) => key.split(",").reduce((n, s) => n + (q?.stats[s] ?? 0), 0);
  const refresh = () => {
    reload();
    reloadStats();
  };

  async function bulk(action: "approve" | "cancel" | "retry") {
    try {
      const r = await api("/api/posts/bulk", { method: "POST", json: { ids: selected, action } });
      toast(`${r.count} post(s) bijgewerkt`);
      setSelected([]);
      refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <>
      <PageHeader
        title="Wachtrij & logs"
        description="Live status van alle publicaties. Ververst automatisch elke 3 seconden."
        actions={
          <Button
            onClick={async () => {
              const r = await api("/api/queue", { method: "POST" });
              toast(r.processed.length ? `${r.processed.length} verwerkt: ${r.processed.map((p: any) => p.outcome).join(", ")}` : "Niets aan de beurt");
              refresh();
            }}
          >
            <Play className="h-4 w-4" /> Nu verwerken
          </Button>
        }
      />

      <div className="scrollbar-thin mb-4 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setSelected([]); }}
            className={cn("flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium", tab === t.key ? "bg-white shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-900")}
          >
            {t.label}
            <Badge className={cn(t.key.startsWith("failed") && count(t.key) ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600")}>{count(t.key)}</Badge>
          </button>
        ))}
      </div>

      {selected.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2">
          <span className="text-sm font-medium">{selected.length} geselecteerd</span>
          <Button size="sm" onClick={() => bulk("approve")}><Check className="h-3.5 w-3.5" /> Goedkeuren</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("retry")}><RotateCcw className="h-3.5 w-3.5" /> Opnieuw</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("cancel")}><Ban className="h-3.5 w-3.5" /> Annuleren</Button>
        </div>
      )}

      <Card className="overflow-x-auto">
        {posts.length ? (
          <table className="w-full text-sm">
            <thead className="border-b bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" checked={selected.length === posts.length} onChange={() => setSelected(selected.length === posts.length ? [] : posts.map((p) => p.id))} />
                </th>
                <th className="px-3 py-2">Clip</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Gepland</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Pogingen</th>
                <th className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {posts.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(p)}>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.includes(p.id)} onChange={() => setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))} />
                  </td>
                  <td className="max-w-[260px] px-3 py-2">
                    <div className="truncate font-medium">{p.clip.title || p.clip.filename}</div>
                    <div className="truncate text-xs text-slate-500">{p.caption}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <PlatformIcon platform={p.platform} />
                      <span className="truncate">@{p.account.handle}</span>
                      {p.account.isMock && <MockBadge />}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <div>{fmtDateTime(p.scheduledAt)}</div>
                    <div className="text-xs text-slate-500">{fmtRelative(p.scheduledAt)}</div>
                  </td>
                  <td className="px-3 py-2"><PostStatus status={p.status} /></td>
                  <td className="px-3 py-2 tabular-nums">{p.attempts}/{p.maxAttempts}</td>
                  <td className="max-w-[280px] px-3 py-2 text-xs">
                    {p.status === "success" && p.externalUrl ? (
                      <a href={p.externalUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                        Bekijk post <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : p.lastError ? (
                      <span className={cn("line-clamp-2", p.status === "queued" ? "text-amber-700" : "text-red-600")}>
                        {p.status === "queued" && p.nextAttemptAt ? `Retry ${fmtRelative(p.nextAttemptAt)}: ` : ""}
                        {p.lastError}
                      </span>
                    ) : p.status === "draft" ? (
                      <span className="text-slate-500">Wacht op goedkeuring</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState icon={<ListChecks className="h-5 w-5" />} title="Geen posts met deze status" />
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={<span className="flex items-center gap-2"><ScrollText className="h-4 w-4" /> Logs</span>}
          action={
            <Select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">Alles</option>
              <option value="warn,error">Waarschuwingen & fouten</option>
              <option value="error">Alleen fouten</option>
            </Select>
          }
        />
        <div className="scrollbar-thin max-h-[420px] overflow-y-auto font-mono text-xs">
          {logs?.logs.map((l) => (
            <div key={l.id} className="flex gap-3 border-b border-slate-50 px-5 py-1.5">
              <span className="shrink-0 tabular-nums text-slate-400">{new Date(l.createdAt).toLocaleString("nl-NL")}</span>
              <span className={cn("w-12 shrink-0 font-semibold uppercase", { "text-red-600": l.level === "error", "text-amber-600": l.level === "warn", "text-slate-500": l.level === "info" })}>{l.level}</span>
              {l.account && <span className="shrink-0 text-slate-500">{l.account.platform}/@{l.account.handle}</span>}
              <span className="break-all">{l.message}</span>
            </div>
          ))}
          {!logs?.logs.length && <p className="px-5 py-6 text-slate-400">Nog geen logregels.</p>}
        </div>
      </Card>

      <PostDialog post={open} onClose={() => setOpen(null)} onChanged={refresh} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <QueuePage />
    </Suspense>
  );
}
