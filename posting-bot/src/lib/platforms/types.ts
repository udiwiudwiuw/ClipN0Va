import type { Account, Clip, Post } from "@prisma/client";
import type { Platform } from "../constants";
import type { Settings } from "../settings";

export type ErrorKind = "transient" | "auth" | "permanent";

/** Fout tijdens publiceren of token-verversing, met classificatie voor de retry-logica. */
export class PublishError extends Error {
  kind: ErrorKind;
  retryAfterMs?: number;
  status?: number;
  constructor(message: string, kind: ErrorKind, opts: { retryAfterMs?: number; status?: number } = {}) {
    super(message);
    this.name = "PublishError";
    this.kind = kind;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string | null;
}

export interface ConnectedProfile extends TokenSet {
  externalId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
}

/** Account met ontsleutelde tokens. */
export type AccountWithTokens = Account & { accessToken: string | null; refreshToken: string | null };

export interface PublishInput {
  post: Pick<Post, "id" | "title" | "caption" | "hashtags" | "idempotencyKey">;
  clip: Pick<Clip, "id" | "filePath" | "filename" | "mimeType" | "sizeBytes">;
  account: AccountWithTokens;
  settings: Settings;
}

export interface PublishResult {
  externalId: string;
  url?: string | null;
  raw?: unknown;
}

export interface PlatformClient {
  platform: Platform;
  buildAuthUrl(args: { state: string; redirectUri: string; settings: Settings }): string;
  exchangeCode(args: { code: string; redirectUri: string; settings: Settings }): Promise<ConnectedProfile>;
  refresh(account: AccountWithTokens, settings: Settings): Promise<TokenSet>;
  publish(input: PublishInput): Promise<PublishResult>;
}

/** Combineert bijschrift en hashtags tot de tekst die naar het platform gaat. */
export function composeText(caption: string, hashtags: string, max: number): string {
  const text = [caption.trim(), hashtags.trim()].filter(Boolean).join("\n\n");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
