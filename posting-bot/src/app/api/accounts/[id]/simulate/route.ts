import { NextResponse } from "next/server";
import { z } from "zod";
import { markNeedsReauth } from "@/lib/accounts";
import { encryptToken } from "@/lib/crypto";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const Body = z.object({ scenario: z.enum(["expire_token", "revoke"]) });

/**
 * Alleen voor mock-accounts: simuleer een verlopen token (wordt automatisch
 * ververst) of een ingetrokken autorisatie (account → needs_reauth).
 */
export const POST = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const { scenario } = Body.parse(await req.json());
  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) throw new HttpError(404, "Account niet gevonden");
  if (!account.isMock) throw new HttpError(400, "Alleen beschikbaar voor mock-accounts");
  if (scenario === "expire_token") {
    await prisma.account.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
  } else {
    await prisma.account.update({ where: { id: account.id }, data: { refreshToken: encryptToken("mock_revoked"), accessToken: encryptToken("mock_expired") } });
    await markNeedsReauth(account.id, "Autorisatie ingetrokken (gesimuleerd)");
  }
  return NextResponse.json({ ok: true });
});
