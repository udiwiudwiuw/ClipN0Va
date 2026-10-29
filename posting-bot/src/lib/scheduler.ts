import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { generateCaption } from "./ai";
import type { Platform } from "./constants";
import { prisma } from "./db";
import { log } from "./log";
import { getSettings } from "./settings";
import { normalizeHashtags } from "./utils";

export interface ScheduleConfig {
  timezone: string;
  postingTimes: string;
  dailyLimit: number;
}

/** "9:00, 13:30,19:00" → ["09:00","13:30","19:00"] (gesorteerd, uniek, geldig). */
export function parsePostingTimes(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return [...out].sort();
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Lokale datum (yyyy-MM-dd) van een moment in een tijdzone. */
export function localDay(date: Date, tz: string): string {
  return formatInTimeZone(date, tz, "yyyy-MM-dd");
}

/**
 * Bepaalt de eerstvolgende vrije publicatiemomenten voor een account.
 * Houdt rekening met de tijdzone (incl. zomertijd), de vaste posttijden,
 * het daglimiet en al geplande posts (`taken`).
 */
export function nextSlots(cfg: ScheduleConfig, from: Date, taken: Date[], count: number, minLeadMs = 60_000): Date[] {
  const times = parsePostingTimes(cfg.postingTimes);
  if (!times.length || count <= 0) return [];
  const limit = Math.max(1, cfg.dailyLimit || 1);
  const tz = isValidTimezone(cfg.timezone) ? cfg.timezone : "UTC";

  const perDay = new Map<string, number>();
  const takenMs = taken.map((d) => d.getTime());
  for (const d of taken) {
    const k = localDay(d, tz);
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }

  const result: Date[] = [];
  const earliest = from.getTime() + minLeadMs;
  const startDay = fromZonedTime(`${localDay(from, tz)}T12:00:00`, tz);
  for (let i = 0; i < 730 && result.length < count; i++) {
    const day = localDay(addDays(startDay, i), tz);
    for (const t of times) {
      if (result.length >= count) break;
      if ((perDay.get(day) ?? 0) >= limit) break;
      const slot = fromZonedTime(`${day}T${t}:00`, tz);
      if (slot.getTime() < earliest) continue;
      if (takenMs.some((ms) => Math.abs(ms - slot.getTime()) < 60_000)) continue;
      result.push(slot);
      takenMs.push(slot.getTime());
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
  }
  return result;
}

const ACTIVE_STATUSES = ["draft", "queued", "processing", "success"];

export interface ScheduleRequest {
  clipIds: string[];
  accountIds: string[];
  /** "auto" = volgende vrije slots per account, "at" = vast moment */
  mode: "auto" | "at";
  at?: string | Date;
  /** AI/sjabloon-bijschrift per account genereren (anders tekst van de clip) */
  generateCaptions?: boolean;
  /** Direct goedkeuren → status queued; anders draft (eerst nakijken) */
  approve?: boolean;
  /** Minuten tussen opeenvolgende clips bij mode "at" */
  spacingMinutes?: number;
}

export interface ScheduleResult {
  created: number;
  skipped: { clipId: string; accountId: string; reason: string }[];
  postIds: string[];
}

export function idempotencyKey(clipId: string, accountId: string) {
  return `${clipId}:${accountId}`;
}

/** Zet clips × accounts in de planning, met duplicaatpreventie. */
export async function schedulePosts(req: ScheduleRequest): Promise<ScheduleResult> {
  const settings = await getSettings();
  const approve = req.approve ?? settings.AUTO_APPROVE === "1";
  const clips = await prisma.clip.findMany({ where: { id: { in: req.clipIds } } });
  const accounts = await prisma.account.findMany({ where: { id: { in: req.accountIds } } });
  const clipOrder = req.clipIds.map((id) => clips.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => Boolean(c));

  const result: ScheduleResult = { created: 0, skipped: [], postIds: [] };
  const now = new Date();

  for (const account of accounts) {
    const existing = await prisma.post.findMany({
      where: { accountId: account.id, clipId: { in: clipOrder.map((c) => c.id) } },
    });
    const byClip = new Map(existing.map((p) => [p.clipId, p]));
    const todo = clipOrder.filter((c) => {
      const p = byClip.get(c.id);
      if (p && ACTIVE_STATUSES.includes(p.status)) {
        result.skipped.push({ clipId: c.id, accountId: account.id, reason: `al gepland (${p.status})` });
        return false;
      }
      return true;
    });
    if (!todo.length) continue;

    let slots: Date[];
    if (req.mode === "at") {
      const at = new Date(req.at ?? now);
      if (Number.isNaN(at.getTime())) throw new Error("Ongeldig tijdstip");
      const spacing = (req.spacingMinutes ?? 60) * 60_000;
      slots = todo.map((_, i) => new Date(at.getTime() + i * spacing));
    } else {
      const taken = await prisma.post.findMany({
        where: { accountId: account.id, status: { in: ["draft", "queued", "processing", "success"] }, scheduledAt: { gte: addDays(now, -1) } },
        select: { scheduledAt: true },
      });
      slots = nextSlots(account, now, taken.map((t) => t.scheduledAt), todo.length);
    }

    for (const [i, clip] of todo.entries()) {
      const platform = account.platform as Platform;
      let text = { title: clip.title, caption: clip.caption, hashtags: normalizeHashtags(clip.hashtags), source: "clip" };
      if (req.generateCaptions) {
        text = await generateCaption(clip, platform, {
          settings,
          variantSeed: `${account.id}:${clip.id}`,
          variantIndex: accounts.indexOf(account),
          accountHandle: account.handle,
        });
      }
      const data = {
        clipId: clip.id,
        accountId: account.id,
        platform,
        title: text.title,
        caption: text.caption,
        hashtags: text.hashtags,
        captionSource: text.source,
        scheduledAt: slots[i] ?? now,
        status: approve ? "queued" : "draft",
        approved: approve,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        externalId: null,
        externalUrl: null,
        lockedAt: null,
        lockedBy: null,
        publishedAt: null,
      };
      const key = idempotencyKey(clip.id, account.id);
      // Een eerdere geannuleerde/mislukte poging wordt hergebruikt (zelfde idempotency key).
      const post = await prisma.post.upsert({ where: { idempotencyKey: key }, create: { ...data, idempotencyKey: key }, update: data });
      result.created++;
      result.postIds.push(post.id);
    }
    if (clipOrder.length) await prisma.clip.updateMany({ where: { id: { in: todo.map((c) => c.id) }, status: "draft" }, data: { status: "ready" } });
    await log("info", `${todo.length} post(s) gepland voor ${account.platform} @${account.handle}`, { accountId: account.id });
  }
  return result;
}
