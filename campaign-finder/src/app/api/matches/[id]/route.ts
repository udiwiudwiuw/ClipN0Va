import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { serializeMatch } from "@/lib/matches";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const m = await prisma.campaignVideo.findUnique({ where: { id: params.id }, include: { video: true } });
  if (!m) throw new HttpError(404, "Niet gevonden");
  return NextResponse.json({ match: serializeMatch(m), transcript: m.video.transcript ? JSON.parse(m.video.transcript) : null });
});

const Body = z.object({
  status: z.enum(["new", "approved", "rejected"]).optional(),
  /** Optionele reden; wordt feedback voor toekomstige scoring */
  reason: z.string().max(1000).optional(),
  notes: z.string().max(4000).optional(),
});

/** Status wijzigen. Goedkeuren/afwijzen wordt automatisch feedback voor deze campagne. */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const body = Body.parse(await req.json());
  const m = await prisma.campaignVideo.findUnique({ where: { id: params.id } });
  if (!m) throw new HttpError(404, "Niet gevonden");
  const updated = await prisma.$transaction(async (tx) => {
    if (body.status && body.status !== m.status) {
      // Eén beoordelings-feedback per video: vervang de vorige
      await tx.feedback.deleteMany({ where: { matchId: m.id, kind: { in: ["approve", "reject"] } } });
      if (body.status !== "new") {
        await tx.feedback.create({ data: { campaignId: m.campaignId, matchId: m.id, kind: body.status === "approved" ? "approve" : "reject", text: body.reason?.trim() ?? "" } });
      }
    }
    return tx.campaignVideo.update({
      where: { id: m.id },
      data: { ...(body.status ? { status: body.status } : {}), ...(body.notes !== undefined ? { notes: body.notes } : {}) },
      include: { video: true },
    });
  });
  return NextResponse.json({ match: serializeMatch(updated) });
});
