"use client";

import { CampaignForm } from "@/components/campaign-form";
import { PageHeader } from "@/components/header";
import { Spinner } from "@/components/ui";
import type { Campaign } from "@/lib/types-ui";
import { usePoll } from "@/lib/use-poll";

export default function EditCampaign({ params }: { params: { id: string } }) {
  const { data, error } = usePoll<{ campaign: Campaign }>(`/api/campaigns/${params.id}`);
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return <Spinner />;
  return (
    <>
      <PageHeader title={`Bewerken: ${data.campaign.name}`} description="Wijzigingen gelden voor nieuwe analyses. Gebruik daarna “Herbeoordelen” op het dashboard." />
      <CampaignForm campaign={data.campaign} />
    </>
  );
}
