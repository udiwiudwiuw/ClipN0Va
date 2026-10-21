"""Gebruikers, abonnementen, proefperiode, eigen merk, campagnes en clipstatistieken.

Alles staat in één SQLite-bestand (storage/clipnova.db), zodat de app zonder
aparte databaseserver draait. Wachtwoorden worden met scrypt gehasht.
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

TRIAL_DAYS = int(os.environ.get("CLIPNOVA_TRIAL_DAYS", "7"))
TRIAL_CLIPS = int(os.environ.get("CLIPNOVA_TRIAL_CLIPS", "10"))
SESSION_DAYS = 30

# Prijzen in euro per maand; clips = maximum per periode van 30 dagen.
PLANS = {
    "trial":   {"name": "Proefperiode", "price_eur": 0.0,   "clips": TRIAL_CLIPS},
    "starter": {"name": "Starter",      "price_eur": 12.99, "clips": 30},
    "pro":     {"name": "Pro",          "price_eur": 24.99, "clips": 100},
    "studio":  {"name": "Studio",       "price_eur": 49.99, "clips": 300},
    "admin":   {"name": "Beheerder",    "price_eur": 0.0,   "clips": 0},   # 0 = onbeperkt
}

DEFAULT_BRAND = {
    "hook_style": "tiktok", "hook_position": "boven", "brand_color": "#7C5CFF",
    "brand_text_color": "#FFFFFF", "subtitle_color": "#FFE500", "watermark": "",
    "brand_name": "", "logo": "",
}

_LOCK = threading.Lock()
_DB: Optional[sqlite3.Connection] = None


def init(storage: Path) -> None:
    global _DB
    storage.mkdir(parents=True, exist_ok=True)
    _DB = sqlite3.connect(str(storage / "clipnova.db"), check_same_thread=False, isolation_level=None)
    _DB.row_factory = sqlite3.Row
    _DB.execute("PRAGMA journal_mode=WAL")
    _DB.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, name TEXT DEFAULT '',
        created REAL NOT NULL, plan TEXT NOT NULL DEFAULT 'trial', plan_until REAL,
        is_admin INTEGER NOT NULL DEFAULT 0, brand TEXT DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at REAL NOT NULL, clips INTEGER NOT NULL, job_id TEXT);
    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, cpm_eur REAL DEFAULT 0,
        url TEXT DEFAULT '', platform TEXT DEFAULT '', created REAL NOT NULL, archived INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, campaign_id INTEGER, title TEXT DEFAULT '',
        created REAL NOT NULL, hook_style TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS clip_stats (
        job_id TEXT NOT NULL, clip_id TEXT NOT NULL, user_id INTEGER NOT NULL,
        posted INTEGER DEFAULT 0, platform TEXT DEFAULT '', post_url TEXT DEFAULT '', posted_at REAL,
        views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0,
        payout_eur REAL, updated REAL, PRIMARY KEY (job_id, clip_id));
    CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, status TEXT, created REAL);
    """)


def _q(sql: str, args=()) -> list:
    with _LOCK:
        return [dict(r) for r in _DB.execute(sql, args).fetchall()]


def _x(sql: str, args=()) -> int:
    with _LOCK:
        cur = _DB.execute(sql, args)
        return cur.lastrowid


