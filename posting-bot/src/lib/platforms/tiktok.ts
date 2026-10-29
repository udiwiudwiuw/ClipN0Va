import fs from "node:fs";
import { CAPTION_LIMITS } from "../constants";
import { sleep } from "../utils";
import { form, request } from "./http";
import { PublishError, composeText, type PlatformClient } from "./types";

// TikTok Content Posting API — https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
const API = "https://open.tiktokapis.com/v2";
const SCOPES = "user.info.basic,video.publish,video.upload";
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_SINGLE = 64 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

/** TikTok geeft fouten ook met HTTP 200 terug in `error.code`. */
function check(body: any) {
  const code = body?.error?.code;
  if (!code || code === "ok") return;
  const msg = `TikTok: ${code} — ${body.error.message ?? ""}`;
  if (["access_token_invalid", "scope_not_authorized", "token_not_authorized_for_specified_deployment"].includes(code)) {
    throw new PublishError(msg, "auth");
  }
  if (["rate_limit_exceeded", "internal_error", "spam_risk_too_many_pending_share"].includes(code)) {
    throw new PublishError(msg, "transient", { retryAfterMs: 60_000 });
  }
  throw new PublishError(msg, "permanent");
}

const classify = (status: number, body: any) => {
  const code = body?.error?.code;
  if (code === "access_token_invalid") return "auth" as const;
  if (code === "rate_limit_exceeded") return "transient" as const;
  return undefined;
};

/** Verdeelt het bestand volgens TikToks chunk-regels (5–64 MB, laatste chunk mag groter). */
export function tiktokChunks(size: number): { chunkSize: number; count: number } {
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const count = Math.floor(size / CHUNK);
  return { chunkSize: CHUNK, count: Math.max(1, count) };
}

export const tiktokClient: PlatformClient = {
  platform: "tiktok",

  buildAuthUrl({ state, redirectUri, settings }) {
    const p = new URLSearchParams({
      client_key: settings.TIKTOK_CLIENT_KEY,
      scope: SCOPES,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
  },

  async exchangeCode({ code, redirectUri, settings }) {
    const { body: tok } = await request(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_key: settings.TIKTOK_CLIENT_KEY,
        client_secret: settings.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (tok.error && typeof tok.error === "string") throw new PublishError(`TikTok: ${tok.error_description ?? tok.error}`, "permanent");
    const { body: info } = await request(`${API}/user/info/?fields=open_id,avatar_url,display_name,username`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    check(info);
    const u = info.data?.user ?? {};
    return {
      externalId: tok.open_id ?? u.open_id,
      handle: u.username || u.display_name || tok.open_id,
      displayName: u.display_name || u.username || "TikTok account",
      avatarUrl: u.avatar_url ?? null,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token,
      expiresAt: new Date(Date.now() + Number(tok.expires_in ?? 86400) * 1000),
      scopes: tok.scope ?? SCOPES,
    };
  },

  async refresh(account, settings) {
    if (!account.refreshToken) throw new PublishError("Geen refresh token", "auth");
    const { body } = await request(
      `${API}/oauth/token/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          client_key: settings.TIKTOK_CLIENT_KEY,
          client_secret: settings.TIKTOK_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
        }),
      },
      (status) => (status === 400 ? "auth" : undefined),
    );
    if (body.error && typeof body.error === "string") throw new PublishError(`TikTok refresh: ${body.error}`, "auth");
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? account.refreshToken,
      expiresAt: new Date(Date.now() + Number(body.expires_in ?? 86400) * 1000),
    };
  },

  async publish({ post, clip, account, settings }) {
    const size = fs.statSync(clip.filePath).size;
    const { chunkSize, count } = tiktokChunks(size);
    if (size < MIN_CHUNK && count > 1) throw new PublishError("Ongeldige chunkverdeling", "permanent");
    const auth = { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json; charset=UTF-8" };

    const { body: init } = await request(
      `${API}/post/publish/video/init/`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          post_info: {
            title: composeText(post.caption, post.hashtags, CAPTION_LIMITS.tiktok.caption),
            privacy_level: settings.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY",
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
        }),
      },
      classify,
    );
    check(init);
    const { publish_id: publishId, upload_url: uploadUrl } = init.data;

    const fd = fs.openSync(clip.filePath, "r");
    try {
      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
        const buf = Buffer.alloc(end - start + 1);
        fs.readSync(fd, buf, 0, buf.length, start);
        await request(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": clip.mimeType || "video/mp4",
            "Content-Length": String(buf.length),
            "Content-Range": `bytes ${start}-${end}/${size}`,
          },
          body: buf,
          timeoutMs: 300_000,
        });
      }
    } finally {
      fs.closeSync(fd);
    }

    // Status kort pollen; TikTok verwerkt asynchroon.
    let status = "PROCESSING_UPLOAD";
    let postIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      await sleep(3000);
      const { body: st } = await request(`${API}/post/publish/status/fetch/`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ publish_id: publishId }),
      }, classify);
      check(st);
      status = st.data?.status ?? status;
      postIds = st.data?.publicaly_available_post_id ?? [];
      if (status === "FAILED") throw new PublishError(`TikTok verwerking mislukt: ${st.data?.fail_reason ?? "onbekend"}`, "permanent");
      if (status === "PUBLISH_COMPLETE" || status === "SEND_TO_USER_INBOX") break;
    }
    const videoId = postIds[0];
    return {
      externalId: videoId ? String(videoId) : publishId,
      url: videoId ? `https://www.tiktok.com/@${account.handle}/video/${videoId}` : null,
      raw: { publish_id: publishId, status },
    };
  },
};
