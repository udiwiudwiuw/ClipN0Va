import { NextResponse } from "next/server";
import { ensureFreshToken, publicAccount } from "@/lib/accounts";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Token direct verversen (test of het account nog werkt). */
export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) throw new HttpError(404, "Account niet gevonden");
  try {
    const fresh = await ensureFreshToken(account, undefined, true);
    return NextResponse.json({ ok: true, account: publicAccount(fresh) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
