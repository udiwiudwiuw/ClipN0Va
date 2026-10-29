import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { saveConnectedProfile } from "@/lib/accounts";
import type { Platform } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { storageDir } from "@/lib/media";
import { mockProfile, __resetMockServer } from "@/lib/platforms/mock";

export async function resetDb() {
  await prisma.log.deleteMany();
  await prisma.post.deleteMany();
  await prisma.clip.deleteMany();
  await prisma.account.deleteMany();
  await prisma.setting.deleteMany();
  __resetMockServer();
}

export async function mockAccount(platform: Platform, overrides: Record<string, unknown> = {}) {
  const acc = await saveConnectedProfile(platform, mockProfile(platform), true);
  return Object.keys(overrides).length ? prisma.account.update({ where: { id: acc.id }, data: overrides }) : acc;
}

export async function fakeClip(title = "Test clip") {
  const file = path.join(storageDir(), "uploads", `${crypto.randomUUID()}.mp4`);
  const content = crypto.randomBytes(2048);
  fs.writeFileSync(file, content);
  return prisma.clip.create({
    data: {
      filename: path.basename(file),
      filePath: file,
      sizeBytes: content.length,
      checksum: crypto.createHash("sha256").update(content).digest("hex"),
      title,
      caption: `${title} — wat een moment`,
      hashtags: "#podcast #clips",
      campaign: "Zomer",
      creator: "Sam",
    },
  });
}
