import { NextResponse } from "next/server";
import { z } from "zod";
import { generateCaption } from "@/lib/ai";
import { HttpError, handler } from "@/lib/api";
import { PLATFORMS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const Body = z.object({ clipId: z.string(), platform: z.enum(PLATFORMS) });

/** Genereert een voorbeeldbijschrift voor een clip (bijv. om in de bibliotheek over te nemen). */
export const POST = handler(async (req: Request) => {
  const { clipId, platform } = Body.parse(await req.json());
  const clip = await prisma.clip.findUnique({ where: { id: clipId } });
  if (!clip) throw new HttpError(404, "Clip niet gevonden");
  const out = await generateCaption(clip, platform, { settings: await getSettings(), variantSeed: `preview:${Date.now()}` });
  return NextResponse.json(out);
});
