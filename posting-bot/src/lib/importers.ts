import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { log } from "./log";
import { mimeFor, safeFilename, sha256File, storageDir } from "./media";
import { normalizeHashtags } from "./utils";

export interface ClipMeta {
  title?: string;
  caption?: string;
  hashtags?: string | string[];
  campaign?: string | null;
  creator?: string | null;
  durationSec?: number | null;
}

export interface ImportResult {
  imported: number;
  duplicates: number;
  errors: { file: string; error: string }[];
  clipIds: string[];
}

const emptyResult = (): ImportResult => ({ imported: 0, duplicates: 0, errors: [], clipIds: [] });

/**
 * Kopieert een videobestand naar de bibliotheek. Dubbele inhoud (zelfde
 * SHA-256) wordt herkend en niet opnieuw toegevoegd.
 */
export async function importFile(
  src: string,
  opts: { source: string; sourceRef?: string; meta?: ClipMeta; originalName?: string; moveFile?: boolean },
): Promise<{ clipId: string; duplicate: boolean }> {
  const name = opts.originalName ?? path.basename(src);
  const mimeType = mimeFor(name);
  if (!mimeType) throw new Error(`Geen ondersteund videoformaat: ${name}`);

  const checksum = await sha256File(src);
  const dup = await prisma.clip.findUnique({ where: { checksum } });
  if (dup) {
    if (opts.moveFile) fs.rmSync(src, { force: true });
    return { clipId: dup.id, duplicate: true };
  }

  const dest = path.join(storageDir(), "uploads", `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${safeFilename(name)}`);
  if (opts.moveFile) {
    try {
      fs.renameSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    }
  } else {
    fs.copyFileSync(src, dest);
  }
  const meta = opts.meta ?? {};
  const clip = await prisma.clip.create({
    data: {
      filename: name,
      filePath: dest,
      mimeType,
      sizeBytes: fs.statSync(dest).size,
      checksum,
      source: opts.source,
      sourceRef: opts.sourceRef ?? null,
      title: (meta.title ?? path.basename(name, path.extname(name)).replace(/[_-]+/g, " ")).slice(0, 300),
      caption: (meta.caption ?? "").slice(0, 5000),
      hashtags: normalizeHashtags(meta.hashtags ?? ""),
      campaign: meta.campaign || null,
      creator: meta.creator || null,
      durationSec: meta.durationSec ?? null,
    },
  });
  return { clipId: clip.id, duplicate: false };
}

/** Upload vanuit de browser (multipart). */
export async function importUpload(file: File, meta: ClipMeta = {}) {
  const tmp = path.join(storageDir(), "uploads", `.tmp-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, Buffer.from(await file.arrayBuffer()));
  try {
    return await importFile(tmp, { source: "upload", originalName: file.name, meta, moveFile: true });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Scant een map (en submappen, 2 niveaus) op videobestanden. */
export async function importFromFolder(dir: string, meta: ClipMeta = {}): Promise<ImportResult> {
  const result = emptyResult();
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
    return result;
  }
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (e.isFile() && mimeFor(e.name)) files.push(full);
    }
  };
  walk(root, 0);
  for (const f of files) {
    try {
      const sidecar = f.replace(/\.[^.]+$/, ".json");
      const fileMeta = fs.existsSync(sidecar) ? (JSON.parse(fs.readFileSync(sidecar, "utf8")) as ClipMeta) : {};
      const r = await importFile(f, { source: "folder", sourceRef: path.relative(root, f), meta: { ...meta, ...fileMeta } });
      if (r.duplicate) result.duplicates++;
      else {
        result.imported++;
        result.clipIds.push(r.clipId);
      }
    } catch (err) {
      result.errors.push({ file: f, error: (err as Error).message });
    }
  }
  await log("info", `Map-import ${root}: ${result.imported} nieuw, ${result.duplicates} dubbel, ${result.errors.length} fout`);
  return result;
}

/**
 * Importeert clips uit de ClipNova storage-map: elke `<job_id>/job.json`
 * bevat `clips[]` met id, titel, bijschrift en hashtags; de video staat in
 * `<job_id>/clip_<id>.mp4`.
 */
export async function importFromClipnova(storage: string, meta: ClipMeta = {}): Promise<ImportResult> {
  const result = emptyResult();
  const root = path.resolve(storage);
  if (!fs.existsSync(root)) throw new Error(`ClipNova-map niet gevonden: ${root}`);
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const jobFile = path.join(root, e.name, "job.json");
    if (!fs.existsSync(jobFile)) continue;
    let job: { status?: string; clips?: any[]; rules?: any };
    try {
      job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
    } catch (err) {
      result.errors.push({ file: jobFile, error: `job.json onleesbaar: ${(err as Error).message}` });
      continue;
    }
    for (const c of job.clips ?? []) {
      const video = path.join(root, e.name, `clip_${c.id}.mp4`);
      if (!fs.existsSync(video)) continue;
      try {
        const r = await importFile(video, {
          source: "clipnova",
          sourceRef: `${e.name}/${c.id}`,
          originalName: `${e.name}_clip_${c.id}.mp4`,
          meta: {
            title: c.title || c.hook || "",
            caption: c.caption || c.description || "",
            hashtags: c.hashtags ?? [],
            campaign: meta.campaign ?? job.rules?.campaign_name ?? job.rules?.name ?? null,
            creator: meta.creator ?? (Array.isArray(c.people) && c.people[0]?.name ? c.people[0].name : null),
            durationSec: typeof c.start === "number" && typeof c.end === "number" ? c.end - c.start : null,
          },
        });
        if (r.duplicate) result.duplicates++;
        else {
          result.imported++;
          result.clipIds.push(r.clipId);
        }
      } catch (err) {
        result.errors.push({ file: video, error: (err as Error).message });
      }
    }
  }
  await log("info", `ClipNova-import ${root}: ${result.imported} nieuw, ${result.duplicates} dubbel`);
  return result;
}
