"use client";

import { Plus, Radar } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button, Card, EmptyState, Spinner } from "@/components/ui";
import type { Campaign } from "@/lib/types-ui";
import { usePoll } from "@/lib/use-poll";

/** Opent de laatst gebruikte (of eerste actieve) campagne. */
export default function Home() {
  const router = useRouter();
  const { data } = usePoll<{ campaigns: Campaign[] }>("/api/campaigns");
  useEffect(() => {
    if (!data?.campaigns.length) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem("finder:lastCampaign");
    } catch {}
    const target = data.campaigns.find((c) => c.id === last) ?? data.campaigns.find((c) => c.active) ?? data.campaigns[0];
    router.replace(`/campaigns/${target.id}`);
  }, [data, router]);

  if (!data || data.campaigns.length) {
    return (
      <div className="flex justify-center py-24 text-slate-400">
        <Spinner />
      </div>
    );
  }
  return (
    <Card className="mx-auto mt-10 max-w-xl">
      <EmptyState icon={<Radar className="h-5 w-5" />} title="Nog geen campagnes">
        <p>Maak een campagne aan met zoekwoorden, personen en regels. Zonder API-sleutels vult de demo-engine je dashboard met realistische testvideo&apos;s.</p>
        <p className="mt-2">
          Of laad demo-campagnes met <code className="rounded bg-slate-100 px-1">npm run db:seed</code>.
        </p>
        <Link href="/campaigns/new" className="mt-4 inline-block">
          <Button>
            <Plus className="h-4 w-4" /> Nieuwe campagne
          </Button>
        </Link>
      </EmptyState>
    </Card>
  );
}
