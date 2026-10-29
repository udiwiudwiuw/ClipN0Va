import { prisma } from "@/lib/db";
import { hashString } from "@/lib/utils";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Gegenereerde thumbnail (SVG) voor demo-video's — werkt offline. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const v = await prisma.video.findFirst({ where: { externalId: params.id }, select: { title: true, channelTitle: true } });
  const title = v?.title ?? "Demo video";
  const hue = hashString(params.id) % 360;
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last && (last + " " + w).length <= 26) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},70%,25%)"/></linearGradient></defs>
<rect width="480" height="270" fill="url(#g)"/>
<circle cx="420" cy="60" r="90" fill="white" opacity="0.08"/>
${lines.slice(0, 4).map((l, i) => `<text x="28" y="${70 + i * 40}" font-family="system-ui,sans-serif" font-size="30" font-weight="800" fill="white">${esc(l)}</text>`).join("")}
<text x="28" y="246" font-family="system-ui,sans-serif" font-size="16" fill="white" opacity="0.8">${esc(v?.channelTitle ?? "")} · DEMO</text>
</svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
}
