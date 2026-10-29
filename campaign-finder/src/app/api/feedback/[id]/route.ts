import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { active } = z.object({ active: z.boolean() }).parse(await req.json());
  return NextResponse.json({ feedback: await prisma.feedback.update({ where: { id: params.id }, data: { active } }) });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  await prisma.feedback.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
});
