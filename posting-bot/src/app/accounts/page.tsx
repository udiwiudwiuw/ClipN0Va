"use client";

import { Clock, KeyRound, Link2, Pause, Play, Plus, RefreshCw, Unplug, Users } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader } from "@/components/sidebar";
import { AccountStatus, MockBadge, PlatformIcon } from "@/components/status";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Select } from "@/components/ui";
import { api, fmtDateTime, fmtRelative } from "@/lib/client";
import { PLATFORM_LABELS, type Platform } from "@/lib/constants";
import { usePoll } from "@/lib/use-poll";

type Account = {
  id: string;
  platform: Platform;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  isMock: boolean;
  timezone: string;
  postingTimes: string;
  dailyLimit: number;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  postCounts: Record<string, number>;
};

type Data = { accounts: Account[]; platforms: { platform: Platform; configured: boolean }[] };

const TIMEZONES: string[] = (() => {
  try {
    return (Intl as any).supportedValuesOf("timeZone");
  } catch {
    return ["Europe/Amsterdam", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"];
  }
})();

function ScheduleDialog({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ timezone: "", postingTimes: "", dailyLimit: 3, displayName: "" });
  useEffect(() => {
    if (account) setForm({ timezone: account.timezone, postingTimes: account.postingTimes, dailyLimit: account.dailyLimit, displayName: account.displayName });
  }, [account]);
  if (!account) return null;
  async function save() {
    try {
      await api(`/api/accounts/${account!.id}`, { method: "PATCH", json: form });
      toast("Planning opgeslagen");
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Planning — @${account.handle}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Annuleren</Button>
          <Button onClick={save}>Opslaan</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Weergavenaam">
          <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </Field>
        <Field label="Tijdzone" hint="Posttijden gelden in deze tijdzone (zomertijd wordt automatisch verwerkt).">
          <Select className="w-full" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {TIMEZONES.map((tz) => (
              <option key={tz}>{tz}</option>
            ))}
          </Select>
        </Field>
        <Field label="Vaste posttijden" hint="Kommagescheiden, bijv. 09:00,13:00,19:30. Automatisch plannen vult deze slots.">
          <Input value={form.postingTimes} onChange={(e) => setForm({ ...form, postingTimes: e.target.value })} />
        </Field>
        <Field label="Maximaal aantal posts per dag">
          <Input type="number" min={1} max={50} value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: Number(e.target.value) })} />
        </Field>
      </div>
    </Dialog>
  );
}

