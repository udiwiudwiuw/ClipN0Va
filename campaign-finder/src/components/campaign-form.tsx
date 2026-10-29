"use client";

import { Plus, Save, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/toast";
import { Button, Card, CardHeader, Field, Input, Select, Spinner, Textarea } from "@/components/ui";
import { api } from "@/lib/client";
import type { Campaign } from "@/lib/types-ui";

const LANGUAGES = [
  ["nl", "Nederlands"],
  ["en", "Engels"],
  ["de", "Duits"],
  ["fr", "Frans"],
  ["es", "Spaans"],
];

type Form = Omit<Campaign, "id" | "createdAt" | "lastSearchedAt" | "counts" | "sources" | "minMinutes" | "maxMinutes"> & {
  sources: string[];
  minMinutes: string;
  maxMinutes: string;
};

const EMPTY: Form = {
  name: "",
  brand: "",
  description: "",
  audience: "",
  sources: [],
  keywords: "",
  people: "",
  topics: "",
  language: "nl",
  minMinutes: "",
  maxMinutes: "",
  rules: "",
  usageRights: "",
  excludedTopics: "",
  active: true,
  searchIntervalHours: 0,
};

export function CampaignForm({ campaign }: { campaign?: Campaign }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [newSource, setNewSource] = useState("");
  const [f, setF] = useState<Form>(() =>
    campaign
      ? {
          ...EMPTY,
          ...campaign,
          sources: JSON.parse(campaign.sources || "[]"),
          minMinutes: campaign.minMinutes?.toString() ?? "",
          maxMinutes: campaign.maxMinutes?.toString() ?? "",
        }
      : EMPTY,
  );
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const bind = (k: keyof Form) => ({
    value: String(f[k] ?? ""),
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set({ [k]: e.target.value } as Partial<Form>),
  });

  function addSource() {
    const parts = newSource.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    set({ sources: [...new Set([...f.sources, ...parts])] });
    setNewSource("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, searchIntervalHours: Number(f.searchIntervalHours) || 0 };
      const r = campaign
        ? await api(`/api/campaigns/${campaign.id}`, { method: "PATCH", json: body })
        : await api("/api/campaigns", { method: "POST", json: body });
      toast(campaign ? "Campagne opgeslagen" : "Campagne aangemaakt");
      router.push(`/campaigns/${r.campaign.id}`);
      router.refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!campaign || !confirm(`Campagne "${campaign.name}" verwijderen, inclusief alle beoordelingen en feedback?`)) return;
    try {
      await api(`/api/campaigns/${campaign.id}`, { method: "DELETE" });
      try {
        localStorage.removeItem("finder:lastCampaign");
      } catch {}
      toast("Campagne verwijderd");
      router.push("/campaigns");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Basis" description="Wie en voor wie" />
        <div className="grid gap-4 p-5">
          <Field label="Campagnenaam *">
            <Input required {...bind("name")} placeholder="Bijv. Podcast Zomer 2026" />
          </Field>
          <Field label="Merk / creator / streamer">
            <Input {...bind("brand")} />
          </Field>
          <Field label="Beschrijving">
            <Textarea rows={3} {...bind("description")} placeholder="Wat wil de campagne bereiken?" />
          </Field>
          <Field label="Doelgroep">
            <Textarea rows={2} {...bind("audience")} placeholder="Bijv. 18-34, geïnteresseerd in ondernemen" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Taal">
              <Select className="w-full" {...bind("language")}>
                {LANGUAGES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            </Field>
            <Field label="Automatisch zoeken" hint="0 = alleen handmatig">
              <Select className="w-full" {...bind("searchIntervalHours")}>
                <option value="0">Uit</option>
                <option value="1">Elk uur</option>
                <option value="6">Elke 6 uur</option>
                <option value="12">Elke 12 uur</option>
                <option value="24">Dagelijks</option>
                <option value="168">Wekelijks</option>
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /> Campagne actief
          </label>
        </div>
      </Card>

      <Card>
        <CardHeader title="Zoeken" description="Waar en waarop wordt gezocht" />
        <div className="grid gap-4 p-5">
          <Field label="Toegestane videobronnen" hint="YouTube-kanaal-URL's (…/channel/UC… of …/@handle) of losse video-URL's. Leeg = heel YouTube.">
            <div className="flex gap-2">
              <Input
                value={newSource}
                onChange={(e) => setNewSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSource();
                  }
                }}
                placeholder="https://www.youtube.com/@kanaal"
              />
              <Button type="button" variant="outline" onClick={addSource}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            {f.sources.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {f.sources.map((s) => (
                  <li key={s} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs">
                    <span className="max-w-[260px] truncate">{s}</span>
                    <button type="button" onClick={() => set({ sources: f.sources.filter((x) => x !== s) })} className="rounded-full p-0.5 hover:bg-slate-200" aria-label="Verwijderen">
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <Field label="Zoekwoorden" hint="Kommagescheiden">
            <Input {...bind("keywords")} placeholder="podcast, ondernemen, geld" />
          </Field>
          <Field label="Relevante personen" hint="Kommagescheiden">
            <Input {...bind("people")} />
          </Field>
          <Field label="Onderwerpen" hint="Kommagescheiden">
            <Input {...bind("topics")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min. lengte (minuten)">
              <Input type="number" min={0} step="any" {...bind("minMinutes")} />
            </Field>
            <Field label="Max. lengte (minuten)">
              <Input type="number" min={0} step="any" {...bind("maxMinutes")} />
            </Field>
          </div>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Regels & rechten" description="Wordt letterlijk aan de AI meegegeven bij het scoren" />
        <div className="grid gap-4 p-5 md:grid-cols-3">
          <Field label="Campagneregels">
            <Textarea rows={5} {...bind("rules")} placeholder="Bijv. alleen clips waarin de host zelf spreekt; geen fragmenten met reclame van concurrenten." />
          </Field>
          <Field label="Gebruiksrechten">
            <Textarea rows={5} {...bind("usageRights")} placeholder="Bijv. alleen eigen kanaal en officiële partners; vermeld altijd de bron." />
          </Field>
          <Field label="Uitgesloten onderwerpen" hint="Kommagescheiden; leidt tot een lage score">
            <Textarea rows={5} {...bind("excludedTopics")} placeholder="gokken, politiek, crypto" />
          </Field>
        </div>
      </Card>

      <div className="flex gap-2 lg:col-span-2">
        {campaign && (
          <Button type="button" variant="ghost" className="text-red-600 hover:bg-red-50" onClick={remove}>
            <Trash2 className="h-4 w-4" /> Verwijderen
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>
            Annuleren
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : <Save className="h-4 w-4" />} {campaign ? "Opslaan" : "Campagne aanmaken"}
          </Button>
        </div>
      </div>
    </form>
  );
}
