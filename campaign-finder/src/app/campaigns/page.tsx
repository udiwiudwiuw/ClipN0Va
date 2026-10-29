"use client";

import { Clock, Pencil, Plus, Radar } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/header";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { api, fmtRelative } from "@/lib/client";
import type { Campaign } from "@/lib/types-ui";
import { usePoll } from "@/lib/use-poll";
import { splitList } from "@/lib/utils";

export default function CampaignsPage() {
  const { data, reload } = usePoll<{ campaigns: Campaign[] }>("/api/campaigns");
  const toast = useToast();
  return (
    <>
      <PageHeader
        title="Campagnes"
        description="Beheer je clipcampagnes, hun zoekopdrachten en regels."
        actions={
          <Link href="/campaigns/new">
            <Button>
              <Plus className="h-4 w-4" /> Nieuwe campagne
            </Button>
          </Link>
        }
      />
      {data && !data.campaigns.length && (
        <Card>
          <EmptyState icon={<Radar className="h-5 w-5" />} title="Nog geen campagnes" />
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.campaigns.map((c) => (
          <Card key={c.id} className={c.active ? "" : "opacity-60"}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/campaigns/${c.id}`} className="font-semibold hover:text-brand-700">
                    {c.name}
                  </Link>
                  <div className="text-sm text-slate-500">{c.brand || "—"} · {c.language.toUpperCase()}</div>
                </div>
                <label className="flex items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={c.active}
                    onChange={async (e) => {
                      try {
                        await api(`/api/campaigns/${c.id}`, { method: "PATCH", json: { active: e.target.checked } });
                        reload();
                      } catch (err) {
                        toast((err as Error).message, "error");
                      }
                    }}
                  />
                  actief
                </label>
              </div>
              {c.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{c.description}</p>}
              <div className="mt-3 flex flex-wrap gap-1">
                {splitList(c.keywords).slice(0, 6).map((k) => (
                  <Badge key={k} className="bg-slate-100 text-slate-700">{k}</Badge>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-lg bg-slate-50 py-2"><div className="text-lg font-semibold">{c.counts?.new ?? 0}</div>nieuw</div>
                <div className="rounded-lg bg-emerald-50 py-2 text-emerald-800"><div className="text-lg font-semibold">{c.counts?.approved ?? 0}</div>goedgekeurd</div>
                <div className="rounded-lg bg-red-50 py-2 text-red-800"><div className="text-lg font-semibold">{c.counts?.rejected ?? 0}</div>afgewezen</div>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t px-5 py-3 text-xs text-slate-500">
              <Clock className="h-3.5 w-3.5" />
              {c.lastSearchedAt ? `gezocht ${fmtRelative(c.lastSearchedAt)}` : "nog niet gezocht"}
              {c.searchIntervalHours > 0 && <Badge className="bg-brand-50 text-brand-700">auto elke {c.searchIntervalHours}u</Badge>}
              <Link href={`/campaigns/${c.id}/edit`} className="ml-auto">
                <Button size="sm" variant="ghost">
                  <Pencil className="h-3.5 w-3.5" /> Bewerken
                </Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
