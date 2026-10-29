import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { HttpError, handler } from "@/lib/api";
import { isPlatform } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { clientForConnect } from "@/lib/platforms";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Start de OAuth-flow. Zonder API-sleutels (of voor mock-accounts) wordt de
 * flow lokaal gesimuleerd en kom je direct terug op de callback.
 */
export const GET = handler(async (req: Request, { params }: { params: { platform: string } }) => {
  if (!isPlatform(params.platform)) throw new HttpError(404, "Onbekend platform");
  const url = new URL(req.url);
  const reauth = url.searchParams.get("reauth") ?? "";
  const settings = await getSettings();
  let { client } = clientForConnect(params.platform, settings);
  if (reauth) {
    const acc = await prisma.account.findUnique({ where: { id: reauth } });
    if (!acc) throw new HttpError(404, "Account niet gevonden");
    if (acc.isMock) client = (await import("@/lib/platforms/mock")).createMockClient(params.platform);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${settings.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/oauth/${params.platform}/callback`;
  const target = new URL(client.buildAuthUrl({ state, redirectUri, settings }), url.origin);
  const res = NextResponse.redirect(target);
  res.cookies.set("oauth_state", JSON.stringify({ state, platform: params.platform, reauth, mock: target.origin === url.origin }), {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    maxAge: 600,
    path: "/",
  });
  return res;
});
