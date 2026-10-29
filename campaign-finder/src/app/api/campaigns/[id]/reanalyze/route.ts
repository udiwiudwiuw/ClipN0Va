import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeMatch, loadCampaignContext } from "@/lib/ai/analyze";
import { handler } from "@/lib/api";
import { analysisConcurrency } from "@/lib/config";
import { prisma } from "@/lib/db";
import { mapLimit } from "@/lib/utils";

export const dynamic = "force-dynamic";

const Body = z.object({ matchIds: z.array(z.string()).optional(), status: z.string().optional() });

/** Herbeoordeelt video's met de huidige regels + feedback (standaard: alle 'new'). */
export const POST = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const body = Body.parse(await req.json().catch(() => ({})));
  const matches = await prisma.campaignVideo.findMany({
    where: { campaignId: params.id, ...(body.matchIds ? { id: { in: body.matchIds } } : { status: body.status ?? "new" }) },
    select: { id: true },
  });
  const ctx = await loadCampaignContext(params.id);
  await mapLimit(matches, analysisConcurrency(), (m) => analyzeMatch(m.id, ctx));
  return NextResponse.json({ analyzed: matches.length });
});
