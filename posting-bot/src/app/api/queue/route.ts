import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { processDuePosts, queueStats } from "@/lib/queue";
import { workerState } from "@/lib/worker";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  return NextResponse.json({ stats: await queueStats(), worker: workerState() });
});

/** Verwerk nu direct alle posts die aan de beurt zijn. */
export const POST = handler(async () => {
  return NextResponse.json(await processDuePosts());
});
