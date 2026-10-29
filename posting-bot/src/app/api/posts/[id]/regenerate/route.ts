import { NextResponse } from "next/server";
import { generateCaption } from "@/lib/ai";
import { HttpError, handler } from "@/lib/api";
import type { Platform } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Nieuw AI-/sjabloonbijschrift voor één post (nieuwe variant). */
export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const post = await prisma.post.findUnique({ where: { id: params.id }, include: { clip: true, account: true } });
  if (!post) throw new HttpError(404, "Post niet gevonden");
  if (["success", "processing"].includes(post.status)) throw new HttpError(409, "Kan niet meer worden aangepast");
  const out = await generateCaption(post.clip, post.platform as Platform, {
    settings: await getSettings(),
    variantSeed: `${post.accountId}:${post.clipId}:${Date.now()}`,
    variantIndex: Math.floor(Math.random() * 10),
    accountHandle: post.account.handle,
  });
  const updated = await prisma.post.update({
    where: { id: post.id },
    data: { title: out.title, caption: out.caption, hashtags: out.hashtags, captionSource: out.source },
  });
  return NextResponse.json({ post: updated });
});
