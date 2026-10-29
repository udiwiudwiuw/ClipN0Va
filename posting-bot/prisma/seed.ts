/**
 * Demo-data: mock-accounts op alle platforms, een paar testclips (als ffmpeg
 * beschikbaar is) en een gevulde planning. Uitvoeren: `npm run db:seed`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveConnectedProfile } from "../src/lib/accounts";
import { prisma } from "../src/lib/db";
import { importFile } from "../src/lib/importers";
import { mockProfile } from "../src/lib/platforms/mock";
import { schedulePosts } from "../src/lib/scheduler";

const ACCOUNTS = [
  { platform: "tiktok", hint: "clipnova" },
  { platform: "tiktok", hint: "dailyclips" },
  { platform: "youtube", hint: "clipnova" },
  { platform: "instagram", hint: "reelroom" },
] as const;

const CLIPS = [
  { title: "Hij gaf eindelijk het eerlijke antwoord", caption: "Niemand zag dit aankomen", hashtags: "#podcast #eerlijk", color: "0x7c5cff" },
  { title: "De beste tip voor beginners", caption: "Sla deze op voor later", hashtags: "#tips #ondernemen", color: "0xe11d48" },
  { title: "Dit ging helemaal mis", caption: "Live op de radio…", hashtags: "#fail #radio", color: "0x0891b2" },
  { title: "Waarom niemand dit vertelt", caption: "Het geheim achter de cijfers", hashtags: "#geld #sparen", color: "0x16a34a" },
  { title: "Reactie van het publiek", caption: "Kippenvel", hashtags: "#live #publiek", color: "0xea580c" },
  { title: "In 30 seconden uitgelegd", caption: "Kort en krachtig", hashtags: "#uitleg #snel", color: "0x334155" },
];

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (await prisma.account.count()) {
    console.log("Database bevat al accounts — seed overgeslagen. (Leeg maken: npx prisma db push --force-reset)");
    return;
  }

  const accounts = [];
  for (const a of ACCOUNTS) {
    accounts.push(await saveConnectedProfile(a.platform, mockProfile(a.platform, a.hint), true));
  }
  console.log(`✔ ${accounts.length} mock-accounts gekoppeld`);

  if (!hasFfmpeg()) {
    console.log("! ffmpeg niet gevonden — geen demo-clips aangemaakt. Upload zelf video's via de Videobibliotheek.");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipnova-seed-"));
  const clipIds: string[] = [];
  for (const [i, c] of CLIPS.entries()) {
    const out = path.join(tmp, `demo_clip_${i + 1}.mp4`);
    execFileSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${c.color}:s=360x640:d=6:r=24`, "-f", "lavfi", "-i", "testsrc2=s=200x200:d=6:r=24",
        "-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
      { stdio: "ignore" },
    );
    const r = await importFile(out, { source: "upload", meta: { ...c, campaign: i < 3 ? "Podcast Zomer" : "Tips & Tricks", creator: i % 2 ? "Sam" : "Noor", durationSec: 6 }, moveFile: true });
    clipIds.push(r.clipId);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`✔ ${clipIds.length} demo-clips aangemaakt`);

  // Eerste 3 clips: goedgekeurd op alle accounts; rest als concept.
  const a = await schedulePosts({ clipIds: clipIds.slice(0, 3), accountIds: accounts.map((x) => x.id), mode: "auto", generateCaptions: true, approve: true });
  const b = await schedulePosts({ clipIds: clipIds.slice(3, 5), accountIds: accounts.slice(0, 2).map((x) => x.id), mode: "auto", generateCaptions: true, approve: false });
  // Eén post die over een minuut live gaat, zodat je de worker direct ziet werken.
  const c = await schedulePosts({ clipIds: [clipIds[5]], accountIds: [accounts[0].id], mode: "at", at: new Date(Date.now() + 60_000), approve: true });
  console.log(`✔ ${a.created + b.created + c.created} posts gepland (${b.created} als concept)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
