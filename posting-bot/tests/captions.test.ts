import { describe, expect, it } from "vitest";
import { generateCaption, templateCaption } from "@/lib/ai";
import { CAPTION_LIMITS } from "@/lib/constants";
import { getSettings } from "@/lib/settings";
import { normalizeHashtags } from "@/lib/utils";

const clip = { title: "Hij gaf het eerlijke antwoord", caption: "Niemand zag dit aankomen", hashtags: "#podcast, interview", campaign: "Zomer Campagne", creator: "Sam" };

describe("normalizeHashtags", () => {
  it("dedupliceert, voegt # toe en beperkt het aantal", () => {
    expect(normalizeHashtags("podcast #Podcast, #clips  fyp!", 2)).toBe("#podcast #clips");
  });
});

describe("templateCaption", () => {
  it("varieert per account", () => {
    const texts = ["acc1", "acc2", "acc3", "acc4", "acc5"].map((seed) => {
      const c = templateCaption(clip, "instagram", seed);
      return c.caption + c.hashtags;
    });
    expect(new Set(texts).size).toBeGreaterThan(1);
  });

  it("is deterministisch per account", () => {
    expect(templateCaption(clip, "tiktok", "x")).toEqual(templateCaption(clip, "tiktok", "x"));
  });

  it("respecteert platformlimieten en neemt clip-hashtags mee", () => {
    for (const p of ["tiktok", "youtube", "instagram"] as const) {
      const c = templateCaption(clip, p, "seed");
      expect(c.hashtags.split(" ").length).toBeLessThanOrEqual(CAPTION_LIMITS[p].maxHashtags);
      expect(c.hashtags).toContain("#podcast");
      expect(c.caption.length).toBeLessThanOrEqual(CAPTION_LIMITS[p].caption);
    }
    expect(templateCaption(clip, "youtube", "s").title).not.toMatch(/#/);
  });

  it("valt zonder OpenAI-sleutel terug op sjablonen", async () => {
    const out = await generateCaption(clip, "tiktok", { settings: await getSettings(), variantSeed: "a" });
    expect(out.source).toBe("template");
  });
});
