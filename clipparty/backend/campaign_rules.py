"""
Turns a free-text campaign briefing (like a Clipping Culture / whitelist
brief) into a structured rule-set, then uses that rule-set to:
  - steer clip selection (min duration, required on-screen messaging)
  - auto-generate a compliant caption per clip (correct disclosure placement,
    required hashtags/tagging, required talking points)
  - run an automated compliance check per clip before it's shown to the user
"""

import json
import re
from typing import Optional

from clipper import call_llm, _parse_json_block

RULES_SYSTEM_PROMPT = """You extract structured, machine-checkable rules from an influencer/UGC
campaign briefing. Read the briefing carefully and output ONLY a JSON object (no prose, no
markdown fences) with this exact shape:

{
  "platforms": ["tiktok"],
  "tagging": {"tiktok": "@handle", "instagram": "@handle"},
  "required_disclosure": ["#Ad", "#Advertisement", "#Sponsored"],
  "disclosure_placement": "short instruction, e.g. 'alone on its own line, first element after caption text'",
  "required_hashtags": ["hashtags the brief explicitly mandates, e.g. from 'always use the hashtag #X' -- NOT hashtag examples given only as inspiration"],
  "suggested_hashtags": ["optional hashtag examples the brief only suggests as ideas, e.g. after 'you could add' / 'think of' / 'denk aan' / 'optioneel' -- these are NOT required and must not be treated as mandatory"],
  "caption_must_mention": ["non-hashtag facts/topics/keywords the caption must reference, e.g. a product name, a specific claim, or that something is free"],
  "onscreen_text_must_mention": ["list of specific facts/keywords on-screen text must reference, empty if on-screen text is optional/not required"],
  "min_duration_seconds": number or null,
  "max_duration_seconds": number or null,
  "allow_added_audio": true/false,
  "allow_background_music": true/false,
  "source_restriction": "exact description of which footage/sources are allowed, quoting the key constraint (e.g. 'only from the official Twitch VOD/content link, clips from any other source are rejected'), or null if no restriction is stated",
  "language_restriction": "e.g. 'English only', or null",
  "language_code": "ISO-639-1 code implied by language_restriction, e.g. 'en' or 'nl', or null if no language requirement",
  "creator_name": "the name of the creator/streamer this campaign is about, or null if not applicable",
  "campaign_topic": "what the footage has to be about, in 3-8 words in the briefing's own language (e.g. 'Box 3 belasting petitie'), or null if any content of the creator is fine",
  "creator_must_be_recognizable": true or false -- true if the brief requires the creator's face to be
    visible AND/OR their name/handle to be mentioned in the caption or on-screen text so viewers
    know who the content is about (common in UGC/whitelisting campaigns about a specific creator),
  "max_hashtags_besides_disclosure": number or null,
  "payout_requirements": ["every concrete condition for actually getting paid, e.g. 'minimum 1000 views', 'likes must stay visible (not hidden)', 'comments must stay enabled', 'post must stay live at least 30 days', 'must be public', 'no bots/fake engagement', 'no story-only posting', 'no reposting the same clip more than N times' -- extract each one from the brief, phrased as a short checkable sentence"],
  "other_rules": ["any other must-follow rules not covered above, e.g. NSFW/violence bans, no negative portrayal of the creator, extra rewards/incentives worth knowing about"],
  "creative_tips": ["EVERY tip the brief gives about what works best / what makes a clip perform, e.g. sections like 'wat werkt het beste', 'tips', 'what works best', 'do's'. Examples: 'hook in the first 2 seconds, start with the moment not the build-up', 'cut on the beat and time a drop', 'strong bars', 'think as a viewer: why would someone share this'. One short sentence each, in the brief's language, keep the concrete advice"],
  "caption_ideas": ["every example caption/hook the brief offers as inspiration (sections like 'caption ideeen'), verbatim. These are INSPIRATION ONLY: the brief usually says not to copy them literally"],
  "editing_tips": ["editing style the brief recommends or allows, e.g. 'split-screen with strong moment on top and music video below', 'large readable subtitles', 'zooms', 'sound effects', 'voice-overs', 'compilations', 'top 3 formats'"]
}

If a field isn't mentioned in the briefing, use null / empty array / true as a sensible default
(default allow_added_audio and allow_background_music to true unless the brief says otherwise).
This matters for real money: clips that don't follow these rules will get rejected and not paid
out, so extract every concrete, checkable requirement -- especially source_restriction, platforms,
and payout_requirements, which people tend to skim past but which directly gate getting paid.
Do not upgrade a hashtag example ("think of #a #b #c") into required_hashtags -- only hashtags the
brief states as mandatory belong there.

Briefs almost always contain a tips section ("wat werkt het beste", "caption ideeen", "bewerken van
clips" and similar). Do not skip it: copy every concrete tip into creative_tips, every example
caption into caption_ideas and every editing suggestion into editing_tips. Rules about variety (no
reuploads of the same clip, make every clip different, never upload a full session/video in its
entirety, always make your own edit) belong in other_rules.
"""


