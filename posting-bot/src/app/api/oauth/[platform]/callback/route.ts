import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { saveConnectedProfile } from "@/lib/accounts";
import { isPlatform } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { clientForConnect } from "@/lib/platforms";
import { createMockClient } from "@/lib/platforms/mock";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { platform: string } }) {
  const url = new URL(req.url);
  const back = (q: Record<string, string>) => {
    const res = NextResponse.redirect(new URL(`/accounts?${new URLSearchParams(q)}`, url.origin));
    res.cookies.delete("oauth_state");
    return res;
  };
  try {
    if (!isPlatform(params.platform)) return back({ error: "Onbekend platform" });
    const err = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (err) return back({ error: `Koppelen geannuleerd: ${err}` });

    let saved: { state: string; platform: string; reauth: string; mock: boolean };
    try {
      saved = JSON.parse(cookies().get("oauth_state")?.value ?? "");
    } catch {
      return back({ error: "Sessie verlopen, probeer opnieuw te koppelen" });
    }
    if (saved.state !== url.searchParams.get("state") || saved.platform !== params.platform) {
      return back({ error: "Ongeldige state (mogelijk CSRF) — probeer opnieuw" });
    }
    const code = url.searchParams.get("code");
    if (!code) return back({ error: "Geen autorisatiecode ontvangen" });

    const settings = await getSettings();
    const isMock = saved.mock;
    const client = isMock ? createMockClient(params.platform) : clientForConnect(params.platform, settings).client;
    const redirectUri = `${settings.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/oauth/${params.platform}/callback`;
    const profile = await client.exchangeCode({ code, redirectUri, settings });

    if (saved.reauth) {
      const acc = await prisma.account.findUnique({ where: { id: saved.reauth } });
      if (acc && isMock) {
        Object.assign(profile, { externalId: acc.externalId, handle: acc.handle, displayName: acc.displayName });
      } else if (acc && acc.externalId !== profile.externalId) {
        await log("warn", `Herautorisatie met een ander account (@${profile.handle}) dan verwacht (@${acc.handle})`, { accountId: acc.id });
        return back({ error: `Je koos @${profile.handle}, maar @${acc.handle} moest opnieuw worden geautoriseerd.` });
      }
    }
    const account = await saveConnectedProfile(params.platform, profile, isMock);
    return back({ connected: account.id });
  } catch (err) {
    await log("error", `OAuth-callback ${params.platform} mislukt: ${(err as Error).message}`);
    return back({ error: (err as Error).message });
  }
}
