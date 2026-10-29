import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { normalizeHashtags } from "@/lib/utils";

export const dynamic = "force-dynamic";

const Patch = z.object({
  title: z.string().max(300).optional(),
  caption: z.string().max(5000).optional(),
  hashtags: z.string().max(1000).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  /** approve → queued, unapprove → draft, cancel → cancelled */
  action: z.enum(["approve", "unapprove", "cancel"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const body = Patch.parse(await req.json());
  const post = await prisma.post.findUnique({ where: { id: params.id } });
  if (!post) throw new HttpError(404, "Post niet gevonden");
  if (post.status === "processing" || post.status === "success") {
    throw new HttpError(409, post.status === "success" ? "Al gepubliceerd — niet meer aan te passen" : "Wordt nu verwerkt");
  }
  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.caption !== undefined) data.caption = body.caption;
  if (body.hashtags !== undefined) data.hashtags = normalizeHashtags(body.hashtags);
  if (body.title !== undefined || body.caption !== undefined || body.hashtags !== undefined) data.captionSource = "manual";
  if (body.scheduledAt) data.scheduledAt = new Date(body.scheduledAt);
  if (body.action === "approve") Object.assign(data, { approved: true, status: "queued", nextAttemptAt: null });
  if (body.action === "unapprove") Object.assign(data, { approved: false, status: "draft" });
  if (body.action === "cancel") Object.assign(data, { status: "cancelled", approved: false });
  // Statuswijziging alleen als de post intussen niet door de worker is geclaimd.
  const { count } = await prisma.post.updateMany({ where: { id: post.id, status: post.status }, data });
  if (!count) throw new HttpError(409, "De post is intussen gewijzigd; vernieuw de pagina");
  return NextResponse.json({ post: await prisma.post.findUnique({ where: { id: post.id } }) });
});

export const DELETE = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const { count } = await prisma.post.deleteMany({ where: { id: params.id, status: { not: "processing" } } });
  if (!count) throw new HttpError(409, "Niet gevonden of wordt nu verwerkt");
  return NextResponse.json({ ok: true });
});
