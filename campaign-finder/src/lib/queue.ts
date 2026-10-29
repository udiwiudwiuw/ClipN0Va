import { prisma } from "./db";
import { executeRun } from "./search/engine";

/**
 * Lichte in-memory wachtrij: zoekrondes draaien één voor één. Per campagne
 * staat er hooguit één ronde in de wachtrij of in uitvoering.
 */
const g = globalThis as unknown as { __finderQueue?: { pending: string[]; running: string | null } };
const state = (g.__finderQueue ??= { pending: [], running: null });

async function pump() {
  if (state.running) return;
  const next = state.pending.shift();
  if (!next) return;
  state.running = next;
  try {
    await executeRun(next);
  } catch (err) {
    console.error("[finder] zoekronde mislukt", err);
  } finally {
    state.running = null;
    setImmediate(() => void pump());
  }
}

export async function enqueueSearch(campaignId: string, trigger: "manual" | "schedule" = "manual") {
  const open = await prisma.searchRun.findFirst({ where: { campaignId, status: { in: ["queued", "running"] } } });
  if (open && (state.pending.includes(open.id) || state.running === open.id)) return { run: open, alreadyQueued: true };
  // Ronde die bleef hangen (server herstart) afsluiten
  if (open) await prisma.searchRun.update({ where: { id: open.id }, data: { status: "failed", error: "Onderbroken door herstart", finishedAt: new Date() } });
  const run = await prisma.searchRun.create({ data: { campaignId, trigger } });
  state.pending.push(run.id);
  void pump();
  return { run, alreadyQueued: false };
}

/** Voor tests en scripts: voert een ronde direct uit en wacht op het resultaat. */
export async function runSearchNow(campaignId: string, trigger: "manual" | "schedule" = "manual") {
  const run = await prisma.searchRun.create({ data: { campaignId, trigger } });
  return executeRun(run.id);
}

export function queueState() {
  return { pending: state.pending.length, running: state.running };
}
