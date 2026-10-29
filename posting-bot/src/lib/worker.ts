import cron from "node-cron";
import { refreshExpiringTokens } from "./accounts";
import { log } from "./log";
import { processDuePosts, WORKER_ID } from "./queue";

interface WorkerState {
  started: Date;
  running: boolean;
  lastTick?: Date;
  lastError?: string;
}

const g = globalThis as unknown as { __clipWorker?: WorkerState };

export function workerState() {
  return g.__clipWorker ? { ...g.__clipWorker, id: WORKER_ID } : null;
}

/** Eén worker per proces (Next.js hot reload start modules opnieuw). */
export function startWorker() {
  if (g.__clipWorker) return;
  const state: WorkerState = { started: new Date(), running: false };
  g.__clipWorker = state;
  const interval = Math.min(59, Math.max(5, Number(process.env.WORKER_INTERVAL_SECONDS) || 15));

  cron.schedule(`*/${interval} * * * * *`, async () => {
    if (state.running) return; // geen overlappende rondes
    state.running = true;
    try {
      const res = await processDuePosts();
      state.lastTick = new Date();
      state.lastError = undefined;
      if (res.processed.length) console.log(`[bot] worker verwerkte ${res.processed.length} post(s)`);
    } catch (err) {
      state.lastError = (err as Error).message;
      console.error("[bot] worker fout", err);
    } finally {
      state.running = false;
    }
  });

  // Elk uur: tokens verversen die binnenkort verlopen.
  cron.schedule("7 * * * *", () => {
    refreshExpiringTokens().catch((err) => console.error("[bot] token-onderhoud mislukt", err));
  });

  console.log(`[bot] worker gestart (${WORKER_ID}, elke ${interval}s)`);
  log("info", `Worker gestart (elke ${interval}s)`).catch(() => {});
}