def extract_rules(briefing_text: str, provider: str = "anthropic", api_key: Optional[str] = None) -> dict:
    if not briefing_text or not briefing_text.strip():
        return _default_rules()
    text = call_llm(RULES_SYSTEM_PROMPT, briefing_text, provider=provider, api_key=api_key, max_tokens=2800)
    if text is None:
        return _heuristic_rules(briefing_text)
    try:
        rules = _parse_json_block(text)
        return {**_default_rules(), **rules}
    except Exception as e:
        print(f"[ClipNova] Kon LLM-antwoord voor regel-extractie niet lezen ({type(e).__name__}: {e}) -- gebruik heuristische fallback.")
        return _heuristic_rules(briefing_text)


def _default_rules() -> dict:
    return {
        "platforms": [], "tagging": {}, "required_disclosure": [],
        "disclosure_placement": None, "required_hashtags": [],
        "suggested_hashtags": [], "caption_must_mention": [],
        "onscreen_text_must_mention": [], "min_duration_seconds": None,
        "max_duration_seconds": None, "allow_added_audio": True,
        "allow_background_music": True, "source_restriction": None,
        "language_restriction": None, "language_code": None,
        "creator_name": None, "campaign_topic": None, "creator_must_be_recognizable": False,
        "max_hashtags_besides_disclosure": None,
        "payout_requirements": [],
        "other_rules": [],
        "creative_tips": [], "caption_ideas": [], "editing_tips": [],
    }


_PLATFORM_KEYWORDS = ["tiktok", "instagram", "youtube", "twitch", "facebook", "snapchat", "x.com", "twitter"]


# Style-sheet syntax that looks exactly like a handle or a hashtag but is not:
# @media / @keyframes are CSS at-rules, #fff / #0d1117 are colour codes. Left
# unfiltered they end up presented as the campaign's required tagging and
# hashtags, which is worse than finding nothing.
_CSS_AT_RULES = {
    "media", "keyframes", "supports", "layer", "import", "font-face", "charset",
    "page", "namespace", "container", "property", "scope", "starting-style",
    "counter-style", "font-feature-values", "tailwind", "apply", "screen",
}
_HEX_COLOUR = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def _is_real_handle(handle: str) -> bool:
    name = handle.lstrip("@").split(".")[0].lower()
    if name in _CSS_AT_RULES:
        return False
    # A bare unit or keyword after "@" is styling, not a person.
    return len(name) >= 3 and not name.isdigit()


def _is_real_hashtag(tag: str) -> bool:
    if _HEX_COLOUR.match(tag):
        return False
    body = tag.lstrip("#")
    # Pure hex strings are colours even at odd lengths.
    if len(body) >= 3 and all(c in "0123456789abcdefABCDEF" for c in body):
        return False
    return len(body) >= 2 and not body.isdigit()


_TIP_SECTIONS = [
    ("creative_tips", ("wat werkt het beste", "what works best", "what works", "tips", "do's", "dos")),
    ("caption_ideas", ("caption ideeën", "caption ideeen", "caption ideas", "caption idee")),
    ("editing_tips", ("bewerken van clips", "bewerken", "editing", "toegestaan")),
]


