import { NextResponse } from "next/server";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Geeft de URL terug waarmee het account opnieuw wordt geautoriseerd. */
export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) throw new HttpError(404, "Account niet gevonden");
  return NextResponse.json({ url: `/api/oauth/${account.platform}/start?reauth=${account.id}` });
});
