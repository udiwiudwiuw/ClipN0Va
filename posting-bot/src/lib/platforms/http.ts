import { PublishError } from "./types";

/** Zet een HTTP-status om naar een foutklasse. */
export function classifyStatus(status: number): "transient" | "auth" | "permanent" {
  if (status === 401) return "auth";
  if (status === 408 || status === 425 || status === 429 || status >= 500) return "transient";
  return "permanent";
}

function retryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

/**
 * fetch met timeout; netwerkfouten worden "transient", HTTP-fouten worden
 * geclassificeerd. `classify` kan platform-specifieke foutcodes overrulen.
 */
export async function request(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  classify?: (status: number, body: any) => "transient" | "auth" | "permanent" | undefined,
): Promise<{ res: Response; body: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new PublishError(`Netwerkfout: ${(err as Error).message}`, "transient");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* geen JSON */
  }
  if (!res.ok) {
    const kind = classify?.(res.status, body) ?? classifyStatus(res.status);
    const msg = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
    throw new PublishError(`HTTP ${res.status}: ${msg}`, kind, { status: res.status, retryAfterMs: retryAfter(res) });
  }
  return { res, body };
}

export function form(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}
