import { CampaignForm } from "@/components/campaign-form";
import { PageHeader } from "@/components/header";

export default function NewCampaign() {
  return (
    <>
      <PageHeader title="Nieuwe campagne" description="Na het aanmaken kun je direct zoeken." />
      <CampaignForm />
    </>
  );
}
