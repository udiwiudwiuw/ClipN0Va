import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { importFromClipnova, importFromFolder } from "@/lib/importers";
import { resetDb } from "./helpers";

beforeEach(resetDb);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clipnova-test-"));
}

describe("ClipNova-import", () => {
  it("leest job.json en neemt titel, bijschrift en hashtags over; dubbele imports worden overgeslagen", async () => {
    const root = tmpDir();
    const job = path.join(root, "job123");
    fs.mkdirSync(job);
    fs.writeFileSync(
      path.join(job, "job.json"),
      JSON.stringify({
        status: "done",
        clips: [
          { id: "aaaa1111", start: 10, end: 42.5, title: "Grote onthulling", caption: "Dit moet je zien", hashtags: ["podcast", "#nl"] },
          { id: "bbbb2222", start: 50, end: 80, title: "Tweede", caption: "", hashtags: [] },
          { id: "cccc3333", title: "Zonder video" },
        ],
      }),
    );
    fs.writeFileSync(path.join(job, "clip_aaaa1111.mp4"), crypto.randomBytes(1000));
    fs.writeFileSync(path.join(job, "clip_bbbb2222.mp4"), crypto.randomBytes(1000));

    const r = await importFromClipnova(root, { campaign: "Zomer" });
    expect(r.imported).toBe(2);
    const clip = await prisma.clip.findFirstOrThrow({ where: { sourceRef: "job123/aaaa1111" } });
    expect(clip).toMatchObject({ title: "Grote onthulling", caption: "Dit moet je zien", hashtags: "#podcast #nl", campaign: "Zomer", source: "clipnova", durationSec: 32.5 });
    expect(fs.existsSync(clip.filePath)).toBe(true);

    const again = await importFromClipnova(root);
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
  });
});

describe("map-import", () => {
  it("importeert video's met optionele sidecar-JSON en negeert andere bestanden", async () => {
    const root = tmpDir();
    fs.writeFileSync(path.join(root, "clip_a.mp4"), crypto.randomBytes(500));
    fs.writeFileSync(path.join(root, "clip_a.json"), JSON.stringify({ title: "Uit sidecar", hashtags: "#x" }));
    fs.writeFileSync(path.join(root, "notities.txt"), "geen video");
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "b.mov"), crypto.randomBytes(500));
    const r = await importFromFolder(root, { creator: "Sam" });
    expect(r.imported).toBe(2);
    const a = await prisma.clip.findFirstOrThrow({ where: { title: "Uit sidecar" } });
    expect(a.hashtags).toBe("#x");
    expect(a.creator).toBe("Sam");
    expect((await prisma.clip.findFirstOrThrow({ where: { filename: "b.mov" } })).mimeType).toBe("video/quicktime");
  });
});