def _extract_tip_sections(text: str) -> dict:
    """Regex fallback for the tips sections of a brief. Looks for a heading
    line (short, often capitals) and collects the lines under it until the
    next heading, so the tips still reach the clip and caption prompts when
    no LLM is available."""
    out = {"creative_tips": [], "caption_ideas": [], "editing_tips": []}
    lines = [l.strip(" \t•·●▪-*") for l in text.splitlines()]
    current = None
    for line in lines:
        if not line:
            continue
        low = line.lower().rstrip(":")
        heading = None
        if len(line) <= 45:
            for key, names in _TIP_SECTIONS:
                if any(low == n or low.startswith(n) for n in names):
                    heading = key
                    break
        if heading:
            current = heading
            continue
        # A new all-caps heading that is not a tips section ends the section.
        if len(line) <= 45 and line.isupper():
            current = None
            continue
        if current and 3 < len(line) <= 220 and "niet letterlijk" not in low and "not literally" not in low:
            out[current].append(line)
    return {k: list(dict.fromkeys(v))[:12] for k, v in out.items()}


def _heuristic_rules(text: str) -> dict:
    """Regex fallback if no LLM key is configured (or the LLM call fails),
    so the app still enforces the most common, easy-to-detect requirements.
    This is intentionally basic -- it won't catch judgment calls the way a
    real model would (e.g. telling a mandatory hashtag apart from a merely
    suggested one is genuinely ambiguous for regex); check the terminal
    logs to see whether the real LLM path was used for a given run."""
    rules = _default_rules()
    lower = text.lower()

    disclosures = [tag for tag in ["#ad", "#advertisement", "#sponsored"] if tag in lower]
    if disclosures:
        rules["required_disclosure"] = [f"#{d[1:].capitalize()}" for d in disclosures]

    # social handles, keeping dots so "@3atroes.live" isn't chopped into
    # "@3atroes" -- trim a trailing sentence-ending dot separately.
    raw_handles = re.findall(r"@[A-Za-z0-9_.-]+", text)
    handles = [h[:-1] if h.endswith(".") else h for h in raw_handles]
    handles = [h for h in handles if _is_real_handle(h)]
    if handles:
        rules["tagging"] = {"general": list(dict.fromkeys(handles))}
        # best-effort creator name guess from the first handle, e.g.
        # "@3atroes.live" -> "3atroes"
        guess = handles[0].lstrip("@").split(".")[0]
        if guess:
            rules["creator_name"] = guess

    # Hashtags: without real language understanding we can't reliably tell
    # "always use #X" apart from "you could add something like #X #Y" -- so
    # to avoid the earlier bug (treating example hashtags as mandatory),
    # every plain hashtag found goes into suggested_hashtags (not enforced)
    # unless it sits right next to an explicit "always/altijd/verplicht"
    # cue, in which case it's treated as required.
    hashtags = [h for h in re.findall(r"#[A-Za-z0-9_]+", text)
                if h.lower() not in ("#ad", "#advertisement", "#sponsored") and _is_real_hashtag(h)]
    required_cue = re.compile(
        r"(altijd|verplicht|always|must (?:use|include)|gebruik (?:de |)hashtag)[^#]{0,80}(#[A-Za-z0-9_]+)",
        re.IGNORECASE | re.DOTALL,
    )
    required_from_cue = [m.group(2) for m in required_cue.finditer(text)]
    if required_from_cue:
        rules["required_hashtags"] = list(dict.fromkeys(required_from_cue))
    suggested = [h for h in hashtags if h not in rules["required_hashtags"]]
    if suggested:
        rules["suggested_hashtags"] = list(dict.fromkeys(suggested))

    # source restriction -- look for the common "only/uitsluitend/alleen ...
    # official ..." phrasing and keep the sentence it's in as context.
    source_cue = re.search(
        r"([^.\n]*\b(?:only|uitsluitend|alleen)\b[^.\n]*\b(?:officiele|officiële|official|approved|goedgekeurde)\b[^.\n]*)",
        text, re.IGNORECASE,
    )
    if source_cue:
        rules["source_restriction"] = source_cue.group(1).strip()

    found_platforms = [p for p in _PLATFORM_KEYWORDS if p in lower]
    if found_platforms:
        rules["platforms"] = list(dict.fromkeys(found_platforms))

    dur_match = re.search(r"(?:at least|minimaal|minimum)\s+(\d+)\s*(?:seconds|seconden|sec|s\b)", lower)
    if dur_match:
        rules["min_duration_seconds"] = int(dur_match.group(1))

    if "no background music" in lower or "no added audio" in lower or "original audio" in lower:
        rules["allow_added_audio"] = False
        rules["allow_background_music"] = False

    # Briefs phrase this loosely: "English only", "English content only",
    # "content must be in English". Match the language plus a nearby "only".
    if re.search(r"english[\w\s]{0,15}only|only[\w\s]{0,15}english", lower):
        rules["language_restriction"] = "English only"
        rules["language_code"] = "en"
    elif "nederlandstalig" in lower or re.search(r"dutch[\w\s]{0,15}only", lower):
        rules["language_restriction"] = "Nederlandstalig"
        rules["language_code"] = "nl"

    if "herken" in lower or "recognizable" in lower:
        rules["creator_must_be_recognizable"] = True

    # payout/eligibility conditions -- these decide whether a compliant clip
    # actually earns anything, so worth catching even heuristically.
    payout = []
    views_match = (re.search(r"(?:minimaal|minimum)\s+([\d.,]+)\s*views", lower)
                   or re.search(r"([\d.,]+)\s*views\s*(?:minimaal|minimum)", lower))
    if views_match:
        payout.append(f"Minimaal {views_match.group(1)} views voor uitbetaling")
    if "hidden likes" in lower or "verborgen likes" in lower or ("likes" in lower and "zichtbaar" in lower):
        payout.append("Likes moeten zichtbaar blijven (geen hidden likes)")
    if "comments" in lower and ("aan" in lower or "enabled" in lower):
        payout.append("Comments moeten aan blijven staan")
    # "minimaal 30 dagen", "at least 30 days", and "30 days minimum" all mean
    # the same thing; the number can sit on either side of the qualifier.
    days_match = (re.search(r"(?:minimaal|minimum|at least)\s+(\d+)\s*(?:dagen|days)", lower)
                  or re.search(r"(\d+)\s*(?:dagen|days)\s*(?:minimaal|minimum|or more)", lower))
    if days_match:
        payout.append(f"Post moet minimaal {days_match.group(1)} dagen live blijven staan")
    if "openbaar" in lower or "public" in lower:
        payout.append("Post moet openbaar zijn (geen private posts)")
    if "fake engagement" in lower or "view bots" in lower or "nep-engagement" in lower:
        payout.append("Geen fake engagement / view bots toegestaan")
    if payout:
        rules["payout_requirements"] = payout

    rules.update(_extract_tip_sections(text))
    return rules


