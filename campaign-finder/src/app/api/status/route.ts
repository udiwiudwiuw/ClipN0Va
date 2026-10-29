import { NextResponse } from "next/server";
import { status } from "@/lib/config";
import { queueState } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...status(), queue: queueState() });
}
