import { NextResponse } from "next/server";
import { z } from "zod";
import { publicAccount } from "@/lib/accounts";
import { HttpError, handler } from "@/lib/api";
import { prisma } from "@/lib/db";
import { log } from "@/lib/log";
import { isValidTimezone, parsePostingTimes } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

const Patch = z.object({
  displayName: z.string().min(1).max(100).optional(),
  timezone: z.string().refine(isValidTimezone, "Onbekende tijdzone").optional(),
  postingTimes: z.string().optional(),
  dailyLimit: z.number().int().min(1).max(50).optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export const PATCH = handler(async (req: Request, { params }: { params: { id: string } }) => {
  const body = Patch.parse(await req.json());
  if (body.postingTimes !== undefined) {
    const times = parsePostingTimes(body.postingTimes);
    if (!times.length) throw new HttpError(400, "Geef minstens één geldige tijd op (bijv. 09:00,13:00)");
    body.postingTimes = times.join(",");
  }
  const account = await prisma.account.update({ where: { id: params.id }, data: body });
  return NextResponse.json({ account: publicAccount(account) });
});

/** Ontkoppelen: verwijdert tokens en account; geplande (niet-gepubliceerde) posts worden geannuleerd. */
export const DELETE = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  const account = await prisma.account.findUnique({ where: { id: params.id } });
  if (!account) throw new HttpError(404, "Account niet gevonden");
  await prisma.$transaction([
    prisma.post.deleteMany({ where: { accountId: account.id, status: { notIn: ["success"] } } }),
    prisma.account.delete({ where: { id: account.id } }),
  ]);
  await log("info", `Account ontkoppeld: ${account.platform} @${account.handle}`);
  return NextResponse.json({ ok: true });
});
