import { NextResponse } from "next/server";
import { z } from "zod";
import { handler } from "@/lib/api";
import { PLATFORMS } from "@/lib/constants";
import { isValidTimezone, parsePostingTimes } from "@/lib/scheduler";
import { SECRET_KEYS, SETTING_KEYS, getSettings, maskSecret, platformConfigured, saveSettings, type SettingKey } from "@/lib/settings";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const s = await getSettings();
  const values: Record<string, string> = {};
  for (const k of SETTING_KEYS) values[k] = SECRET_KEYS.includes(k) ? maskSecret(s[k]) : s[k];
  return NextResponse.json({
    values,
    secrets: SECRET_KEYS,
    platforms: Object.fromEntries(PLATFORMS.map((p) => [p, platformConfigured(s, p)])),
    ai: Boolean(s.OPENAI_API_KEY),
  });
});

const Body = z.record(z.string());

export const PUT = handler(async (req: Request) => {
  const body = Body.parse(await req.json());
  const updates: Partial<Record<SettingKey, string>> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) continue;
    // Gemaskeerde waarden ongewijzigd laten.
    if (SECRET_KEYS.includes(k as SettingKey) && v.includes("••••")) continue;
    updates[k as SettingKey] = v.trim();
  }
  if (updates.DEFAULT_TIMEZONE && !isValidTimezone(updates.DEFAULT_TIMEZONE)) {
    return NextResponse.json({ error: "Onbekende tijdzone" }, { status: 400 });
  }
  if (updates.DEFAULT_POSTING_TIMES !== undefined) {
    const t = parsePostingTimes(updates.DEFAULT_POSTING_TIMES);
    if (!t.length) return NextResponse.json({ error: "Ongeldige standaardtijden" }, { status: 400 });
    updates.DEFAULT_POSTING_TIMES = t.join(",");
  }
  await saveSettings(updates);
  return NextResponse.json({ ok: true });
});
