import fs from "node:fs";
import { Readable } from "node:stream";
import { prisma } from "@/lib/db";
import { verifyMediaSignature } from "@/lib/media";

export const dynamic = "force-dynamic";

/**
 * Streamt een clip met Range-ondersteuning (nodig voor video-preview en
 * voor Instagram, dat de video via een ondertekende URL ophaalt).
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const url = new URL(req.url);
  // Met APP_PASSWORD laat de middleware alleen ondertekende verzoeken zonder login door.
  if (url.searchParams.has("sig") && !verifyMediaSignature(params.id, url.searchParams.get("expires"), url.searchParams.get("sig"))) {
    return new Response("Ongeldige of verlopen handtekening", { status: 403 });
  }
  const clip = await prisma.clip.findUnique({ where: { id: params.id } });
  if (!clip || !fs.existsSync(clip.filePath)) return new Response("Niet gevonden", { status: 404 });

  const size = fs.statSync(clip.filePath).size;
  const headers: Record<string, string> = {
    "Content-Type": clip.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? Number(range[1]) : 0;
    let end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!range[1] && range[2]) {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(clip.filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(clip.filePath)) as ReadableStream;
  return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
}
