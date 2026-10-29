import crypto from "node:crypto";

/**
 * Optionele versleuteling van tokens (AES-256-GCM) met TOKEN_ENCRYPTION_KEY.
 * Zonder sleutel worden tokens als platte tekst opgeslagen (prima lokaal).
 */
const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const k = key();
  if (!k) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptToken(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;
  const k = key();
  if (!k) throw new Error("TOKEN_ENCRYPTION_KEY ontbreekt: kan opgeslagen token niet ontsleutelen");
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
