import { prisma } from "./db";
import type { Platform } from "./constants";

/**
 * Instellingen: waarden uit de UI (tabel Setting) gaan vóór .env.
 * Zo werkt de app out-of-the-box met .env en kan alles later in de UI.
 */
export const SETTING_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_PRIVACY_LEVEL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "YOUTUBE_PRIVACY_STATUS",
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "PUBLIC_BASE_URL",
  "DEFAULT_TIMEZONE",
  "DEFAULT_POSTING_TIMES",
  "DEFAULT_DAILY_LIMIT",
  "MOCK_MODE",
  "MOCK_FAILURE_RATE",
  "AUTO_APPROVE",
  "IMPORT_DIR",
  "CLIPNOVA_STORAGE_DIR",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SECRET_KEYS: SettingKey[] = [
  "OPENAI_API_KEY",
  "TIKTOK_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "INSTAGRAM_APP_SECRET",
];

const DEFAULTS: Partial<Record<SettingKey, string>> = {
  OPENAI_MODEL: "gpt-4o-mini",
  TIKTOK_PRIVACY_LEVEL: "SELF_ONLY",
  YOUTUBE_PRIVACY_STATUS: "private",
  PUBLIC_BASE_URL: "http://localhost:3000",
  DEFAULT_TIMEZONE: "Europe/Amsterdam",
  DEFAULT_POSTING_TIMES: "09:00,13:00,19:00",
  DEFAULT_DAILY_LIMIT: "3",
  MOCK_FAILURE_RATE: "0.1",
  AUTO_APPROVE: "0",
  IMPORT_DIR: "./storage/inbox",
};

export type Settings = Record<SettingKey, string>;

export async function getSettings(): Promise<Settings> {
  let rows: { key: string; value: string }[] = [];
  try {
    rows = await prisma.setting.findMany();
  } catch {
    // Database nog niet aangemaakt: val terug op env/defaults.
  }
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Settings;
  for (const key of SETTING_KEYS) {
    const fromDb = stored.get(key);
    out[key] = (fromDb !== undefined && fromDb !== "" ? fromDb : process.env[key]) || DEFAULTS[key] || "";
  }
  return out;
}

export async function getSetting(key: SettingKey): Promise<string> {
  return (await getSettings())[key];
}

export async function saveSettings(values: Partial<Record<SettingKey, string>>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key) || value === undefined) continue;
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });
  }
}

/** Heeft dit platform echte API-sleutels (en staat mock mode niet geforceerd aan)? */
export function platformConfigured(s: Settings, platform: Platform): boolean {
  if (s.MOCK_MODE === "1" || s.MOCK_MODE === "true") return false;
  switch (platform) {
    case "tiktok":
      return Boolean(s.TIKTOK_CLIENT_KEY && s.TIKTOK_CLIENT_SECRET);
    case "youtube":
      return Boolean(s.GOOGLE_CLIENT_ID && s.GOOGLE_CLIENT_SECRET);
    case "instagram":
      return Boolean(s.INSTAGRAM_APP_ID && s.INSTAGRAM_APP_SECRET);
  }
}

export function maskSecret(v: string): string {
  if (!v) return "";
  return v.length <= 8 ? "••••" : `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
