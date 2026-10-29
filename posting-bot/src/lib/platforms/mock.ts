import crypto from "node:crypto";
import type { Platform } from "../constants";
import { sleep } from "../utils";
import {
  PublishError,
  type ConnectedProfile,
  type PlatformClient,
  type PublishInput,
  type PublishResult,
  type TokenSet,
} from "./types";

/**
 * Mock Publishing Mode: simuleert OAuth, token-refresh en uploads met
 * realistische responses. De "server" onthoudt idempotency keys, zodat een
 * herhaalde upload dezelfde post teruggeeft (net als een echte API die de
 * eerste poging al had verwerkt).
 */
const g = globalThis as unknown as { __mockServer?: Map<string, PublishResult> };
const published = (g.__mockServer ??= new Map<string, PublishResult>());

const rand = (n: number, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") =>
  Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const digits = (n: number) => rand(n, "0123456789");

const NAMES = ["clipnova", "dailyclips", "viralmoments", "shortsfactory", "hookhunter", "reelroom"];

export function mockProfile(platform: Platform, hint?: string): ConnectedProfile {
  const base = (hint || NAMES[crypto.randomInt(NAMES.length)]).toLowerCase().replace(/[^a-z0-9_.]/g, "");
  const handle = `${base}_${digits(3)}`;
  return {
    externalId: platform === "youtube" ? `UC${rand(22)}` : platform === "instagram" ? `1784${digits(13)}` : `-000${rand(28)}`,
    handle,
    displayName: platform === "youtube" ? `${base} Shorts` : `@${handle}`,
    avatarUrl: null,
    accessToken: `mock_${platform}_at_${rand(24)}`,
    refreshToken: `mock_${platform}_rt_${rand(24)}`,
    expiresAt: new Date(Date.now() + (platform === "instagram" ? 60 * 86400 : platform === "youtube" ? 3600 : 86400) * 1000),
    scopes: "mock",
  };
}

function failureRate(input: PublishInput): number {
  const v = Number(input.settings.MOCK_FAILURE_RATE ?? process.env.MOCK_FAILURE_RATE ?? 0);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0;
}

function latency(): number {
  const v = Number(process.env.MOCK_LATENCY_MS ?? 800);
  return Number.isFinite(v) ? v : 800;
}

function fakeResult(platform: Platform, input: PublishInput): PublishResult {
  const handle = input.account.handle;
  switch (platform) {
    case "tiktok": {
      const id = `7${digits(18)}`;
      return {
        externalId: id,
        url: `https://www.tiktok.com/@${handle}/video/${id}`,
        raw: {
          data: { publish_id: `v_pub_file~v2-1.${digits(19)}`, status: "PUBLISH_COMPLETE", publicaly_available_post_id: [id] },
          error: { code: "ok", message: "", log_id: rand(32, "0123456789ABCDEF") },
        },
      };
    }
    case "youtube": {
      const id = rand(11);
      return {
        externalId: id,
        url: `https://youtube.com/shorts/${id}`,
        raw: { kind: "youtube#video", etag: rand(27), id, status: { uploadStatus: "uploaded", privacyStatus: input.settings.YOUTUBE_PRIVACY_STATUS } },
      };
    }
    case "instagram": {
      const id = `1790${digits(13)}`;
      const code = `C${rand(10)}`;
      return { externalId: id, url: `https://www.instagram.com/reel/${code}/`, raw: { id, container: { status_code: "FINISHED" } } };
    }
  }
}

export function createMockClient(platform: Platform): PlatformClient {
  return {
    platform,
    buildAuthUrl({ state }) {
      return `/api/oauth/${platform}/callback?code=mock_${rand(16)}&state=${encodeURIComponent(state)}`;
    },
    async exchangeCode() {
      return mockProfile(platform);
    },
    async refresh(account): Promise<TokenSet> {
      if (account.refreshToken?.includes("revoked")) {
        throw new PublishError("invalid_grant: refresh token ingetrokken (mock)", "auth");
      }
      return {
        accessToken: `mock_${platform}_at_${rand(24)}`,
        refreshToken: account.refreshToken,
        expiresAt: new Date(Date.now() + 3600_000),
      };
    },
    async publish(input) {
      const existing = published.get(input.post.idempotencyKey);
      if (existing) return { ...existing, raw: { ...(existing.raw as object), idempotent_replay: true } };

      await sleep(latency());
      if (input.account.accessToken?.includes("expired")) {
        throw new PublishError("HTTP 401: access_token_invalid (mock)", "auth", { status: 401 });
      }
      if (Math.random() < failureRate(input)) {
        const errs = ["ETIMEDOUT tijdens upload (mock)", "HTTP 503: service unavailable (mock)", "HTTP 429: rate_limit_exceeded (mock)"];
        throw new PublishError(errs[crypto.randomInt(errs.length)], "transient", { status: 503 });
      }
      const result = fakeResult(platform, input);
      published.set(input.post.idempotencyKey, result);
      return result;
    },
  };
}

/** Alleen voor tests. */
export function __resetMockServer() {
  published.clear();
}
