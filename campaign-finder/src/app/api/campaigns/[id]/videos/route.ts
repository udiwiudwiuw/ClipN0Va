import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { findMatches } from "@/lib/matches";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const q = new URL(req.url).searchParams;
  const matches = await findMatches(params.id, {
    status: q.get("status"),
    platform: q.get("platform"),
    language: q.get("language"),
    minScore: Number(q.get("minScore")) || null,
    minClipScore: Number(q.get("minClipScore")) || null,
    source: q.get("source"),
    q: q.get("q"),
    sort: q.get("sort"),
  });
  const langs = await prisma.video.findMany({ where: { matches: { some: { campaignId: params.id } }, language: { not: null } }, distinct: ["language"], select: { language: true } });
  return NextResponse.json({ matches, languages: langs.map((l) => l.language) });
});
