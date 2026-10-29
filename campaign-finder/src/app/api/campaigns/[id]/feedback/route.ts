import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const feedback = await prisma.feedback.findMany({
    where: { campaignId: params.id },
    orderBy: { createdAt: "desc" },
    include: { match: { select: { id: true, video: { select: { title: true, channelTitle: true } } } } },
  });
  return NextResponse.json({ feedback });
});

const Body = z.object({ kind: z.enum(["prefer", "avoid", "note"]), text: z.string().trim().min(1).max(1000) });

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { kind, text } = Body.parse(await req.json());
  const feedback = await prisma.feedback.create({ data: { campaignId: params.id, kind, text } });
  return NextResponse.json({ feedback }, { status: 201 });
});
