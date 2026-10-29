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
  if (!res.ok) throw new Error(data.error ? `${data.error}${data.issues ? `: ${data.issues.map((i: any) => i.message).join(", ")}` : ""}` : `HTTP ${res.status}`);
  return data as T;
}

export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("nl-NL", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
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