function AccountCard({ a, reload, onEdit }: { a: Account; reload: () => void; onEdit: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const pending = (a.postCounts.queued ?? 0) + (a.postCounts.draft ?? 0);
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start gap-3">
        {a.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 font-semibold uppercase text-slate-500">{a.handle[0]}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-semibold">{a.displayName}</span>
            {a.isMock && <MockBadge />}
          </div>
          <div className="truncate text-xs text-slate-500">@{a.handle}</div>
        </div>
        <AccountStatus status={a.status} />
      </div>

      {a.lastError && a.status !== "active" && <p className="mt-3 rounded-md bg-orange-50 px-2 py-1.5 text-xs text-orange-800">{a.lastError}</p>}

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-slate-500">Tijdzone</dt>
        <dd className="truncate">{a.timezone}</dd>
        <dt className="text-slate-500">Posttijden</dt>
        <dd>{a.postingTimes.replaceAll(",", ", ")}</dd>
        <dt className="text-slate-500">Per dag</dt>
        <dd>max. {a.dailyLimit}</dd>
        <dt className="text-slate-500">Token</dt>
        <dd title={a.tokenExpiresAt ? fmtDateTime(a.tokenExpiresAt) : ""}>{a.tokenExpiresAt ? `verloopt ${fmtRelative(a.tokenExpiresAt)}` : "—"}</dd>
        <dt className="text-slate-500">Posts</dt>
        <dd>
          {pending} gepland · {a.postCounts.success ?? 0} live
          {a.postCounts.failed ? <span className="text-red-600"> · {a.postCounts.failed} mislukt</span> : null}
        </dd>
      </dl>

      <div className="mt-4 flex flex-wrap gap-1.5 border-t pt-3">
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Clock className="h-3.5 w-3.5" /> Planning
        </Button>
        <Button
          size="sm"
          variant={a.status === "needs_reauth" ? "default" : "outline"}
          onClick={() => act(async () => router.push((await api(`/api/accounts/${a.id}/reauth`, { method: "POST" })).url), "Doorsturen naar autorisatie…")}
        >
          <KeyRound className="h-3.5 w-3.5" /> Herautoriseren
        </Button>
        <Button size="sm" variant="outline" title="Token nu verversen" onClick={() => act(() => api(`/api/accounts/${a.id}/refresh`, { method: "POST" }), "Token ververst")}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {a.status === "paused" ? (
          <Button size="sm" variant="outline" title="Hervatten" onClick={() => act(() => api(`/api/accounts/${a.id}`, { method: "PATCH", json: { status: "active" } }), "Account hervat")}>
            <Play className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            title="Pauzeren (geen publicaties)"
            onClick={() => act(() => api(`/api/accounts/${a.id}`, { method: "PATCH", json: { status: "paused" } }), "Account gepauzeerd")}
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-red-600 hover:bg-red-50"
          title="Ontkoppelen"
          onClick={() => {
            if (confirm(`@${a.handle} ontkoppelen? Tokens en alle posts van dit account worden verwijderd.`))
              act(() => api(`/api/accounts/${a.id}`, { method: "DELETE" }), "Account ontkoppeld");
          }}
        >
          <Unplug className="h-3.5 w-3.5" />
        </Button>
      </div>
      {a.isMock && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          <span className="text-slate-400">Test:</span>
          <button className="text-violet-700 hover:underline" onClick={() => act(() => api(`/api/accounts/${a.id}/simulate`, { method: "POST", json: { scenario: "expire_token" } }), "Token verlopen gezet — wordt bij de volgende upload ververst")}>
            token laten verlopen
          </button>
          <button className="text-violet-700 hover:underline" onClick={() => act(() => api(`/api/accounts/${a.id}/simulate`, { method: "POST", json: { scenario: "revoke" } }), "Autorisatie ingetrokken")}>
            autorisatie intrekken
          </button>
        </div>
      )}
    </Card>
  );
}

function AccountsPage() {
  const { data, reload } = usePoll<Data>("/api/accounts", 10000);
  const params = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<Account | null>(null);

  useEffect(() => {
    const err = params.get("error");
    const ok = params.get("connected");
    if (err) toast(err, "error");
    if (ok) toast("Account gekoppeld");
    if (err || ok) router.replace("/accounts");
  }, [params, router, toast]);

  return (
    <>
      <PageHeader title="Accounts" description="Koppel meerdere TikTok-, YouTube- en Instagram-accounts. Elk account heeft een eigen planning en tijdzone." />
      <div className="grid gap-8">
        {(data?.platforms ?? []).map(({ platform, configured }) => {
          const list = data!.accounts.filter((a) => a.platform === platform);
          return (
            <section key={platform}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <PlatformIcon platform={platform} className="h-7 w-7" />
                <h2 className="text-lg font-semibold">{PLATFORM_LABELS[platform]}</h2>
                <Badge className="bg-slate-100 text-slate-600">{list.length}</Badge>
                {!configured && <Badge className="bg-violet-100 text-violet-700">geen API-sleutels → mock</Badge>}
                <a href={`/api/oauth/${platform}/start`} className="ml-auto">
                  <Button size="sm">
                    <Plus className="h-3.5 w-3.5" /> {configured ? "Account koppelen" : "Mock-account koppelen"}
                  </Button>
                </a>
              </div>
              {list.length ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {list.map((a) => (
                    <AccountCard key={a.id} a={a} reload={reload} onEdit={() => setEditing(a)} />
                  ))}
                </div>
              ) : (
                <Card>
                  <EmptyState icon={<Link2 className="h-5 w-5" />} title={`Nog geen ${PLATFORM_LABELS[platform]}-accounts`}>
                    {configured
                      ? "Klik op “Account koppelen” en log in. Herhaal voor elk extra account."
                      : "Zonder API-sleutels wordt een gesimuleerd account aangemaakt, zodat je planning en wachtrij volledig kunt testen."}
                  </EmptyState>
                </Card>
              )}
            </section>
          );
        })}
        {data && !data.accounts.length && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Users className="h-4 w-4" /> Tip: koppel meerdere accounts per platform — de bot varieert bijschriften per account.
          </p>
        )}
      </div>
      <ScheduleDialog account={editing} onClose={() => setEditing(null)} onSaved={reload} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <AccountsPage />
    </Suspense>
  );
}