TITLE_CAPTION_SYSTEM_PROMPT = """You write the posting package for one short clip in a paid brand
campaign, strictly following the campaign's rule-set. Output ONLY a JSON object, no prose:

{"title": "short catchy title for the clip, max 60 characters, describing what happens",
"description": "one short line (max ~100 characters) for the platform's description field:
the first part names the topic with the words a viewer would actually search for, the rest teases
what happens without spoiling it, with 0-2 fitting emojis", "caption": "the full social caption
text, written to maximize views/engagement, following caption_must_mention and
disclosure_placement exactly, and including every tag from required_hashtags", "hashtags":
["2-3 extra specific tags picked from suggested_hashtags if any are given, else a couple of relevant
niche ones (never #fyp, #foryou or #viral) -- these are supplementary, not a substitute for required_hashtags which belong in the
caption itself"], "onscreen_text": "on-screen text for the clip if onscreen_text_must_mention is
non-empty, else the short punchy hook text (clip_hook) with its emojis"}

BASE THE CAPTION ON WHAT IS ACTUALLY SAID: clip_transcript holds the words spoken in this clip.
Pick the most interesting point, question or claim from it and build the caption around that, so
a viewer immediately knows why to watch. A good caption opens with a hook (a question, a bold
statement or a curiosity gap), adds one line of context, then the hashtags. Never leave the caption
empty, and never make it just the title repeated.

WRITE EVERYTHING (title, description, caption, onscreen_text) IN {lang}. This is not optional:
the clip is posted to an audience in that language, and campaigns routinely require it. The
source transcript may be messy, partly mistranscribed, or contain fragments in other scripts --
ignore that noise entirely and write clean, natural {lang}. Never copy raw transcript text into
the title; write a short line describing what actually happens in the clip. Only handles
(@names) and hashtags keep their original spelling.

The disclosure tag(s) from required_disclosure must appear in the caption exactly as specified by
disclosure_placement (usually: alone on its own line, first element after the main caption text).
Every tag in required_hashtags MUST appear verbatim in the caption -- these are mandatory, unlike
suggested_hashtags which are optional inspiration only. If creator_must_be_recognizable is true
and a creator_name is given, make sure the title, caption, or on-screen text clearly names/
references that creator. Respect max_hashtags_besides_disclosure if set. Keep everything punchy
and native to short-form platforms (TikTok/YouTube Shorts/Instagram Reels), not corporate-sounding.

USE THE BRIEF'S OWN TIPS: rules.creative_tips and rules.editing_tips hold what the campaign says
works best; rules.caption_ideas are example captions. Match the tone and angle of those examples
and apply the tips, but NEVER copy an example literally (briefs usually forbid it) and never reuse
the same wording for different clips: invent a caption that fits what is actually said in this clip.

BE SPECIFIC, NEVER GENERIC: the on-screen text and the description say WHAT HAPPENS in this specific
clip (who, what), and the caption is a short reaction or question about it (see CAPTION STYLE). Read clip_transcript
and clip_reason and use real details from them. Write in {lang}, the language spoken in the clip.
BAD (empty hype that fits any clip, viewers scroll past it): "You won't believe what happens next",
"Her insane guess will blow your mind", "Can you guess what she shouted?", "Wait until you see
what he says", "Dit ga je niet geloven", "Hier is wat hij zegt over 1".
GOOD (concrete event, for the description and on-screen text): "Gio laat Athena vloggen om Jade te
pesten", "Hij belooft zijn chat 1000 euro als dit lukt", "She bets her whole inventory on one dice
roll". GOOD short captions: "Toxic Gio hoogtepunt? 😭", "Wat vinden jullie? 👇". It must still make
sense if the video is muted.
If clip_transcript is garbled, tiny or unclear, do NOT invent details or build the caption on a
number or word you are unsure about: describe the situation in plain, careful words instead.
Only promise something that really happens in clip_transcript or clip_reason. Use 0-2 emojis in the
description and 1-3 in the caption, placed at the end of a sentence, never a wall of emojis.
Emojis never replace the required disclosure or hashtags.

CAPTION STYLE (modelled on Dutch clip pages whose short clips regularly reach 10k-70k views; the
on-screen hook already tells the story, so the caption stays small and starts a conversation):
- The caption is ONE very short line, 3-8 words (max ~60 characters), plus 1-2 emoji. It is a
  reaction, an opinion question or a gentle curiosity hook, never a summary of the clip. Examples of
  the register (do not copy, write your own for this clip): "Hoezo boeide dit toen niemand? 🥀",
  "Toxic Gio hoogtepunt? 😭", "Wat vinden jullie? 👇", "Oh no 😭", "Wie had dit gedaan?".
  Mix the three kinds across clips: an opinion question that makes people pick a side, a short
  reaction, and a hint of what to watch for. Never the same sentence on two clips.
- Never repeat the hook text in the caption; the caption adds a reaction or a question to it.
- MATCH THE TONE OF THE CLIP (see clip_hook and clip_transcript): drama and funny clips get a light,
  emotional reaction with emoji like 😭 💀 🥀; a serious clip (money, business, advice) gets a calm
  question with no jokes. The caption must not contradict the hook.
- Search: people look for clips by NAME (of the person, creator, show or game). The names of the
  people who are actually in the clip must appear in the hook, in the description and as hashtags.
  Only use names that are really said in clip_transcript, in rules, or in the source title; never
  guess a name from a garbled transcript.
- HASHTAGS go at the end, 3-5 in total (required ones count; TikTok allows 5 at most). There is no
  list of "viral hashtags" that works: a tag only helps when it says what THIS clip is about. Order
  of importance:
  1) every person or creator who is clearly in the clip, as a name tag (#gio #athena #jade). Use
     the name people would search: first name or well-known name, lower case, one word;
  2) the show, channel, game or topic that is really in the clip (#valorant, #podcast);
  3) what kind of clip it is (#funnymoments, #clutch, #drama, #storytime, #reaction);
  4) at most one broad community tag (#gaming, #streamer), or none.
  Never use #fyp, #foryou, #foryoupage, #viral or #trending, and no tag unrelated to the clip. If the
  brief mandates tags, those come first and the brief wins.
- The "description" is ONE short line (max ~100 characters) that names who is in the clip and what
  happens, in plain words someone would search for, with the same names as the hook. It can lean on
  the hook but must not be an exact copy of the caption.
- Do not promise anything the clip does not deliver: viewers who feel tricked leave early and that
  hurts the clip.
"""


