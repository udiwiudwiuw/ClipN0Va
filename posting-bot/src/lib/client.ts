"use client";

/** Kleine fetch-wrapper voor de UI: gooit een Error met de servermelding. */
export async function api<T = any>(url: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...init } = opts;
  const res = await fetch(url, {
    ...init,
    headers: json !== undefined ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init.headers,
    body: json !== undefined ? JSON.stringify(json) : init.body,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export function fmtDateTime(d: string | Date, tz?: string) {
  return new Intl.DateTimeFormat("nl-NL", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(d));
}

export function fmtRelative(d: string | Date) {
  const diff = new Date(d).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("nl", { numeric: "auto" });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), "second");
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), "hour");
  return rtf.format(Math.round(diff / 86400_000), "day");
}

/** Waarde voor <input type="datetime-local"> in lokale browsertijd. */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
