import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { enqueueSearch } from "@/lib/queue";
import { parseJson } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** Start een zoekronde (asynchroon); poll GET voor de voortgang. */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  await prisma.campaign.findUniqueOrThrow({ where: { id: params.id } });
  const { run, alreadyQueued } = await enqueueSearch(params.id, "manual");
  return NextResponse.json({ run, alreadyQueued }, { status: 202 });
});

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const runs = await prisma.searchRun.findMany({ where: { campaignId: params.id }, orderBy: { createdAt: "desc" }, take: 10 });
  return NextResponse.json({ runs: runs.map((r) => ({ ...r, log: parseJson<string[]>(r.log, []), sources: parseJson<string[]>(r.sources, []) })) });
});
