import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, handler } from "@/lib/api";
import { importFromClipnova, importFromFolder } from "@/lib/importers";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const Body = z.object({
  source: z.enum(["folder", "clipnova"]),
  path: z.string().optional(),
  campaign: z.string().optional(),
  creator: z.string().optional(),
});

export const POST = handler(async (req: Request) => {
  const body = Body.parse(await req.json());
  const s = await getSettings();
  const meta = { campaign: body.campaign || null, creator: body.creator || null };
  if (body.source === "folder") {
    return NextResponse.json(await importFromFolder(body.path || s.IMPORT_DIR, meta));
  }
  const dir = body.path || s.CLIPNOVA_STORAGE_DIR;
  if (!dir) throw new HttpError(400, "Stel eerst de ClipNova storage-map in (Instellingen of CLIPNOVA_STORAGE_DIR)");
  return NextResponse.json(await importFromClipnova(dir, meta));
});
