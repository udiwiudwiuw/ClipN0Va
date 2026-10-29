import { CAPTION_LIMITS } from "../constants";
import { signedMediaUrl } from "../media";
import { sleep } from "../utils";
import { form, request } from "./http";
import { PublishError, composeText, type PlatformClient } from "./types";

// Instagram API with Instagram Login — https://developers.facebook.com/docs/instagram-platform/content-publishing
const GRAPH = "https://graph.instagram.com/v21.0";
const SCOPES = "instagram_business_basic,instagram_business_content_publish";

const classify = (status: number, body: any) => {
  const code = body?.error?.code;
  if (code === 190) return "auth" as const; // ongeldig/verlopen token
  if (code === 4 || code === 17 || code === 32 || code === 613 || body?.error?.is_transient) return "transient" as const;
  return undefined;
};

export const instagramClient: PlatformClient = {
  platform: "instagram",

  buildAuthUrl({ state, redirectUri, settings }) {
    const p = new URLSearchParams({
      client_id: settings.INSTAGRAM_APP_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES,
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${p}`;
  },

  async exchangeCode({ code, redirectUri, settings }) {
    const { body: short } = await request("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: settings.INSTAGRAM_APP_ID,
        client_secret: settings.INSTAGRAM_APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });
    // Ruil het kortlevende token (1 uur) in voor een langlevend token (60 dagen).
    const { body: long } = await request(
      `https://graph.instagram.com/access_token?${new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: settings.INSTAGRAM_APP_SECRET,
        access_token: short.access_token,
      })}`,
    );
    const { body: me } = await request(
      `${GRAPH}/me?fields=user_id,username,name,profile_picture_url,account_type&access_token=${encodeURIComponent(long.access_token)}`,
    );
    return {
      externalId: String(me.user_id ?? short.user_id),
      handle: me.username,
      displayName: me.name || me.username,
      avatarUrl: me.profile_picture_url ?? null,
      accessToken: long.access_token,
      // Instagram gebruikt het langlevende token zelf om te verversen.
      refreshToken: null,
      expiresAt: new Date(Date.now() + Number(long.expires_in ?? 5184000) * 1000),
      scopes: SCOPES,
    };
  },

  async refresh(account) {
    if (!account.accessToken) throw new PublishError("Geen token — opnieuw koppelen", "auth");
    const { body } = await request(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(account.accessToken)}`,
      {},
      (status, b) => (status === 400 || b?.error?.code === 190 ? "auth" : undefined),
    );
    return { accessToken: body.access_token, expiresAt: new Date(Date.now() + Number(body.expires_in ?? 5184000) * 1000) };
  },

  async publish({ post, clip, account, settings }) {
    const base = settings.PUBLIC_BASE_URL;
    if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
      throw new PublishError(
        "Instagram downloadt de video zelf: zet PUBLIC_BASE_URL op een publiek https-adres",
        "permanent",
      );
    }
    const token = encodeURIComponent(account.accessToken ?? "");
    const { body: container } = await request(
      `${GRAPH}/${account.externalId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          media_type: "REELS",
          video_url: signedMediaUrl(base, clip.id, 6 * 3600),
          caption: composeText(post.caption, post.hashtags, CAPTION_LIMITS.instagram.caption),
          share_to_feed: "true",
          access_token: account.accessToken ?? "",
        }),
      },
      classify,
    );

    // Wacht tot Instagram de video heeft verwerkt (max ~5 min).
    let statusCode = "IN_PROGRESS";
    for (let i = 0; i < 60 && statusCode === "IN_PROGRESS"; i++) {
      await sleep(5000);
      const { body } = await request(`${GRAPH}/${container.id}?fields=status_code,status&access_token=${token}`, {}, classify);
      statusCode = body.status_code;
      if (statusCode === "ERROR") throw new PublishError(`Instagram verwerking mislukt: ${body.status ?? ""}`, "permanent");
      if (statusCode === "EXPIRED") throw new PublishError("Instagram container verlopen", "transient");
    }
    if (statusCode !== "FINISHED") throw new PublishError("Instagram verwerking duurt te lang", "transient", { retryAfterMs: 120_000 });

    const { body: published } = await request(
      `${GRAPH}/${account.externalId}/media_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ creation_id: container.id, access_token: account.accessToken ?? "" }),
      },
      classify,
    );
    let url: string | null = null;
    try {
      const { body } = await request(`${GRAPH}/${published.id}?fields=permalink&access_token=${token}`);
      url = body.permalink ?? null;
    } catch {
      /* permalink is optioneel */
    }
    return { externalId: published.id, url, raw: { container: container.id, media: published.id } };
  },
};