LANG_NAMES = {"nl": "Dutch", "en": "English", "de": "German", "fr": "French", "es": "Spanish"}


# Tags die geen onderwerp aanduiden en dus geen bereik opleveren, zeker niet als ze op elke
# clip staan. Verplichte tags uit een briefing blijven altijd staan.
BANNED_TAGS = {"#fyp", "#foryou", "#foryoupage", "#fy", "#viral", "#trending", "#xyzbca",
               "#fypage", "#foryourpage", "#viralvideo", "#tiktok"}
MAX_TAGS = 5


def clean_hashtags(caption: str, tags, rules: dict) -> tuple:
    """Haalt nutteloze algemene tags weg en houdt het totaal op MAX_TAGS (tenzij de
    briefing er meer eist). Geeft (bijschrift, losse tags) terug."""
    required = {str(t).lower() for t in (rules or {}).get("required_hashtags") or []}
    disclosure = {str(t).lower() for t in (rules or {}).get("required_disclosure") or []}
    keep_always = required | disclosure

    def bad(tag):
        return tag.lower() in BANNED_TAGS and tag.lower() not in keep_always

    caption = caption or ""
    for t in set(re.findall(r"#\w+", caption)):
        if bad(t):
            caption = re.sub(r"\s*" + re.escape(t) + r"(?!\w)", "", caption)
    extra = [t for t in (tags or []) if not bad(str(t))]
    in_caption = len(set(re.findall(r"#\w+", caption)))
    room = max(0, max(MAX_TAGS, len(required)) - in_caption)
    return caption.rstrip(), extra[:room]


