import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VIDEO_EXTENSIONS: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

export function storageDir(): string {
  const dir = path.resolve(process.env.STORAGE_DIR || "./storage");
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  return dir;
}

export function mimeFor(file: string): string | null {
  return VIDEO_EXTENSIONS[path.extname(file).toLowerCase()] ?? null;
}

export function safeFilename(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, path.extname(name)).replace(/[^\w.-]+/g, "_").slice(0, 80) || "clip";
  return `${base}${ext}`;
}

export async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function signingSecret(): string {
  return process.env.MEDIA_SIGNING_SECRET || process.env.TOKEN_ENCRYPTION_KEY || process.env.APP_PASSWORD || "clipnova-local";
}

export function signMedia(clipId: string, expires: number): string {
  return crypto.createHmac("sha256", signingSecret()).update(`${clipId}.${expires}`).digest("hex").slice(0, 32);
}

export function verifyMediaSignature(clipId: string, expires: string | null, sig: string | null): boolean {
  if (!expires || !sig) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = signMedia(clipId, exp);
  return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

/** Tijdelijk publiek adres voor een clip (Instagram haalt de video zelf op). */
export function signedMediaUrl(baseUrl: string, clipId: string, ttlSeconds: number): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${baseUrl.replace(/\/$/, "")}/api/media/${clipId}?expires=${expires}&sig=${signMedia(clipId, expires)}`;
}
