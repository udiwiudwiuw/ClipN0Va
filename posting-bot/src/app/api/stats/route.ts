import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { queueStats } from "@/lib/queue";
import { getSettings, platformConfigured } from "@/lib/settings";
import { PLATFORMS } from "@/lib/constants";
import { workerState } from "@/lib/worker";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86400_000);
  const [accounts, clipGroups, queue, upcoming, failed, publishedToday, settings] = await Promise.all([
    prisma.account.groupBy({ by: ["platform", "status"], _count: { _all: true } }),
    prisma.clip.groupBy({ by: ["status"], _count: { _all: true }, _sum: { sizeBytes: true } }),
    queueStats(),
    prisma.post.findMany({
      where: { status: { in: ["queued", "draft"] }, scheduledAt: { gte: now } },
      orderBy: { scheduledAt: "asc" },
      take: 8,
      include: { clip: { select: { title: true, filename: true } }, account: { select: { handle: true, platform: true, timezone: true } } },
    }),
    prisma.post.findMany({
      where: { status: { in: ["failed", "needs_reauth"] } },
      orderBy: { updatedAt: "desc" },
      take: 8,
      include: { clip: { select: { title: true, filename: true } }, account: { select: { handle: true, platform: true } } },
    }),
    prisma.post.count({ where: { status: "success", publishedAt: { gte: dayAgo } } }),
    getSettings(),
  ]);
  return NextResponse.json({
    accounts,
    clips: clipGroups.map((g) => ({ status: g.status, count: g._count._all, bytes: g._sum.sizeBytes ?? 0 })),
    queue,
    upcoming,
    failed,
    publishedToday,
    mock: Object.fromEntries(PLATFORMS.map((p) => [p, !platformConfigured(settings, p)])),
    ai: Boolean(settings.OPENAI_API_KEY),
    worker: workerState(),
  });
});
