/**
 * Test de zoekmachine en AI-analyse vanaf de command line, zonder database-wijzigingen.
 *   npm run test:engine
 *   npm run test:engine -- --keywords "podcast,geld" --people "Sam" --lang nl --min 5 --max 90 --exclude crypto --limit 3
 * Gebruikt de instellingen uit .env (YouTube API / RSS / demo, OpenAI / Anthropic / heuristiek).
 */
import { runAnalysis } from "../src/lib/ai/analyze";
import { status } from "../src/lib/config";
import { collect, withinDuration } from "../src/lib/search/engine";
import type { SearchCampaign } from "../src/lib/search/types";
import { splitList } from "../src/lib/utils";

function arg(name: string, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] ?? fallback : fallback;
}

async function main() {
  const c: SearchCampaign = {
    id: "cli-test",
    name: "CLI test",
    brand: arg("brand", "Test"),
    sources: splitList(arg("sources")),
    keywords: splitList(arg("keywords", "podcast, ondernemen, geld")),
    people: splitList(arg("people", "Sam de Vries")),
    topics: splitList(arg("topics")),
    excludedTopics: splitList(arg("exclude", "crypto")),
    language: arg("lang", "nl"),
    minMinutes: arg("min") ? Number(arg("min")) : 5,
    maxMinutes: arg("max") ? Number(arg("max")) : 120,
  };
  console.log("Configuratie:", status());
  const { sources, videos, errors } = await collect(c, 0, (m) => console.log("  ·", m));
  const fitting = videos.filter((v) => withinDuration(v, c));
  console.log(`\nBronnen: ${sources.join(", ")} — ${videos.length} gevonden, ${fitting.length} binnen lengte-eisen${errors.length ? `, fouten: ${errors.join("; ")}` : ""}\n`);

  const limit = Number(arg("limit", "3"));
  for (const v of fitting.slice(0, limit)) {
    const r = await runAnalysis(
      { ...c, description: "", audience: "", rules: "", usageRights: "", feedback: { prefer: [], avoid: [], notes: [], approved: [], rejected: [] } },
      { ...v },
    );
    const a = r.analysis;
    console.log(`▶ ${v.title}`);
    console.log(`  feitelijk : ${v.channelTitle} · ${v.durationSec ?? "?"}s · ${v.language ?? "?"} · ${v.viewCount ?? "?"} views · bron ${v.source}`);
    console.log(`  AI (${r.model}): match ${a.matchScore} · clip ${a.clipScore} · ${a.verdict}`);
    console.log(`  ${a.reasoning}`);
    for (const t of a.timestamps) console.log(`    ✂ ${t.start}-${t.end}  ${t.reason}${t.hook ? ` — “${t.hook}”` : ""}`);
    if (a.ruleViolations.length) console.log(`  ⚠ ${a.ruleViolations.join(" | ")}`);
    if (r.fallbackError) console.log(`  (terugval: ${r.fallbackError})`);
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
