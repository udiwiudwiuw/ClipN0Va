"use client";

import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { nl } from "date-fns/locale";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { PostDialog, type PostRow } from "@/components/post-dialog";
import { PageHeader } from "@/components/sidebar";
import { PlatformIcon, PostStatus } from "@/components/status";
import { Button, Card, Select } from "@/components/ui";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

type View = "day" | "week" | "month";

const STATUS_BAR: Record<string, string> = {
  draft: "border-l-slate-400 bg-slate-50",
  queued: "border-l-blue-500 bg-blue-50",
  processing: "border-l-amber-500 bg-amber-50",
  success: "border-l-emerald-500 bg-emerald-50",
  failed: "border-l-red-500 bg-red-50",
  needs_reauth: "border-l-orange-500 bg-orange-50",
  cancelled: "border-l-slate-300 bg-slate-50 opacity-50",
};

function Chip({ p, onClick, compact }: { p: PostRow; onClick: () => void; compact?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-1.5 rounded border-l-4 px-1.5 py-1 text-left text-xs hover:brightness-95", STATUS_BAR[p.status])}>
      <PlatformIcon platform={p.platform} className="h-4 w-4" />
      <span className="shrink-0 font-medium tabular-nums">{format(new Date(p.scheduledAt), "HH:mm")}</span>
      <span className="truncate text-slate-600">{compact ? `@${p.account.handle}` : `${p.clip.title || p.clip.filename} · @${p.account.handle}`}</span>
    </button>
  );
}

export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [cursor, setCursor] = useState(() => new Date());
  const [account, setAccount] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<PostRow | null>(null);

  const range = useMemo(() => {
    if (view === "day") return { from: startOfDay(cursor), to: addDays(startOfDay(cursor), 1) };
    if (view === "week") {
      const from = startOfWeek(cursor, { weekStartsOn: 1 });
      return { from, to: addDays(from, 7) };
    }
    const from = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    return { from, to: addDays(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), 1) };
  }, [view, cursor]);

  const qs = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), ...(account ? { accountId: account } : {}) });
  const { data, reload } = usePoll<{ posts: PostRow[] }>(`/api/posts?${qs}`, 10000);
  const { data: acc } = usePoll<{ accounts: { id: string; handle: string; platform: string }[] }>("/api/accounts");
  const posts = (data?.posts ?? []).filter((p) => showCancelled || p.status !== "cancelled");
  const onDay = (d: Date) => posts.filter((p) => isSameDay(new Date(p.scheduledAt), d));

  const move = (dir: 1 | -1) => setCursor((c) => (view === "day" ? addDays(c, dir) : view === "week" ? addWeeks(c, dir) : addMonths(c, dir)));
  const label =
    view === "day"
      ? format(cursor, "EEEE d MMMM yyyy", { locale: nl })
      : view === "week"
        ? `${format(range.from, "d MMM", { locale: nl })} – ${format(addDays(range.to, -1), "d MMM yyyy", { locale: nl })}`
        : format(cursor, "MMMM yyyy", { locale: nl });

  const days = Array.from({ length: Math.round((range.to.getTime() - range.from.getTime()) / 86400_000) }, (_, i) => addDays(range.from, i));

  return (
    <>
      <PageHeader title="Kalender" description="Geplande en gepubliceerde posts. Tijden in jouw lokale tijdzone; klik op een post om te bewerken." />
      <Card className="mb-4 flex flex-wrap items-center gap-2 p-3">
        <Button size="icon" variant="outline" onClick={() => move(-1)} aria-label="Vorige"><ChevronLeft className="h-4 w-4" /></Button>
        <Button size="sm" variant="outline" onClick={() => setCursor(new Date())}>Vandaag</Button>
        <Button size="icon" variant="outline" onClick={() => move(1)} aria-label="Volgende"><ChevronRight className="h-4 w-4" /></Button>
        <span className="ml-2 font-semibold capitalize">{label}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> geannuleerd
          </label>
          <Select value={account} onChange={(e) => setAccount(e.target.value)}>
            <option value="">Alle accounts</option>
            {acc?.accounts.map((a) => <option key={a.id} value={a.id}>{a.platform} · @{a.handle}</option>)}
          </Select>
          <div className="flex rounded-lg border">
            {(["day", "week", "month"] as View[]).map((v) => (
              <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} onClick={() => setView(v)}>
                {{ day: "Dag", week: "Week", month: "Maand" }[v]}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {view === "month" && (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b bg-slate-50 text-center text-xs font-medium text-slate-500">
            {["ma", "di", "wo", "do", "vr", "za", "zo"].map((d) => <div key={d} className="py-2">{d}</div>)}
          </div>
          <div className="grid grid-cols-7">
            {days.map((d) => {
              const list = onDay(d);
              return (
                <div key={d.toISOString()} className={cn("min-h-[110px] border-b border-r p-1.5", !isSameMonth(d, cursor) && "bg-slate-50/60")}>
                  <button
                    onClick={() => { setCursor(d); setView("day"); }}
                    className={cn("mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs", isToday(d) ? "bg-brand-600 text-white" : "text-slate-500 hover:bg-slate-100")}
                  >
                    {format(d, "d")}
                  </button>
                  <div className="space-y-1">
                    {list.slice(0, 3).map((p) => <Chip key={p.id} p={p} compact onClick={() => setOpen(p)} />)}
                    {list.length > 3 && (
                      <button className="text-xs text-brand-600" onClick={() => { setCursor(d); setView("day"); }}>+{list.length - 3} meer</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {view === "week" && (
        <div className="grid gap-3 md:grid-cols-7">
          {days.map((d) => (
            <Card key={d.toISOString()} className={cn("min-h-[200px] p-2", isToday(d) && "ring-2 ring-brand-500")}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="text-xs font-medium uppercase text-slate-500">{format(d, "EEE", { locale: nl })}</span>
                <span className="text-lg font-semibold">{format(d, "d")}</span>
              </div>
              <div className="space-y-1">
                {onDay(d).map((p) => <Chip key={p.id} p={p} compact onClick={() => setOpen(p)} />)}
              </div>
            </Card>
          ))}
        </div>
      )}

      {view === "day" && (
        <Card>
          {Array.from({ length: 24 }, (_, h) => {
            const list = onDay(cursor).filter((p) => new Date(p.scheduledAt).getHours() === h);
            return (
              <div key={h} className="flex border-b last:border-0">
                <div className="w-16 shrink-0 border-r px-2 py-2 text-right text-xs tabular-nums text-slate-400">{String(h).padStart(2, "0")}:00</div>
                <div className="flex-1 space-y-1 p-1.5">
                  {list.map((p) => (
                    <button key={p.id} onClick={() => setOpen(p)} className={cn("flex w-full items-center gap-3 rounded border-l-4 px-3 py-2 text-left text-sm", STATUS_BAR[p.status])}>
                      <PlatformIcon platform={p.platform} />
                      <span className="font-medium tabular-nums">{format(new Date(p.scheduledAt), "HH:mm")}</span>
                      <span className="min-w-0 flex-1 truncate">{p.clip.title || p.clip.filename} <span className="text-slate-500">· @{p.account.handle}</span></span>
                      <PostStatus status={p.status} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {data && !posts.length && (
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-500"><CalendarDays className="h-4 w-4" /> Geen posts in deze periode.</p>
      )}
      <PostDialog post={open} onClose={() => setOpen(null)} onChanged={reload} />
    </>
  );
}
