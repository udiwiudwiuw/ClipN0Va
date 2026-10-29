import { NextResponse } from "next/server";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { processDuePosts } from "@/lib/queue";

export const dynamic = "force-dynamic";

/** Keurt goed en publiceert direct (wacht op het resultaat). */
export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const post = await prisma.post.findUnique({ where: { id: params.id } });
  if (!post) throw new HttpError(404, "Post niet gevonden");
  if (["success", "processing"].includes(post.status)) throw new HttpError(409, `Post is al ${post.status}`);
  await prisma.post.update({
    where: { id: post.id },
    data: { status: "queued", approved: true, scheduledAt: new Date(), nextAttemptAt: null, attempts: post.status === "queued" ? post.attempts : 0 },
  });
  const res = await processDuePosts({ postIds: [post.id], limit: 1 });
  const outcome = res.processed[0]?.outcome ?? "waiting";
  return NextResponse.json({ outcome, post: await prisma.post.findUnique({ where: { id: post.id } }) });
});
