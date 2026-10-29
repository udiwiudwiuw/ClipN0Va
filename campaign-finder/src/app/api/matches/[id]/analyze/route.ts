import { NextResponse } from "next/server";
import { analyzeMatch } from "@/lib/ai/analyze";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { serializeMatch } from "@/lib/matches";

export const dynamic = "force-dynamic";

export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  await analyzeMatch(params.id);
  const m = await prisma.campaignVideo.findUniqueOrThrow({ where: { id: params.id }, include: { video: true } });
  return NextResponse.json({ match: serializeMatch(m) });
});
