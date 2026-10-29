import { hashString, rng } from "../utils";
import { parseSource, type RawVideo, type SearchCampaign, type TranscriptSegment } from "./types";

/**
 * Demo Data Engine: genereert realistische, deterministische video's met
 * metadata en transcript op basis van de campagne. Elke zoekronde trekt een
 * deels overlappende selectie uit dezelfde pool, zodat deduplicatie zichtbaar is.
 */

const T = {
  nl: {
    titles: [
      "{person} over {kw}: het eerlijke verhaal",
      "{kw} uitgelegd in {n} minuten",
      "Podcast #{n} met {person} — {kw}, {topic} en meer",
      "LIVE: {person} reageert op {kw}",
      "De waarheid over {kw} (niemand vertelt dit)",
      "{brand} Q&A: alles over {topic}",
      "Waarom {kw} alles verandert | {person}",
      "{person} en {person2} in discussie over {topic}",
    ],
    offTopic: ["Vlog: een dag in {city}", "Unboxing van mijn nieuwe camera", "Rustige lo-fi muziek om te studeren", "Mijn ochtendroutine 2026"],
    filler: [
      "Ja, goed, laten we beginnen.",
      "Dat is eigenlijk een goede vraag.",
      "We hebben daar vorige week ook al over gehad.",
      "Even kijken wat de chat zegt.",
      "Ik denk dat het voor de meeste mensen herkenbaar is.",
      "Oké, volgende onderwerp.",
      "Dat moeten we later nog eens goed uitzoeken.",
      "Ik weet niet of je dat kunt zien op de camera.",
    ],
    hooks: [
      "Dit had ik echt nooit verwacht!",
      "Ik ga je iets vertellen wat bijna niemand weet.",
      "Hahaha nee serieus, dit is echt gebeurd.",
      "Wacht, wat? Zeg dat nog eens?",
      "Het grootste probleem is eigenlijk heel simpel.",
      "Drie tips die mijn leven hebben veranderd.",
      "Eerlijk? Dit is de beste beslissing die ik ooit nam.",
      "Iedereen doet dit fout, en ik leg uit waarom.",
    ],
    kwLines: ["Als je kijkt naar {kw}, dan zie je meteen het verschil.", "{person} zei laatst iets over {kw} wat me bijbleef.", "Bij {topic} gaat het uiteindelijk om één ding.", "Ik krijg veel vragen over {kw}."],
    excluded: ["We moeten het ook even over {ex} hebben.", "Dit gaat een beetje richting {ex}, maar goed."],
    cities: ["Amsterdam", "Rotterdam", "Utrecht", "Antwerpen"],
  },
  en: {
    titles: [
      "{person} on {kw}: the honest story",
      "{kw} explained in {n} minutes",
      "Podcast #{n} with {person} — {kw}, {topic} and more",
      "LIVE: {person} reacts to {kw}",
      "The truth about {kw} (nobody tells you this)",
      "{brand} Q&A: everything about {topic}",
      "Why {kw} changes everything | {person}",
      "{person} and {person2} debate {topic}",
    ],
    offTopic: ["Vlog: a day in {city}", "Unboxing my new camera", "Chill lo-fi beats to study to", "My 2026 morning routine"],
    filler: [
      "Okay, let's get started.",
      "That's actually a good question.",
      "We talked about that last week too.",
      "Let me check what chat is saying.",
      "I think most people can relate to that.",
      "Alright, next topic.",
      "We should look into that later.",
      "Not sure if you can see that on camera.",
    ],
    hooks: [
      "I honestly never expected this!",
      "I'm going to tell you something almost nobody knows.",
      "Hahaha no seriously, this actually happened.",
      "Wait, what? Say that again?",
      "The biggest problem is actually really simple.",
      "Three tips that changed my life.",
      "Honestly? Best decision I ever made.",
      "Everyone gets this wrong, and here's why.",
    ],
    kwLines: ["If you look at {kw}, you immediately see the difference.", "{person} recently said something about {kw} that stuck with me.", "With {topic} it really comes down to one thing.", "I get a lot of questions about {kw}."],
    excluded: ["We also need to talk about {ex} for a second.", "This is getting into {ex} territory, but anyway."],
    cities: ["London", "New York", "Berlin", "Lisbon"],
  },
};

const CHANNELS = ["Podcast Plaza", "De Nieuwsshow", "ClipCentral", "Talk of the Town", "Studio Zuid", "Late Night Live", "Gaming Hub", "Business Talks"];
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const POOL_SIZE = 36;
const PER_RUN = 12;

function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function transcriptFor(rand: () => number, lang: "nl" | "en", durationSec: number, vars: () => Record<string, string>, excluded: string[], onTopic: boolean): TranscriptSegment[] {
  // `excluded` is alleen gevuld voor video's die bewust een uitgesloten onderwerp raken
  const t = T[lang];
  const pick = <X,>(a: X[]) => a[Math.floor(rand() * a.length)];
  const limit = Math.min(durationSec, 45 * 60); // demo-transcript tot 45 min
  // 2-4 "highlight"-zones met veel hooks en zoekwoorden
  const zones = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => rand() * Math.max(60, limit - 90));
  const segs: TranscriptSegment[] = [];
  for (let s = 0; s < limit; ) {
    const dur = 8 + Math.floor(rand() * 10);
    const inZone = zones.some((z) => s >= z && s <= z + 75);
    let text: string;
    const r = rand();
    if (inZone && onTopic) text = r < 0.55 ? pick(t.hooks) : fill(pick(t.kwLines), vars());
    else if (onTopic && r < 0.12) text = fill(pick(t.kwLines), vars());
    else if (r < 0.04) text = pick(t.hooks);
    else if (excluded.length && r > 0.97) text = fill(pick(t.excluded), { ex: pick(excluded) });
    else text = pick(t.filler);
    segs.push({ start: s, dur, text });
    s += dur;
  }
  return segs;
}