def dedupe_hashtags(caption: str, tags) -> list:
    """Alleen tags houden die nog niet in het bijschrift staan, zonder dubbelen.

    Het model zet hashtags vaak al in het bijschrift zelf en geeft ze daarna
    nog eens los terug. Samen getoond stonden ze er dan twee keer.
    """
    in_caption = {t.lower() for t in re.findall(r"#\w+", caption or "")}
    seen, out = set(in_caption), []
    for t in tags or []:
        t = str(t).strip()
        if not t:
            continue
        if not t.startswith(("#", "@")):
            t = "#" + t
        key = t.lower()
        if key in seen or (t.startswith("@") and key in (caption or "").lower()):
            continue
        seen.add(key)
        out.append(t)
    return out


def generate_caption(hook: str, reason: str, rules: dict, provider: str = "anthropic",
                     api_key: Optional[str] = None, output_language: str = "nl",
                     transcript: str = "", people: Optional[list] = None) -> dict:
    rules = rules or {}
    lang_code = (rules.get("language_code") or output_language or "nl").lower()
    lang = LANG_NAMES.get(lang_code, lang_code)
    # Plain replace, not .format(): this prompt contains a literal JSON
    # example with single braces ({"title": ...}), and .format() reads those
    # as placeholders and raises KeyError: 'title'.
    system = TITLE_CAPTION_SYSTEM_PROMPT.replace("{lang}", lang)
    rules = rules or {}
    payload = {"clip_hook": hook, "clip_reason": reason,
               "clip_transcript": (transcript or "")[:1500], "rules": rules}
    if people:
        payload["people_in_clip"] = people
        system += ("\n\nPEOPLE IN THIS CLIP: \"people_in_clip\" lists who is really on screen (checked by "
                   "face recognition or given by the user). Use only these names for people; never invent or "
                   "swap a name. If a person is not in that list, describe them without a name.")
    user = json.dumps(payload, ensure_ascii=False)
    # Ruim: denkende modellen (zoals gpt-oss op Groq) gebruiken een deel van
    # de tokens om na te denken; met 600 bleef er soms niets over voor het antwoord.
    text = call_llm(system, user, provider=provider, api_key=api_key, max_tokens=1500)
    if not text:
        return _heuristic_caption(hook, rules, transcript)
    try:
        data = _parse_json_block(text)
        if not isinstance(data, dict):
            raise ValueError("geen JSON-object")
        # Fill in anything the model left out rather than letting a missing
        # key take down the whole run further downstream.
        base = _heuristic_caption(hook, rules, transcript)
        for key in ("title", "description", "caption", "hashtags", "onscreen_text"):
            if not data.get(key):
                data[key] = base[key]
        data["caption"], data["hashtags"] = clean_hashtags(
            data.get("caption", ""), data.get("hashtags"), rules)
        data["hashtags"] = dedupe_hashtags(data.get("caption", ""), data.get("hashtags"))
        data["ai"] = True
        return data
    except Exception as e:
        print(f"[ClipNova] Kon LLM-antwoord voor caption niet lezen ({type(e).__name__}: {e}) -- gebruik heuristische fallback.", flush=True)
        return _heuristic_caption(hook, rules, transcript)


