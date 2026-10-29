import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handler } from "@/lib/api";
import { CampaignInput, toDb } from "@/lib/campaign-schema";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

const QuickPatch = z.object({ active: z.boolean().optional(), searchIntervalHours: z.number().int().min(0).max(720).optional() }).strict();

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) throw new HttpError(404, "Campagne niet gevonden");
  return NextResponse.json({ campaign });
});

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const body = await req.json();
  // Volledig formulier (met naam) of snelle schakelaar (alleen active/interval)
  const data = "name" in body ? toDb(CampaignInput.parse(body)) : QuickPatch.parse(body);
  const campaign = await prisma.campaign.update({ where: { id: params.id }, data: data as any });
  return NextResponse.json({ campaign });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  await prisma.campaign.delete({ where: { id: params.id } });
  // Video's zonder campagne opruimen
  await prisma.video.deleteMany({ where: { matches: { none: {} } } });
  return NextResponse.json({ ok: true });
});
