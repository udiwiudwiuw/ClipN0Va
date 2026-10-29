import fs from "node:fs";
import { Readable } from "node:stream";
import { CAPTION_LIMITS } from "../constants";
import { form, request } from "./http";
import { PublishError, composeText, type PlatformClient } from "./types";

// YouTube Data API v3 — https://developers.google.com/youtube/v3/guides/uploading_a_video
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

const classify = (status: number, body: any) => {
  const reason = body?.error?.errors?.[0]?.reason;
  if (status === 403 && (reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded")) {
    return "transient" as const;
  }
  if (status === 400 && body?.error === "invalid_grant") return "auth" as const;
  return undefined;
};

export const youtubeClient: PlatformClient = {
  platform: "youtube",

  buildAuthUrl({ state, redirectUri, settings }) {
    const p = new URLSearchParams({
      client_id: settings.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      // select_account: laat de gebruiker per koppeling een ander kanaal/brand account kiezen
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },

  async exchangeCode({ code, redirectUri, settings }) {
    const { body: tok } = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        code,
        client_id: settings.GOOGLE_CLIENT_ID,
        client_secret: settings.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const { body: ch } = await request("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const channel = ch.items?.[0];
    if (!channel) throw new PublishError("Dit Google-account heeft geen YouTube-kanaal", "permanent");
    return {
      externalId: channel.id,
      handle: channel.snippet.customUrl?.replace(/^@/, "") || channel.id,
      displayName: channel.snippet.title,
      avatarUrl: channel.snippet.thumbnails?.default?.url ?? null,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: new Date(Date.now() + Number(tok.expires_in ?? 3600) * 1000),
      scopes: tok.scope,
    };
  },

  async refresh(account, settings) {
    if (!account.refreshToken) throw new PublishError("Geen refresh token — opnieuw koppelen", "auth");
    const { body } = await request(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          client_id: settings.GOOGLE_CLIENT_ID,
          client_secret: settings.GOOGLE_CLIENT_SECRET,
          refresh_token: account.refreshToken,
          grant_type: "refresh_token",
        }),
      },
      (status, b) => (status === 400 || status === 401 || b?.error === "invalid_grant" ? "auth" : undefined),
    );
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? account.refreshToken,
      expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000),
    };
  },

  async publish({ post, clip, account, settings }) {
    const size = fs.statSync(clip.filePath).size;
    const tags = post.hashtags.split(/\s+/).map((t) => t.replace(/^#/, "")).filter(Boolean);
    let title = (post.title || post.caption || clip.filename).replace(/\s+/g, " ").trim();
    if (!/#shorts/i.test(title) && title.length < 90) title += " #Shorts";
    title = title.slice(0, CAPTION_LIMITS.youtube.title);

    const { res } = await request(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": clip.mimeType || "video/mp4",
        },
        body: JSON.stringify({
          snippet: {
            title,
            description: composeText(post.caption, post.hashtags, CAPTION_LIMITS.youtube.caption),
            tags,
            categoryId: "22",
          },
          status: { privacyStatus: settings.YOUTUBE_PRIVACY_STATUS || "private", selfDeclaredMadeForKids: false },
        }),
      },
      classify,
    );
    const uploadUrl = res.headers.get("location");
    if (!uploadUrl) throw new PublishError("YouTube gaf geen upload-URL terug", "transient");

    const stream = Readable.toWeb(fs.createReadStream(clip.filePath)) as unknown as BodyInit;
    const { body } = await request(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": clip.mimeType || "video/mp4",
          "Content-Length": String(size),
        },
        body: stream,
        // @ts-expect-error — Node fetch vereist duplex voor streaming bodies
        duplex: "half",
        timeoutMs: 600_000,
      },
      classify,
    );
    return { externalId: body.id, url: `https://youtube.com/shorts/${body.id}`, raw: { id: body.id, status: body.status } };
  },
};