def _heuristic_caption(hook: str, rules: dict, transcript: str = "") -> dict:
    """Noodbijschrift als de AI niet bereikbaar is. Nooit leeg: zonder hook
    de eerste zin van wat er gezegd wordt."""
    rules = rules or {}
    if not hook and transcript:
        first = re.split(r"(?<=[.!?])\s+", transcript.strip())[0]
        hook = first[:140]
    caption = hook or ""
    disclosure = rules.get("required_disclosure") or []
    if disclosure:
        caption += "\n\n" + disclosure[0]
    required_tags = rules.get("required_hashtags") or []
    if required_tags:
        caption += "\n" + " ".join(required_tags)
    tags = list(rules.get("suggested_hashtags") or [])[:3]
    for handles in (rules.get("tagging") or {}).values():
        if isinstance(handles, list):
            tags.extend(handles)
        elif handles:
            tags.append(handles)
    creator = rules.get("creator_name")
    title = (hook or (f"{creator} moment" if creator else "Highlight"))[:60]
    description = hook or ""
    if not description:
        description = "Let op wat er gebeurt 👀"
    if creator and creator.lower() not in description.lower():
        description = f"{description} -- met {creator}".strip(" -")
    return {
        "title": title, "description": description, "caption": caption,
        "hashtags": dedupe_hashtags(caption, tags), "onscreen_text": hook, "ai": False,
    }


def check_compliance(clip_duration: float, caption: str, onscreen_text: str, rules: dict,
                      face_detected: Optional[bool] = None, detected_language: Optional[str] = None,
                      title: str = "") -> dict:
    checks = {}

    if rules.get("min_duration_seconds"):
        checks["min_duration"] = clip_duration >= rules["min_duration_seconds"]
    if rules.get("max_duration_seconds"):
        checks["max_duration"] = clip_duration <= rules["max_duration_seconds"]

    disclosures = rules.get("required_disclosure") or []
    if disclosures:
        checks["disclosure_present"] = any(d.lower() in caption.lower() for d in disclosures)
        if checks["disclosure_present"]:
            lines = [l.strip() for l in caption.splitlines() if l.strip()]
            checks["disclosure_on_own_line"] = any(
                l.lower() in [d.lower() for d in disclosures] for l in lines
            )

    required_tags = rules.get("required_hashtags") or []
    if required_tags:
        checks["required_hashtags_present"] = all(t.lower() in caption.lower() for t in required_tags)

    must_mention = rules.get("caption_must_mention") or []
    if must_mention:
        checks["caption_covers_required_points"] = any(
            kw.lower() in caption.lower() for kw in must_mention
        )

    onscreen_required = rules.get("onscreen_text_must_mention") or []
    if onscreen_required:
        checks["onscreen_text_covers_required_points"] = any(
            kw.lower() in (onscreen_text or "").lower() for kw in onscreen_required
        )

    # This is the check that decides whether money is actually earnable for
    # campaigns built around one specific creator: the brief usually accepts
    # ANY of face-visible / name-tagged / name-in-caption-or-title as proof
    # the creator is recognizable, so this passes if at least one holds.
    if rules.get("creator_must_be_recognizable"):
        creator = (rules.get("creator_name") or "").lower()
        handles = []
        for v in (rules.get("tagging") or {}).values():
            handles.extend(v if isinstance(v, list) else [v])
        text_blob = f"{caption} {title} {onscreen_text}".lower()
        name_mentioned = bool(creator) and creator in text_blob
        handle_tagged = any(h.lower() in caption.lower() for h in handles if h)
        checks["creator_recognizable"] = bool(face_detected) or name_mentioned or handle_tagged

    if rules.get("language_code") and detected_language:
        checks["language_match"] = detected_language.lower() == rules["language_code"].lower()

    passed = all(v for v in checks.values()) if checks else True
    checks = {k: bool(v) for k, v in checks.items()}
    return {"checks": checks, "passed": bool(passed)}
