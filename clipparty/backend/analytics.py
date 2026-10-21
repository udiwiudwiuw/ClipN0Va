"""Cijfers voor het Analytics-scherm: wat je gemaakt hebt, wat je gepost hebt,
hoeveel views het opleverde en wat elke campagne verdiende.

Views, likes en uitbetalingen komen van de gebruiker zelf (ingevuld per clip):
TikTok en Instagram geven die cijfers alleen via hun eigen goedgekeurde API's.
Verdiensten = de echte uitbetaling als die is ingevuld, anders views / 1000 x CPM.
"""
import time
from collections import defaultdict
from datetime import datetime, timedelta


def _day(ts) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def build(jobs: list, clips_by_job: dict, stats: dict, campaigns: list, days: int = 30) -> dict:
    """jobs: rijen uit accounts.user_jobs; clips_by_job: {job_id: [clip dicts]};
    stats: {(job_id, clip_id): stat-rij}; campaigns: rijen uit accounts.list_campaigns."""
    camp = {c["id"]: c for c in campaigns}
    per_campaign = defaultdict(lambda: {"clips": 0, "posted": 0, "views": 0, "likes": 0,
                                        "earned_est": 0.0, "earned_paid": 0.0, "has_paid": False})
    per_style = defaultdict(lambda: {"clips": 0, "posted": 0, "views": 0})
    made_per_day = defaultdict(int)
    views_per_day = defaultdict(int)
    rows = []
    totals = {"clips": 0, "posted": 0, "views": 0, "likes": 0, "comments": 0, "shares": 0,
              "earned": 0.0, "compliant": 0, "seconds": 0.0, "runs": len(jobs)}

    for job in jobs:
        c = camp.get(job.get("campaign_id"))
        cpm = float(c["cpm_eur"]) if c else 0.0
        key = c["id"] if c else 0
        for clip in clips_by_job.get(job["job_id"], []) or []:
            st = stats.get((job["job_id"], clip.get("id"))) or {}
            views = int(st.get("views") or 0)
            likes = int(st.get("likes") or 0)
            posted = bool(st.get("posted"))
            paid = st.get("payout_eur")
            est = views / 1000.0 * cpm
            earned = float(paid) if paid is not None else est

            totals["clips"] += 1
            totals["seconds"] += float(clip.get("end", 0)) - float(clip.get("start", 0))
            if (clip.get("compliance") or {}).get("passed", True):
                totals["compliant"] += 1
            made_per_day[_day(job["created"])] += 1
            if posted:
                totals["posted"] += 1
                views_per_day[_day(st.get("posted_at") or job["created"])] += views
            totals["views"] += views
            totals["likes"] += likes
            totals["comments"] += int(st.get("comments") or 0)
            totals["shares"] += int(st.get("shares") or 0)
            totals["earned"] += earned

            pc = per_campaign[key]
            pc["clips"] += 1
            pc["posted"] += int(posted)
            pc["views"] += views
            pc["likes"] += likes
            pc["earned_est"] += est
            if paid is not None:
                pc["earned_paid"] += float(paid)
                pc["has_paid"] = True

            style = job.get("hook_style") or "tiktok"
            ps = per_style[style]
            ps["clips"] += 1
            ps["posted"] += int(posted)
            ps["views"] += views

            rows.append({
                "job_id": job["job_id"], "clip_id": clip.get("id"), "title": clip.get("title") or clip.get("hook") or "",
                "hook": clip.get("hook", ""), "url": clip.get("url"), "campaign": c["name"] if c else "",
                "posted": posted, "platform": st.get("platform") or "", "post_url": st.get("post_url") or "",
                "views": views, "likes": likes, "comments": int(st.get("comments") or 0),
                "shares": int(st.get("shares") or 0), "payout_eur": paid, "earned": round(earned, 2),
                "created": job["created"], "score": clip.get("score"),
            })

    today = datetime.now().date()
    series = []
    for i in range(days - 1, -1, -1):
        d = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        series.append({"day": d, "made": made_per_day.get(d, 0), "views": views_per_day.get(d, 0)})

    campaigns_out = []
    for key, pc in per_campaign.items():
        c = camp.get(key)
        earned = pc["earned_paid"] if pc["has_paid"] else pc["earned_est"]
        campaigns_out.append({
            "id": key, "name": c["name"] if c else "Zonder campagne", "cpm_eur": c["cpm_eur"] if c else None,
            "clips": pc["clips"], "posted": pc["posted"], "views": pc["views"], "likes": pc["likes"],
            "earned": round(earned, 2), "earned_is_estimate": not pc["has_paid"],
            "per_clip": round(earned / pc["posted"], 2) if pc["posted"] else 0.0,
        })
    campaigns_out.sort(key=lambda r: -r["earned"])

    posted_rows = [r for r in rows if r["posted"]]
    engagement = ((totals["likes"] + totals["comments"] + totals["shares"]) / totals["views"] * 100
                  if totals["views"] else 0.0)
    return {
        "totals": {**totals, "earned": round(totals["earned"], 2),
                   "avg_views": round(totals["views"] / len(posted_rows)) if posted_rows else 0,
                   "engagement_pct": round(engagement, 2),
                   "compliant_pct": round(totals["compliant"] / totals["clips"] * 100) if totals["clips"] else 0,
                   "avg_seconds": round(totals["seconds"] / totals["clips"], 1) if totals["clips"] else 0},
        "series": series,
        "campaigns": campaigns_out,
        "styles": [{"style": k, **v, "avg_views": round(v["views"] / v["posted"]) if v["posted"] else 0}
                   for k, v in sorted(per_style.items(), key=lambda kv: -kv[1]["views"])],
        "top": sorted(posted_rows, key=lambda r: -r["views"])[:5],
        "clips": sorted(rows, key=lambda r: -r["created"]),
        "generated": time.time(),
    }
