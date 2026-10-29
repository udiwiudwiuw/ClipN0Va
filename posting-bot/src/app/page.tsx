"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, Film, FlaskConical, Play, RotateCcw, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageHeader } from "@/components/sidebar";
import { PlatformIcon, PostStatus } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader, EmptyState } from "@/components/ui";
import { api, fmtDateTime, fmtRelative } from "@/lib/client";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/constants";
import { usePoll } from "@/lib/use-poll";
import { formatBytes } from "@/lib/utils";

type Stats = {
  accounts: { platform: string; status: string; _count: { _all: number } }[];
  clips: { status: string; count: number; bytes: number }[];
  queue: Record<string, number>;
  upcoming: any[];
  failed: any[];
  publishedToday: number;
  mock: Record<string, boolean>;
  ai: boolean;
  worker: { started: string; lastTick?: string; lastError?: string } | null;
};

function Stat({ icon, label, value, sub, href }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; href: string }) {
  return (
    <Link href={href}>
      <Card className="p-5 transition-shadow hover:shadow-md">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          {icon}
          {label}
        </div>
        <div className="mt-2 text-3xl font-bold">{value}</div>
        {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
      </Card>
    </Link>
  );
}

export default function Overview() {
  const { data, reload } = usePoll<Stats>("/api/stats", 5000);
  const toast = useToast();
  const [running, setRunning] = useState(false);

  const totalAccounts = data?.accounts.reduce((n, a) => n + a._count._all, 0) ?? 0;
  const reauth = data?.accounts.filter((a) => a.status === "needs_reauth").reduce((n, a) => n + a._count._all, 0) ?? 0;
  const clips = data?.clips.filter((c) => c.status !== "archived") ?? [];
  const clipCount = clips.reduce((n, c) => n + c.count, 0);
  const anyMock = data ? Object.values(data.mock).some(Boolean) : false;

  async function runNow() {
    setRunning(true);
    try {
      const r = await api("/api/queue", { method: "POST" });
      toast(r.processed.length ? `${r.processed.length} post(s) verwerkt` : "Niets aan de beurt");
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Overzicht"
        description="Status van je accounts, bibliotheek en publicatiewachtrij."
        actions={
          <Button onClick={runNow} disabled={running}>
            <Play className="h-4 w-4" /> Wachtrij nu verwerken
          </Button>
        }
      />

      {anyMock && data && (
        <Card className="mb-6 flex items-start gap-3 border-violet-200 bg-violet-50 p-4 text-sm text-violet-900">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <b>Mock Publishing Mode</b> actief voor{" "}
            {PLATFORMS.filter((p) => data.mock[p]).map((p) => PLATFORM_LABELS[p]).join(", ")}. Koppelen en uploaden wordt lokaal gesimuleerd
            (met realistische API-responses en af en toe een tijdelijke fout om retries te testen). Vul API-sleutels in onder{" "}
            <Link href="/settings" className="underline">
              Instellingen
            </Link>{" "}
            om echt te publiceren.
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          href="/accounts"
          icon={<Users className="h-4 w-4" />}
          label="Gekoppelde accounts"
          value={totalAccounts}
          sub={reauth ? <span className="text-orange-600">{reauth} vraagt herautorisatie</span> : "Alles in orde"}
        />
        <Stat
          href="/library"
          icon={<Film className="h-4 w-4" />}
          label="Clips in bibliotheek"
          value={clipCount}
          sub={`${clips.find((c) => c.status === "ready")?.count ?? 0} klaar · ${formatBytes(clips.reduce((n, c) => n + c.bytes, 0))}`}
        />
        <Stat
          href="/calendar"
          icon={<CalendarClock className="h-4 w-4" />}
          label="Gepland"
          value={(data?.queue.queued ?? 0) + (data?.queue.draft ?? 0)}
          sub={`${data?.queue.draft ?? 0} wacht op goedkeuring`}
        />
        <Stat
          href="/queue"
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Gepubliceerd (24u)"
          value={data?.publishedToday ?? 0}
          sub={
            (data?.queue.failed ?? 0) + (data?.queue.needs_reauth ?? 0) ? (
              <span className="text-red-600">{(data?.queue.failed ?? 0) + (data?.queue.needs_reauth ?? 0)} mislukt / herautorisatie</span>
            ) : (
              `${data?.queue.success ?? 0} totaal`
            )
          }
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Eerstvolgende publicaties" action={<Link href="/calendar" className="text-sm text-brand-600">Kalender →</Link>} />
          {data?.upcoming.length ? (
            <ul className="divide-y">
              {data.upcoming.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <PlatformIcon platform={p.account.platform} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.clip.title || p.clip.filename}</div>
                    <div className="text-xs text-slate-500">
                      @{p.account.handle} · {fmtDateTime(p.scheduledAt, p.account.timezone)} ({fmtRelative(p.scheduledAt)})
                    </div>
                  </div>
                  <PostStatus status={p.status} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<CalendarClock className="h-5 w-5" />} title="Nog niets gepland">
              Selecteer clips in de <Link href="/library" className="text-brand-600">bibliotheek</Link> en kies “Inplannen”.
            </EmptyState>
          )}
        </Card>

        <Card>
          <CardHeader title="Mislukt & herautorisatie" action={<Link href="/queue?status=failed,needs_reauth" className="text-sm text-brand-600">Wachtrij →</Link>} />
          {data?.failed.length ? (
            <ul className="divide-y">
              {data.failed.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                  <PlatformIcon platform={p.account.platform} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.clip.title || p.clip.filename}</div>
                    <div className="truncate text-xs text-red-600">{p.lastError}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await api(`/api/posts/${p.id}/retry`, { method: "POST" });
                        toast("Opnieuw in de wachtrij");
                        reload();
                      } catch (e) {
                        toast((e as Error).message, "error");
                      }
                    }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Opnieuw
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Geen mislukte taken" />
          )}
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <Badge className={data?.worker ? "bg-emerald-100 text-emerald-700" : "bg-slate-100"}>
          Worker {data?.worker ? `actief · laatste ronde ${data.worker.lastTick ? fmtRelative(data.worker.lastTick) : "—"}` : "niet gestart"}
        </Badge>
        <Badge className={data?.ai ? "bg-brand-100 text-brand-700" : "bg-slate-100"}>
          <Sparkles className="h-3 w-3" /> {data?.ai ? "OpenAI bijschriften" : "Sjabloon-bijschriften (geen OpenAI-sleutel)"}
        </Badge>
        {data?.worker?.lastError && (
          <Badge className="bg-red-100 text-red-700">
            <AlertTriangle className="h-3 w-3" /> {data.worker.lastError}
          </Badge>
        )}
      </div>
    </>
  );
}
