import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { importUpload } from "@/lib/importers";

export const dynamic = "force-dynamic";

export const GET = handler(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const search = q.get("q")?.trim();
  const where: Record<string, unknown> = {};
  if (q.get("status")) where.status = q.get("status");
  else where.status = { not: "archived" };
  if (q.get("campaign")) where.campaign = q.get("campaign");
  if (q.get("creator")) where.creator = q.get("creator");
  if (q.get("source")) where.source = q.get("source");
  if (search) where.OR = [{ title: { contains: search } }, { caption: { contains: search } }, { filename: { contains: search } }, { hashtags: { contains: search } }];

  const [clips, campaigns, creators] = await Promise.all([
    prisma.clip.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { posts: { select: { id: true, status: true, platform: true, accountId: true, scheduledAt: true } } },
      take: 500,
    }),
    prisma.clip.findMany({ where: { campaign: { not: null } }, distinct: ["campaign"], select: { campaign: true } }),
    prisma.clip.findMany({ where: { creator: { not: null } }, distinct: ["creator"], select: { creator: true } }),
  ]);
  return NextResponse.json({
    clips,
    campaigns: campaigns.map((c) => c.campaign).filter(Boolean),
    creators: creators.map((c) => c.creator).filter(Boolean),
  });
});

/** Upload één of meer clips (multipart: files[], campaign, creator). */
export const POST = handler(async (req: Request) => {
  const fd = await req.formData();
  const files = fd.getAll("files").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  const meta = {
    campaign: (fd.get("campaign") as string) || null,
    creator: (fd.get("creator") as string) || null,
    hashtags: (fd.get("hashtags") as string) || "",
  };
  const result = { imported: 0, duplicates: 0, errors: [] as { file: string; error: string }[], clipIds: [] as string[] };
  for (const f of files) {
    try {
      const r = await importUpload(f, meta);
      if (r.duplicate) result.duplicates++;
      else {
        result.imported++;
        result.clipIds.push(r.clipId);
      }
    } catch (err) {
      result.errors.push({ file: f.name, error: (err as Error).message });
    }
  }
  return NextResponse.json(result);
});
