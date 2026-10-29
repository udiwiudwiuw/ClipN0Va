import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { exportRow, toCsv } from "@/lib/export";
import { findMatches } from "@/lib/matches";

export const dynamic = "force-dynamic";

/** Export van (standaard) goedgekeurde video's: ?format=csv|json&status=approved */
export const GET = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const q = new URL(req.url).searchParams;
  const format = q.get("format") === "json" ? "json" : "csv";
  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) throw new HttpError(404, "Campagne niet gevonden");
  const matches = await findMatches(params.id, { status: q.get("status") ?? "approved", sort: "match" }, 5000);
  const slug = campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "campagne";
  const filename = `${slug}-${q.get("status") ?? "approved"}-${new Date().toISOString().slice(0, 10)}.${format}`;
  const body =
    format === "json"
      ? JSON.stringify(
          {
            campagne: { id: campaign.id, naam: campaign.name, merk: campaign.brand },
            geexporteerd: new Date().toISOString(),
            toelichting: "Velden onder 'metadata' zijn feitelijk (bron: platform). Velden onder 'ai' zijn schattingen.",
            videos: matches.map((m) => ({
              metadata: { url: m.video.url, titel: m.video.title, kanaal: m.video.channelTitle, platform: m.video.platform, taal: m.video.language, duurSec: m.video.durationSec, views: m.video.viewCount, likes: m.video.likeCount, gepubliceerd: m.video.publishedAt, bron: m.video.source },
              status: m.status,
              ai: { matchScore: m.matchScore, clipScore: m.clipScore, oordeel: m.verdict, onderbouwing: m.reasoning, fragmenten: m.timestamps, overtredingen: m.violations, model: m.aiModel, geanalyseerd: m.analyzedAt },
              notities: m.notes,
            })),
          },
          null,
          2,
        )
      : toCsv(matches.map(exportRow));
  return new Response(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
