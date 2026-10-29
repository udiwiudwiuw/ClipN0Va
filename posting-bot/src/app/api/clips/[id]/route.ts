import fs from "node:fs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { normalizeHashtags } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const GET = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const clip = await prisma.clip.findUnique({ where: { id: params.id }, include: { posts: { include: { account: { select: { handle: true, platform: true } } } } } });
  if (!clip) throw new HttpError(404, "Clip niet gevonden");
  return NextResponse.json({ clip });
});

const Patch = z.object({
  title: z.string().max(300).optional(),
  caption: z.string().max(5000).optional(),
  hashtags: z.string().max(1000).optional(),
  campaign: z.string().max(100).nullable().optional(),
  creator: z.string().max(100).nullable().optional(),
  status: z.enum(["draft", "ready", "archived"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const body = Patch.parse(await req.json());
  if (body.hashtags !== undefined) body.hashtags = normalizeHashtags(body.hashtags);
  const clip = await prisma.clip.update({ where: { id: params.id }, data: body });
  return NextResponse.json({ clip });
});

export const DELETE = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const clip = await prisma.clip.findUnique({ where: { id: params.id }, include: { posts: { where: { status: "processing" } } } });
  if (!clip) throw new HttpError(404, "Clip niet gevonden");
  if (clip.posts.length) throw new HttpError(409, "Deze clip wordt nu gepubliceerd; probeer het zo opnieuw");
  await prisma.clip.delete({ where: { id: clip.id } });
  fs.rmSync(clip.filePath, { force: true });
  return NextResponse.json({ ok: true });
});
