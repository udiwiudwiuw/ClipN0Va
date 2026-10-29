import OpenAI from "openai";
import { CAPTION_LIMITS, type Platform } from "./constants";
import type { Settings } from "./settings";
import { hashString, normalizeHashtags } from "./utils";

export interface CaptionInput {
  title: string;
  caption: string;
  hashtags: string;
  campaign?: string | null;
  creator?: string | null;
  filename?: string;
}

export interface CaptionOutput {
  title: string;
  caption: string;
  hashtags: string;
  source: "ai" | "template";
}

const PLATFORM_STYLE: Record<Platform, string> = {
  tiktok: "TikTok: kort, punchy, 1-2 zinnen, max 1-2 emoji, eindig met een vraag of call-to-action. 3-6 hashtags, mix van breed (#fyp) en niche.",
  youtube: "YouTube Shorts: een pakkende titel (max 90 tekens, zonder hashtags) plus een beschrijving van 1-3 zinnen. 2-3 hashtags waaronder #Shorts.",
  instagram: "Instagram Reels: iets langer en persoonlijker, eerste regel is de hook, mag regelafbrekingen bevatten, 1-3 emoji. 5-10 relevante hashtags.",
};

const PLATFORM_TAGS: Record<Platform, string[]> = {
  tiktok: ["fyp", "foryou", "viral", "tiktoknederland"],
  youtube: ["Shorts", "shortsvideo", "viralshorts"],
  instagram: ["reels", "reelsinstagram", "explorepage", "instareels", "viralreels"],
};

const HOOKS = ["Wacht op het einde… 👀", "Dit had niemand verwacht 😳", "Kijk dit tot het eind!", "Hier gaat iedereen over praten 🔥", "Dit moment 😂", "Eerlijk: wat vind jij hiervan?"];
const CTAS = ["Volg voor meer!", "Wat zou jij doen? 👇", "Tag iemand die dit moet zien", "Deel met een vriend 🔁", "Laat je mening achter 💬", "Meer clips op mijn profiel"];

function pick<T>(arr: T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length];
}

/**
 * Sjabloon-generator (zonder OpenAI): bouwt per platform een bijschrift en
 * varieert deterministisch per `variantSeed` (bijv. account-id), zodat niet
 * elk account dezelfde tekst krijgt.
 */
export function templateCaption(input: CaptionInput, platform: Platform, variantSeed: string): CaptionOutput {
  const seed = hashString(variantSeed);
  const limits = CAPTION_LIMITS[platform];
  const base = (input.caption || input.title || input.filename?.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ") || "").trim();
  const hook = pick(HOOKS, seed);
  const cta = pick(CTAS, seed, 3);

  const clipTags = normalizeHashtags(input.hashtags).split(" ").filter(Boolean);
  const campaignTag = input.campaign ? [input.campaign.replace(/\s+/g, "")] : [];
  const creatorTag = input.creator ? [input.creator.replace(/[\s@]+/g, "")] : [];
  // Roteer de platform-tags zodat accounts verschillende sets krijgen.
  const rot = PLATFORM_TAGS[platform].map((_, i, a) => a[(i + seed) % a.length]);
  const hashtags = normalizeHashtags([...clipTags, ...campaignTag, ...creatorTag, ...rot], limits.maxHashtags);

  let caption: string;
  let title = input.title || base;
  switch (platform) {
    case "tiktok":
      caption = base ? `${base} ${seed % 2 ? "🔥" : "👀"}\n${cta}` : `${hook}\n${cta}`;
      break;
    case "youtube":
      title = (title || hook).replace(/#\S+/g, "").trim().slice(0, 90);
      caption = [base || hook, input.creator ? `Met ${input.creator}.` : "", cta].filter(Boolean).join(" ");
      break;
    case "instagram":
      caption = [hook, base, input.campaign ? `📌 ${input.campaign}` : "", cta].filter(Boolean).join("\n\n");
      break;
  }
  return { title: title.slice(0, limits.title || 200), caption: caption.slice(0, limits.caption), hashtags, source: "template" };
}

/**
 * Genereert een platform-geoptimaliseerd bijschrift. Met OpenAI-sleutel via
 * het model; zonder sleutel (of bij een fout) via de sjabloon-generator.
 */
export async function generateCaption(
  input: CaptionInput,
  platform: Platform,
  opts: { settings: Settings; variantSeed: string; variantIndex?: number; accountHandle?: string },
): Promise<CaptionOutput> {
  const apiKey = opts.settings.OPENAI_API_KEY;
  if (!apiKey) return templateCaption(input, platform, opts.variantSeed);

  try {
    const client = new OpenAI({ apiKey });
    const limits = CAPTION_LIMITS[platform];
    const res = await client.chat.completions.create({
      model: opts.settings.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.9,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Je schrijft social-media bijschriften voor korte videoclips. Antwoord alleen met JSON: " +
            '{"title": string, "caption": string, "hashtags": string[]}. Schrijf in dezelfde taal als de bronclip ' +
            "(standaard Nederlands). Verzin geen feiten die niet in de input staan. Hashtags zonder spaties.",
        },
        {
          role: "user",
          content: JSON.stringify({
            platform,
            stijl: PLATFORM_STYLE[platform],
            max_tekens_bijschrift: limits.caption,
            max_hashtags: limits.maxHashtags,
            variant: `Variant #${(opts.variantIndex ?? 0) + 1} voor account ${opts.accountHandle ?? opts.variantSeed}. ` +
              "Gebruik een andere openingszin en andere woordkeuze dan andere varianten.",
            clip: {
              titel: input.title,
              bijschrift: input.caption,
              hashtags: input.hashtags,
              campagne: input.campaign,
              creator: input.creator,
              bestandsnaam: input.filename,
            },
          }),
        },
      ],
    });
    const parsed = JSON.parse(res.choices[0]?.message?.content || "{}");
    const caption = String(parsed.caption || "").trim();
    if (!caption) throw new Error("leeg antwoord");
    return {
      title: String(parsed.title || input.title || "").slice(0, limits.title || 200),
      caption: caption.slice(0, limits.caption),
      hashtags: normalizeHashtags(parsed.hashtags ?? [], limits.maxHashtags),
      source: "ai",
    };
  } catch (err) {
    console.error("[bot] OpenAI bijschrift mislukt, sjabloon gebruikt:", (err as Error).message);
    return templateCaption(input, platform, opts.variantSeed);
  }
}
