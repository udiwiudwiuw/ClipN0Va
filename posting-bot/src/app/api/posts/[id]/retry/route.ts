import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { retryPost } from "@/lib/queue";

export const dynamic = "force-dynamic";

export const POST = handler(async (_req: Request, { params }: { params: { id: string } }) => {
  try {
    return NextResponse.json({ post: await retryPost(params.id) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
});
