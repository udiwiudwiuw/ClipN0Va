/** Centrale configuratie uit .env, met automatische fallback naar demo/heuristiek. */
export type SearchMode = "auto" | "youtube" | "rss" | "mock";
export type AiProvider = "openai" | "anthropic" | "heuristic";

export function searchMode(): SearchMode {
  const m = (process.env.SEARCH_MODE || "auto").toLowerCase();
  return (["auto", "youtube", "rss", "mock"].includes(m) ? m : "auto") as SearchMode;
}

export function youtubeKey(): string {
  return process.env.YOUTUBE_API_KEY || "";
}

export function aiProvider(): AiProvider {
  const forced = (process.env.AI_PROVIDER || "auto").toLowerCase();
  if (forced === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (forced === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (forced === "heuristic") return "heuristic";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "heuristic";
}

export function aiModel(provider: AiProvider): string {
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  return "heuristic-v1";
}

export function analysisConcurrency(): number {
  return Math.min(10, Math.max(1, Number(process.env.ANALYSIS_CONCURRENCY) || 3));
}

export function status() {
  const mode = searchMode();
  const provider = aiProvider();
  return {
    searchMode: mode,
    youtubeApi: Boolean(youtubeKey()) && mode !== "mock" && mode !== "rss",
    demoData: mode === "mock" || (mode === "auto" && !youtubeKey()),
    aiProvider: provider,
    aiModel: aiModel(provider),
  };
}
