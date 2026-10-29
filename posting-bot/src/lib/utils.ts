import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Normaliseert "#a b, #c" → "#a #b #c" (uniek, max n). */
export function normalizeHashtags(input: string | string[] | null | undefined, max = 30): string {
  const parts = (Array.isArray(input) ? input : String(input ?? "").split(/[\s,]+/))
    .map((t) => t.trim().replace(/^#+/, ""))
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`#${p}`);
    if (out.length >= max) break;
  }
  return out.join(" ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Deterministische hash → getal (voor variatie per account). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
