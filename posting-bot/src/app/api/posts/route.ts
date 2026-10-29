import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { schedulePosts } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const where: Record<string, unknown> = {};
  const status = q.get("status");
  if (status) where.status = { in: status.split(",") };
  if (q.get("accountId")) where.accountId = q.get("accountId");
  if (q.get("platform")) where.platform = q.get("platform");
  if (q.get("clipId")) where.clipId = q.get("clipId");
  const from = q.get("from");
  const to = q.get("to");
  if (from || to) where.scheduledAt = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(to) } : {}) };
  const posts = await prisma.post.findMany({
    where,
    orderBy: { scheduledAt: q.get("order") === "desc" ? "desc" : "asc" },
    take: Math.min(Number(q.get("limit")) || 500, 2000),
    include: {
      clip: { select: { id: true, filename: true, title: true, campaign: true, creator: true } },
      account: { select: { id: true, handle: true, displayName: true, platform: true, timezone: true, isMock: true, status: true } },
    },
  });
  return NextResponse.json({ posts });
});

const Schedule = z.object({
  clipIds: z.array(z.string()).min(1),
  accountIds: z.array(z.string()).min(1),
  mode: z.enum(["auto", "at"]).default("auto"),
  at: z.string().optional(),
  spacingMinutes: z.number().int().min(0).max(10080).optional(),
  generateCaptions: z.boolean().optional(),
  approve: z.boolean().optional(),
});

export const POST = handler(async (req: Request) => {
  const body = Schedule.parse(await req.json());
  return NextResponse.json(await schedulePosts(body));
});
