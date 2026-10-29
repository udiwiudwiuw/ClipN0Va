import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { CampaignInput, toDb } from "@/lib/campaign-schema";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const campaigns = await prisma.campaign.findMany({ orderBy: [{ active: "desc" }, { createdAt: "desc" }] });
  const counts = await prisma.campaignVideo.groupBy({ by: ["campaignId", "status"], _count: { _all: true } });
  const per: Record<string, Record<string, number>> = {};
  for (const c of counts) (per[c.campaignId] ??= {})[c.status] = c._count._all;
  return NextResponse.json({ campaigns: campaigns.map((c) => ({ ...c, counts: per[c.id] ?? {} })) });
});

export const POST = handler(async (req: Request) => {
  const input = CampaignInput.parse(await req.json());
  const campaign = await prisma.campaign.create({ data: toDb(input) as any });
  return NextResponse.json({ campaign }, { status: 201 });
});
