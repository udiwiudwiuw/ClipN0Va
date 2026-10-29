import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { retryPost } from "@/lib/queue";

export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(z.string()).min(1), action: z.enum(["approve", "cancel", "retry", "delete"]) });

export const POST = handler(async (req: Request) => {
  const { ids, action } = Body.parse(await req.json());
  let count = 0;
  if (action === "approve") {
    ({ count } = await prisma.post.updateMany({ where: { id: { in: ids }, status: "draft" }, data: { status: "queued", approved: true } }));
  } else if (action === "cancel") {
    ({ count } = await prisma.post.updateMany({
      where: { id: { in: ids }, status: { in: ["draft", "queued", "failed", "needs_reauth"] } },
      data: { status: "cancelled", approved: false },
    }));
  } else if (action === "delete") {
    ({ count } = await prisma.post.deleteMany({ where: { id: { in: ids }, status: { not: "processing" } } }));
  } else {
    for (const id of ids) {
      try {
        await retryPost(id);
        count++;
      } catch {
        /* overslaan */
      }
    }
  }
  return NextResponse.json({ count });
});