/** Pool van demo-video's voor deze campagne (altijd dezelfde). */
export function mockPool(c: SearchCampaign): RawVideo[] {
  const seed = hashString(`${c.id}|${c.keywords.join(",")}|${c.people.join(",")}`);
  const rand = rng(seed);
  const pick = <X,>(a: X[]) => a[Math.floor(rand() * a.length)];
  const kws = c.keywords.length ? c.keywords : [c.brand || c.name];
  const people = c.people.length ? c.people : [c.brand || "de host"];
  const topics = c.topics.length ? c.topics : kws;
  const sourceChannels = c.sources.map(parseSource).filter((s) => s.type === "channel" || s.type === "handle");

  const pool: RawVideo[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const lang: "nl" | "en" = rand() < 0.8 ? (c.language === "en" ? "en" : "nl") : c.language === "en" ? "nl" : "en";
    const t = T[lang];
    const onTopic = rand() > 0.17;
    const vars = () => ({ kw: pick(kws), person: pick(people), person2: pick(people), topic: pick(topics), brand: c.brand || c.name, n: String(2 + Math.floor(rand() * 180)), city: pick(t.cities) });
    let title = fill(onTopic ? pick(t.titles) : pick(t.offTopic), vars());
    const hasExcluded = c.excludedTopics.length > 0 && rand() < 0.1;
    const excludedTopic = hasExcluded ? pick(c.excludedTopics) : null;
    if (excludedTopic) title += ` + ${excludedTopic}`;

    // Duur: meestal binnen de campagne-grenzen, ~25% erbuiten.
    const minS = (c.minMinutes ?? 2) * 60;
    const maxS = (c.maxMinutes ?? 120) * 60;
    const durationSec = rand() < 0.75 ? Math.round(minS + rand() * Math.max(60, maxS - minS)) : rand() < 0.5 ? Math.round(30 + rand() * Math.max(30, minS - 30)) : Math.round(maxS * (1.1 + rand()));

    const externalId = "dm" + Array.from({ length: 9 }, () => ID_CHARS[Math.floor(rand() * ID_CHARS.length)]).join("");
    const src = sourceChannels.length && rand() < 0.4 ? pick(sourceChannels) : null;
    const channelTitle = src ? (src.type === "handle" ? `@${src.handle}` : `Kanaal ${src.channelId.slice(0, 6)}`) : pick(CHANNELS);
    const views = Math.round(Math.exp(7 + rand() * 7));
    const chapters = onTopic && rand() < 0.4
      ? "\n\nHoofdstukken:\n" + [0, 0.2, 0.45, 0.7].map((f, k) => `${new Date(Math.round(durationSec * f) * 1000).toISOString().slice(durationSec >= 3600 ? 11 : 14, 19)} ${k === 0 ? "Intro" : fill(pick(t.kwLines), vars()).slice(0, 40)}`).join("\n")
      : "";

    pool.push({
      platform: "youtube",
      externalId,
      url: `https://www.youtube.com/watch?v=${externalId}`,
      title,
      description: onTopic ? `${fill(pick(t.kwLines), vars())} Met ${pick(people)}.${chapters}` : `${pick(t.filler)} ${pick(t.filler)}`,
      channelId: src?.type === "channel" ? src.channelId : `UCdemo${hashString(channelTitle).toString(36).padEnd(16, "x").slice(0, 16)}`,
      channelTitle,
      thumbnailUrl: `/api/thumb/${externalId}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 300) * 86400_000),
      durationSec,
      language: lang,
      viewCount: views,
      likeCount: Math.round(views * (0.01 + rand() * 0.05)),
      commentCount: Math.round(views * (0.001 + rand() * 0.006)),
      tags: onTopic ? [pick(kws), pick(topics), pick(people)].map((x) => x.toLowerCase()) : ["vlog"],
      transcript: rand() < 0.85 ? transcriptFor(rand, lang, durationSec, vars, excludedTopic ? [excludedTopic] : [], onTopic) : null,
      source: "mock",
    });
  }
  return pool;
}

/** Eén zoekronde: een deels overlappende selectie uit de pool. */
export function searchMock(c: SearchCampaign, runIndex: number): RawVideo[] {
  const pool = mockPool(c);
  const rand = rng(hashString(`${c.id}:run:${runIndex}`));
  const start = (runIndex * Math.floor(PER_RUN * 0.6)) % pool.length;
  const picked = new Set<number>();
  for (let i = 0; i < PER_RUN - 3; i++) picked.add((start + i) % pool.length);
  while (picked.size < PER_RUN) picked.add(Math.floor(rand() * pool.length));
  return [...picked].map((i) => pool[i]);
}