# ---------------------------------------------------------------- wachtwoorden
def _hash(pw: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return salt.hex() + "$" + h.hex()


def _check(pw: str, stored: str) -> bool:
    try:
        salt_hex, _ = stored.split("$", 1)
        return hmac.compare_digest(_hash(pw, bytes.fromhex(salt_hex)), stored)
    except Exception:
        return False


# ---------------------------------------------------------------- gebruikers
def public_user(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "name": u.get("name") or "", "is_admin": bool(u["is_admin"]),
            "plan": u["plan"], "plan_until": u.get("plan_until"), "created": u["created"]}


def register(email: str, pw: str, name: str = "") -> dict:
    email = email.strip().lower()
    if "@" not in email or len(email) > 200:
        raise ValueError("Vul een geldig e-mailadres in.")
    if len(pw) < 8:
        raise ValueError("Kies een wachtwoord van minstens 8 tekens.")
    if _q("SELECT id FROM users WHERE email=?", (email,)):
        raise ValueError("Er bestaat al een account met dit e-mailadres.")
    first = not _q("SELECT id FROM users LIMIT 1")
    now = time.time()
    # De eerste gebruiker is de eigenaar van de app.
    plan, until, admin = ("admin", None, 1) if first else ("trial", now + TRIAL_DAYS * 86400, 0)
    uid = _x("INSERT INTO users (email, pw, name, created, plan, plan_until, is_admin, brand) VALUES (?,?,?,?,?,?,?,?)",
             (email, _hash(pw), name.strip()[:80], now, plan, until, admin, json.dumps(DEFAULT_BRAND)))
    return get_user(uid)


def login(email: str, pw: str) -> Optional[str]:
    rows = _q("SELECT * FROM users WHERE email=?", (email.strip().lower(),))
    if not rows or not _check(pw, rows[0]["pw"]):
        return None
    token = secrets.token_urlsafe(32)
    _x("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)",
       (token, rows[0]["id"], time.time() + SESSION_DAYS * 86400))
    return token


def logout(token: str) -> None:
    _x("DELETE FROM sessions WHERE token=?", (token,))


def user_for_token(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    rows = _q("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
              (token, time.time()))
    return rows[0] if rows else None


def get_user(uid: int) -> Optional[dict]:
    rows = _q("SELECT * FROM users WHERE id=?", (uid,))
    return rows[0] if rows else None


def list_users() -> list:
    out = []
    for u in _q("SELECT * FROM users ORDER BY created DESC"):
        d = public_user(u)
        d["usage"] = quota(u)
        out.append(d)
    return out


def set_plan(uid: int, plan: str, days: int = 30) -> dict:
    if plan not in PLANS:
        raise ValueError("Onbekend abonnement.")
    until = None if plan == "admin" else time.time() + days * 86400
    _x("UPDATE users SET plan=?, plan_until=?, is_admin=? WHERE id=?",
       (plan, until, 1 if plan == "admin" else 0, uid))
    return public_user(get_user(uid))


# ---------------------------------------------------------------- proefperiode & limieten
def quota(user: dict) -> dict:
    """Hoeveel clips mag deze gebruiker nog maken in de huidige periode?"""
    plan = user["plan"]
    info = PLANS.get(plan, PLANS["trial"])
    now = time.time()
    until = user.get("plan_until")
    if plan == "admin":
        return {"plan": plan, "plan_name": info["name"], "limit": 0, "used": 0, "remaining": None,
                "active": True, "until": None, "days_left": None}
    active = bool(until and until > now)
    if plan == "trial":
        since = user["created"]
    else:
        # periode van 30 dagen die eindigt op plan_until
        since = (until or now) - 30 * 86400
    used = _q("SELECT COALESCE(SUM(clips),0) AS n FROM usage WHERE user_id=? AND at>=?", (user["id"], since))[0]["n"]
    remaining = max(0, info["clips"] - used) if active else 0
    return {"plan": plan, "plan_name": info["name"], "limit": info["clips"], "used": int(used),
            "remaining": remaining, "active": active, "until": until,
            "days_left": max(0, int(-((now - until) // 86400))) if until else None}


def record_usage(uid: int, clips: int, job_id: str) -> None:
    if clips > 0:
        _x("INSERT INTO usage (user_id, at, clips, job_id) VALUES (?,?,?,?)", (uid, time.time(), clips, job_id))


# ---------------------------------------------------------------- merk
def get_brand(uid: int) -> dict:
    u = get_user(uid)
    try:
        b = json.loads(u.get("brand") or "{}")
    except Exception:
        b = {}
    return {**DEFAULT_BRAND, **{k: v for k, v in b.items() if k in DEFAULT_BRAND}}


def save_brand(uid: int, data: dict) -> dict:
    b = get_brand(uid)
    for k in DEFAULT_BRAND:
        if k in data and data[k] is not None:
            b[k] = str(data[k])[:80]
    _x("UPDATE users SET brand=? WHERE id=?", (json.dumps(b), uid))
    return b


# ---------------------------------------------------------------- campagnes (eigen administratie)
def list_campaigns(uid: int) -> list:
    return _q("SELECT * FROM campaigns WHERE user_id=? AND archived=0 ORDER BY created DESC", (uid,))


def save_campaign(uid: int, data: dict, cid: Optional[int] = None) -> dict:
    name = str(data.get("name", "")).strip()[:120]
    if not name:
        raise ValueError("Geef de campagne een naam.")
    try:
        cpm = max(0.0, float(str(data.get("cpm_eur") or 0).replace(",", ".")))
    except ValueError:
        cpm = 0.0
    url = str(data.get("url") or "")[:500]
    platform = str(data.get("platform") or "")[:40]
    if cid:
        if not _q("SELECT id FROM campaigns WHERE id=? AND user_id=?", (cid, uid)):
            raise KeyError("Campagne niet gevonden.")
        _x("UPDATE campaigns SET name=?, cpm_eur=?, url=?, platform=? WHERE id=?", (name, cpm, url, platform, cid))
    else:
        cid = _x("INSERT INTO campaigns (user_id, name, cpm_eur, url, platform, created) VALUES (?,?,?,?,?,?)",
                 (uid, name, cpm, url, platform, time.time()))
    return _q("SELECT * FROM campaigns WHERE id=?", (cid,))[0]


def archive_campaign(uid: int, cid: int) -> None:
    _x("UPDATE campaigns SET archived=1 WHERE id=? AND user_id=?", (cid, uid))


def campaign_of(uid: int, cid) -> Optional[dict]:
    if not cid:
        return None
    rows = _q("SELECT * FROM campaigns WHERE id=? AND user_id=?", (int(cid), uid))
    return rows[0] if rows else None


# ---------------------------------------------------------------- runs
def add_job(job_id: str, uid: int, campaign_id, title: str, hook_style: str) -> None:
    _x("INSERT OR REPLACE INTO jobs (job_id, user_id, campaign_id, title, created, hook_style) VALUES (?,?,?,?,?,?)",
       (job_id, uid, campaign_id, title[:200], time.time(), hook_style))


def job_owner(job_id: str) -> Optional[int]:
    rows = _q("SELECT user_id FROM jobs WHERE job_id=?", (job_id,))
    return rows[0]["user_id"] if rows else None


def user_jobs(uid: int) -> list:
    return _q("SELECT * FROM jobs WHERE user_id=? ORDER BY created DESC", (uid,))


def set_job_campaign(uid: int, job_id: str, campaign_id) -> None:
    _x("UPDATE jobs SET campaign_id=? WHERE job_id=? AND user_id=?", (campaign_id or None, job_id, uid))


def delete_job(job_id: str) -> None:
    _x("DELETE FROM jobs WHERE job_id=?", (job_id,))
    _x("DELETE FROM clip_stats WHERE job_id=?", (job_id,))


# ---------------------------------------------------------------- clipstatistieken
STAT_FIELDS = ("posted", "platform", "post_url", "posted_at", "views", "likes", "comments", "shares", "payout_eur")


def save_stats(uid: int, job_id: str, clip_id: str, data: dict) -> dict:
    cur = _q("SELECT * FROM clip_stats WHERE job_id=? AND clip_id=?", (job_id, clip_id))
    row = cur[0] if cur else {"posted": 0, "platform": "", "post_url": "", "posted_at": None, "views": 0,
                              "likes": 0, "comments": 0, "shares": 0, "payout_eur": None}

    def num(v, kind=int):
        """'12.500', '12,5k', '1.2M', 3400 -> getal."""
        if v in (None, ""):
            return None
        t = str(v).strip().lower().replace(" ", "").replace("€", "")
        mult = 1
        if t.endswith("k"):
            mult, t = 1000, t[:-1]
        elif t.endswith("m"):
            mult, t = 1_000_000, t[:-1]
        if kind is int and mult == 1:
            t = t.replace(".", "").replace(",", "")
        else:
            t = t.replace(",", ".")
        try:
            return kind(float(t) * mult)
        except ValueError:
            return None

    for k in STAT_FIELDS:
        if k not in data:
            continue
        v = data[k]
        if k in ("views", "likes", "comments", "shares"):
            row[k] = max(0, num(v) or 0)
        elif k == "payout_eur":
            row[k] = num(v, float)
        elif k == "posted":
            row[k] = 1 if str(v).lower() in ("1", "true", "yes", "on") else 0
        elif k == "posted_at":
            row[k] = num(v, float)
        else:
            row[k] = str(v or "")[:500]
    if row["posted"] and not row.get("posted_at"):
        row["posted_at"] = time.time()
    _x("""INSERT OR REPLACE INTO clip_stats (job_id, clip_id, user_id, posted, platform, post_url, posted_at,
          views, likes, comments, shares, payout_eur, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
       (job_id, clip_id, uid, row["posted"], row["platform"], row["post_url"], row["posted_at"], row["views"],
        row["likes"], row["comments"], row["shares"], row["payout_eur"], time.time()))
    return _q("SELECT * FROM clip_stats WHERE job_id=? AND clip_id=?", (job_id, clip_id))[0]


def stats_for_user(uid: int) -> dict:
    return {(r["job_id"], r["clip_id"]): r for r in _q("SELECT * FROM clip_stats WHERE user_id=?", (uid,))}


# ---------------------------------------------------------------- betalen (Mollie, optioneel)
MOLLIE_KEY = os.environ.get("MOLLIE_API_KEY", "").strip()


def mollie_enabled() -> bool:
    return bool(MOLLIE_KEY)


def _mollie(method: str, path: str, body: Optional[dict] = None) -> dict:
    import urllib.request
    req = urllib.request.Request(
        "https://api.mollie.com/v2" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {MOLLIE_KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def start_payment(user: dict, plan: str, base_url: str) -> str:
    """Maakt een betaling voor 30 dagen van een abonnement en geeft de betaallink terug."""
    if plan not in ("starter", "pro", "studio"):
        raise ValueError("Kies Starter, Pro of Studio.")
    info = PLANS[plan]
    p = _mollie("POST", "/payments", {
        "amount": {"currency": "EUR", "value": f"{info['price_eur']:.2f}"},
        "description": f"ClipNova {info['name']} (30 dagen)",
        "redirectUrl": base_url.rstrip("/") + "/?betaald=1",
        "webhookUrl": base_url.rstrip("/") + "/api/billing/webhook",
        "metadata": {"user_id": user["id"], "plan": plan},
    })
    _x("INSERT OR REPLACE INTO payments (id, user_id, plan, status, created) VALUES (?,?,?,?,?)",
       (p["id"], user["id"], plan, p.get("status"), time.time()))
    return p["_links"]["checkout"]["href"]


def payment_webhook(payment_id: str) -> None:
    """Mollie meldt een statuswijziging; bij 'paid' gaat het abonnement 30 dagen in (of wordt verlengd)."""
    rows = _q("SELECT * FROM payments WHERE id=?", (payment_id,))
    if not rows:
        return
    p = _mollie("GET", f"/payments/{payment_id}")
    status = p.get("status")
    if status == "paid" and rows[0]["status"] != "paid":
        u = get_user(rows[0]["user_id"])
        start = max(time.time(), u.get("plan_until") or 0) if u["plan"] == rows[0]["plan"] else time.time()
        _x("UPDATE users SET plan=?, plan_until=? WHERE id=?", (rows[0]["plan"], start + 30 * 86400, u["id"]))
    _x("UPDATE payments SET status=? WHERE id=?", (status, payment_id))
