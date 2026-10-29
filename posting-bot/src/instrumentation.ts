export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WORKER_ENABLED !== "0") {
    const { startWorker } = await import("./lib/worker");
    startWorker();
  }
}
