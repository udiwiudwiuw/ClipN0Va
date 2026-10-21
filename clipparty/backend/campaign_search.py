"""Campagnes zoeken en op volgorde zetten voor jouw niche.

De app haalt de lijst met campagnes op (Content Rewards, via een Apify-actor)
en laat de AI per campagne zeggen hoe goed die bij jouw niche past. De app
zoekt GEEN video's en leest GEEN campagneregels: dat regel je zelf (mp4
downloaden, briefing uploaden). Dit scherm helpt alleen bij het kiezen.
"""
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Optional

import clipper

DEFAULT_ACTOR = "tactful_anvil~whop-content-rewards-scraper"
CACHE_SECONDS = 15 * 60          # de actor rekent per resultaat af: niet bij elke klik opnieuw
MAX_FOR_AI = 60                  # zoveel campagnes gaan naar de AI
_CACHE: dict = {}


def _first(rec: dict, *names, default=None):
    for n in names:
        if rec.get(n) not in (None, ""):
            return rec[n]
        snake = re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), n)
        if rec.get(snake) not in (None, ""):
            return rec[snake]
    return default


def _money(rec: dict, *names) -> Optional[float]:
    v = _first(rec, *names)
    try:
        return round(float(str(v).replace("$", "").replace(",", "")) * 0.92, 2)  # USD naar EUR
    except (TypeError, ValueError):
        return None


def to_campaign(rec: dict) -> Optional[dict]:
    name = _first(rec, "title", "name", "campaignName")
    if not name:
        return None
    platforms = _first(rec, "platforms", "acceptedPlatforms", "allowedPlatforms", default=[])
    if isinstance(platforms, str):
        platforms = [p.strip() for p in re.split(r"[,/]", platforms) if p.strip()]
    left = _money(rec, "budgetLeft", "budgetRemaining", "remainingBudget")
    total = _money(rec, "totalBudget", "budget")
    return {
        "name": str(name)[:120],
        "creator": _first(rec, "creator", "organization", "brand", "company"),
        "cpm_eur": _money(rec, "rewardRate", "rewardPer1kViews", "cpm", "ratePer1000", "reward"),
        "budget_left_eur": left,
        "budget_total_eur": total,
        "platforms": [str(p).lower() for p in platforms],
        "language": _first(rec, "language", "languageRestriction"),
        "status": str(_first(rec, "status", default="") or "").lower(),
        "url": _first(rec, "url", "link", "campaignUrl", "opportunityLink"),
    }


def fetch_directory(token: str, actor: str = DEFAULT_ACTOR, limit: int = 500) -> tuple:
    """(campagnes, foutmelding). Resultaat 15 minuten bewaard."""
    token = (token or os.environ.get("APIFY_TOKEN", "")).strip()
    if not token:
        return [], "Vul je Apify-token in (gratis account op apify.com, of zet APIFY_TOKEN op de server)."
    hit = _CACHE.get(token)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1], None
    url = (f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"
           f"?token={token}&maxItems={limit}&limit={limit}")
    try:
        req = urllib.request.Request(
            url, data=json.dumps({"maxItems": limit, "maxResults": limit}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        msg = {401: "token niet geaccepteerd (gebruik de Personal API token)",
               402: "geen tegoed meer op je Apify-account",
               404: f"actor '{actor}' bestaat niet (meer)"}.get(e.code, f"HTTP {e.code}")
        return [], msg
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"
    if not isinstance(data, list):
        return [], "onverwacht antwoord van Apify"
    out = []
    for rec in data:
        c = to_campaign(rec) if isinstance(rec, dict) else None
        if not c or c["status"] in ("ended", "closed", "completed", "paused"):
            continue
        if c["budget_left_eur"] is not None and c["budget_left_eur"] <= 0:
            continue
        out.append(c)
    _CACHE[token] = (time.time(), out)
    return out, None


def _tokens(text: str) -> set:
    return {w for w in re.findall(r"[a-zà-ÿ0-9]{3,}", (text or "").lower())}


def _fallback_score(c: dict, niche: str) -> float:
    """Zonder AI: tekstmatch met je niche, daarna uitbetaling en budget."""
    match = len(_tokens(niche) & _tokens(f"{c['name']} {c.get('creator') or ''}"))
    return match * 3 + (c.get("cpm_eur") or 0) * 2 + min((c.get("budget_left_eur") or 0) / 5000, 3)


def rank(campaigns: list, niche: str, provider: str = "groq", api_key: Optional[str] = None) -> tuple:
    """(lijst op volgorde met 'score' en 'opinion', ai_gebruikt)."""
    for i, c in enumerate(campaigns):
        c["id"] = i
    pool = sorted(campaigns, key=lambda c: _fallback_score(c, niche), reverse=True)[:MAX_FOR_AI]
    rows = [f'{c["id"]}|{c["name"]}|{c.get("creator") or "?"}|€{c.get("cpm_eur")}/1k|'
            f'budget over €{c.get("budget_left_eur")}|{",".join(c["platforms"]) or "?"}|{c.get("language") or "?"}'
            for c in pool]
    system = ("Je helpt een clipper kiezen welke betaalde clip-campagnes bij zijn niche passen. "
              "Beoordeel eerlijk en kort, in het Nederlands. Verzin niets: je ziet alleen naam, maker, "
              "uitbetaling per 1.000 views, resterend budget, platforms en taal. Zeg erbij als je het "
              "niet zeker kunt weten. Antwoord ALLEEN met JSON.")
    user = (f"Niche van de clipper: {niche or 'niet opgegeven'}\n\nCampagnes (id|naam|maker|uitbetaling|budget|platforms|taal):\n"
            + "\n".join(rows)
            + '\n\nGeef voor elke campagne: {"id": number, "score": 0-10, "opinion": "één zin waarom wel of niet"}. '
              'Antwoord als JSON-lijst, beste eerst.')
    ai = False
    scores = {}
    raw = clipper.call_llm(system, user, provider=provider, api_key=api_key, max_tokens=4000, temperature=0.2)
    if raw:
        try:
            parsed = clipper._parse_json_block(raw)
            if isinstance(parsed, dict):
                parsed = next((v for v in parsed.values() if isinstance(v, list)), [])
            for item in parsed or []:
                scores[int(item["id"])] = (float(item.get("score", 0)), str(item.get("opinion", ""))[:240])
            ai = bool(scores)
        except Exception as e:
            print(f"[ClipNova] Campagnes beoordelen mislukt: {type(e).__name__}: {e}", flush=True)
    for c in campaigns:
        if c["id"] in scores:
            c["score"], c["opinion"] = scores[c["id"]]
        else:
            c["score"], c["opinion"] = None, ""
    # Eerst de door AI beoordeelde campagnes, daarna de rest op uitbetaling.
    campaigns.sort(key=lambda c: (c["score"] is None,
                                  -(c["score"] if c["score"] is not None else _fallback_score(c, niche))))
    return campaigns, ai
