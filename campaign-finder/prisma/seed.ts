/**
 * Demo-campagnes + een eerste zoekronde met de Demo Data Engine.
 * Uitvoeren: `npm run db:seed` (draait op de huidige SEARCH_MODE/AI_PROVIDER-instellingen).
 */
import { prisma } from "../src/lib/db";
import { runSearchNow } from "../src/lib/queue";

const CAMPAIGNS = [
  {
    name: "Podcast Zomer 2026",
    brand: "De Ondernemerspodcast",
    description: "Korte, prikkelende clips uit lange podcastafleveringen over ondernemen en geld.",
    audience: "18-35, Nederlandstalig, interesse in ondernemen, sparen en beleggen",
    sources: ["https://www.youtube.com/@ondernemerspodcast"],
    keywords: "ondernemen, geld, sparen, beleggen, startup",
    people: "Sam de Vries, Noor Jansen",
    topics: "financiële vrijheid, eerste bedrijf, fouten",
    language: "nl",
    minMinutes: 10,
    maxMinutes: 120,
    rules: "Alleen fragmenten waarin Sam of Noor zelf aan het woord is. Geen beleggingsadvies als garantie presenteren.",
    usageRights: "Clips van het eigen kanaal en officiële gastoptredens; bron vermelden in bijschrift.",
    excludedTopics: "gokken, crypto",
    searchIntervalHours: 24,
  },
  {
    name: "Gaming Highlights",
    brand: "PixelPete",
    description: "Grappige en spannende momenten uit lange streams.",
    audience: "13-24, gamers, Engels- en Nederlandstalig",
    sources: [],
    keywords: "minecraft, speedrun, rage, clutch",
    people: "PixelPete",
    topics: "highlights, funny moments",
    language: "en",
    minMinutes: 20,
    maxMinutes: 300,
    rules: "Geen schelden in de eerste 3 seconden van een clip.",
    usageRights: "Toestemming via clipping-programma; watermerk verplicht.",
    excludedTopics: "politiek",
    searchIntervalHours: 0,
  },
];

async function main() {
  if (await prisma.campaign.count()) {
    console.log("Database bevat al campagnes — seed overgeslagen. (Leeg maken: npx prisma db push --force-reset)");
    return;
  }
  for (const c of CAMPAIGNS) {
    const campaign = await prisma.campaign.create({ data: { ...c, sources: JSON.stringify(c.sources) } });
    const run = await runSearchNow(campaign.id);
    console.log(`✔ ${campaign.name}: ${run.found} gevonden, ${run.newVideos} nieuw, ${run.analyzed} geanalyseerd (${run.sources})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
