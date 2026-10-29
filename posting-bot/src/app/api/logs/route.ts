import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const where: Record<string, unknown> = {};
  if (q.get("level")) where.level = { in: q.get("level")!.split(",") };
  if (q.get("postId")) where.postId = q.get("postId");
  if (q.get("accountId")) where.accountId = q.get("accountId");
  const logs = await prisma.log.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Number(q.get("limit")) || 200, 1000),
    include: { account: { select: { handle: true, platform: true } } },
  });
  return NextResponse.json({ logs });
});

export const DELETE = handler(async () => {
  const { count } = await prisma.log.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
  return NextResponse.json({ deleted: count });
});
