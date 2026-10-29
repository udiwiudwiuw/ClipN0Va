import { describe, expect, it } from "vitest";
import { analyzeHeuristic, bestWindows, parseChapters } from "@/lib/ai/heuristic";
import { buildUserPrompt } from "@/lib/ai/prompt";
import { sanitizeAnalysis, type CampaignContext, type VideoContext } from "@/lib/ai/types";
import { runAnalysis } from "@/lib/ai/analyze";

const campaign: CampaignContext = {
  name: "Test",
  brand: "Podcast",
  description: "",
  audience: "",
  keywords: ["ondernemen", "geld"],
  people: ["Sam de Vries"],
  topics: ["startup"],
  excludedTopics: ["crypto"],
  language: "nl",
  minMinutes: 5,
  maxMinutes: 120,
  rules: "",
  usageRights: "",
  feedback: { prefer: [], avoid: [], notes: [], approved: [], rejected: [] },
};

const transcript = Array.from({ length: 120 }, (_, i) => ({
  start: i * 15,
  dur: 15,
  text:
    i >= 40 && i <= 44
      ? ["Dit had ik echt nooit verwacht!", "Sam de Vries vertelt over geld en ondernemen.", "Wacht, wat? Serieus?", "Het grootste geheim van ondernemen.", "Haha, echt waar!"][i - 40]
      : "Ja goed, laten we verder gaan.",
}));

const good: VideoContext = {
  title: "Sam de Vries over ondernemen en geld",
  description: "Gesprek over een startup.",
  channelTitle: "Podcast Plaza",
  durationSec: 1800,
  language: "nl",
  viewCount: 250_000,
  likeCount: 10_000,
  commentCount: 800,
  publishedAt: new Date("2026-03-01"),
  tags: ["ondernemen"],
  transcript,
};

describe("heuristische analyse", () => {
  it("scoort een passende video hoog en vindt het sterke fragment", () => {
    const a = analyzeHeuristic(campaign, good);
    expect(a.matchScore).toBeGreaterThanOrEqual(70);
    expect(a.clipScore).toBeGreaterThanOrEqual(60);
    expect(a.verdict).toBe("geschikt");
    expect(a.timestamps.length).toBeGreaterThan(0);
    // Het fragment rond 10:00 (segment 40 = 600 s) moet erin zitten
    expect(a.timestamps.some((t) => t.start >= "09:00" && t.start <= "11:00")).toBe(true);
  });

  it("straft uitgesloten onderwerpen, verkeerde taal en lengte af", () => {
    const bad = { ...good, title: "Sam de Vries over crypto", language: "en", durationSec: 60 * 200 };
    const a = analyzeHeuristic(campaign, bad);
    expect(a.matchScore).toBeLessThanOrEqual(35);
    expect(a.verdict).toBe("ongeschikt");
    expect(a.ruleViolations.join(" ")).toMatch(/crypto/);
    expect(a.ruleViolations.join(" ")).toMatch(/Lengte/);
  });

  it("feedback beïnvloedt de score", () => {
    const base = analyzeHeuristic(campaign, good).matchScore;
    const avoid = analyzeHeuristic({ ...campaign, feedback: { ...campaign.feedback, avoid: ["startup"] } }, good).matchScore;
    const prefer = analyzeHeuristic({ ...campaign, keywords: ["onbekend"], feedback: { ...campaign.feedback, prefer: ["startup"] } }, good).matchScore;
    const preferBase = analyzeHeuristic({ ...campaign, keywords: ["onbekend"] }, good).matchScore;
    expect(avoid).toBeLessThan(base);
    expect(prefer).toBeGreaterThan(preferBase);
  });

  it("gebruikt hoofdstukken als er geen transcript is", () => {
    const desc = "Intro\n00:00 Intro\n05:30 Over geld verdienen\n12:00 Afsluiting";
    expect(parseChapters(desc, 900)).toEqual([
      { start: 0, end: 330, title: "Intro" },
      { start: 330, end: 720, title: "Over geld verdienen" },
      { start: 720, end: 900, title: "Afsluiting" },
    ]);
    const a = analyzeHeuristic(campaign, { ...good, transcript: null, description: desc });
    expect(a.timestamps).toEqual([expect.objectContaining({ start: "05:30", end: "07:00" })]);
  });

  it("fragmenten overlappen niet", () => {
    const w = bestWindows(transcript, ["geld", "ondernemen"], [], 3);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThanOrEqual(w[i - 1].end);
  });
});

describe("sanitizeAnalysis", () => {
  it("klemt scores en verwijdert ongeldige tijdstempels", () => {
    const a = sanitizeAnalysis(
      {
        matchScore: 140,
        clipScore: -5,
        verdict: "geschikt",
        reasoning: " ok ",
        ruleViolations: [],
        detectedTopics: [],
        timestamps: [
          { start: "2:15", end: "3:00", reason: "goed", hook: "" },
          { start: "05:00", end: "04:00", reason: "omgedraaid", hook: "" },
          { start: "10:00", end: "20:00", reason: "te lang", hook: "" },
          { start: "59:00", end: "59:30", reason: "na einde", hook: "" },
        ],
      },
      1800,
    );
    expect(a.matchScore).toBe(100);
    expect(a.clipScore).toBe(0);
    expect(a.timestamps).toEqual([{ start: "02:15", end: "03:00", reason: "goed", hook: "" }]);
  });
});

describe("prompt", () => {
  it("bevat campagne, feedback, metadata en transcript met tijden", () => {
    const p = buildUserPrompt({ ...campaign, feedback: { ...campaign.feedback, avoid: ["reclame"] } }, good);
    expect(p).toContain("Sam de Vries");
    expect(p).toContain("reclame");
    expect(p).toContain("[10:00] Dit had ik echt nooit verwacht!");
  });

  it("valt zonder sleutels terug op de heuristiek", async () => {
    const r = await runAnalysis(campaign, good);
    expect(r.provider).toBe("heuristic");
  });
});
