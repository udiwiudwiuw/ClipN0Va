import { NextResponse } from "next/server";
import { publicAccount } from "@/lib/accounts";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { PLATFORMS } from "@/lib/constants";
import { getSettings, platformConfigured } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const [accounts, settings] = await Promise.all([
    prisma.account.findMany({ orderBy: [{ platform: "asc" }, { createdAt: "asc" }], include: { _count: { select: { posts: true } } } }),
    getSettings(),
  ]);
  const counts = await prisma.post.groupBy({ by: ["accountId", "status"], _count: { _all: true } });
  const perAccount: Record<string, Record<string, number>> = {};
  for (const c of counts) (perAccount[c.accountId] ??= {})[c.status] = c._count._all;
  return NextResponse.json({
    accounts: accounts.map((a) => ({ ...publicAccount(a), postCounts: perAccount[a.id] ?? {} })),
    platforms: PLATFORMS.map((p) => ({ platform: p, configured: platformConfigured(settings, p) })),
  });
});
