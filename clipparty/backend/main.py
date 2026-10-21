import asyncio
import json
import os
import re
import time
import traceback
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request, Response, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import clipper
import campaign_rules
import people
import campaign_search
import accounts
import analytics

APP_VERSION = "v126"

BASE_DIR = Path(__file__).parent

STORAGE = BASE_DIR / "storage"
STORAGE.mkdir(exist_ok=True)

accounts.init(STORAGE)

app = FastAPI(title="ClipNova")
# Geen CORS-middleware: de app en de API draaien op hetzelfde adres, en met
# inlog-cookies mag een andere site de API niet kunnen aanroepen.

SESSION_COOKIE = "cn_session"


def current_user(request: Request) -> dict:
    token = request.cookies.get(SESSION_COOKIE) or request.headers.get("X-Session")
    user = accounts.user_for_token(token)
    if not user:
        raise HTTPException(401, "Log eerst in.")
    return user


def admin_user(user: dict = Depends(current_user)) -> dict:
    if not user["is_admin"]:
        raise HTTPException(403, "Alleen voor de beheerder.")
    return user


def user_root(user: dict) -> Path:
    d = STORAGE / "users" / str(user["id"])
    d.mkdir(parents=True, exist_ok=True)
    return d


def own_job(job_id: str, user: dict) -> None:
    """Een run is alleen te zien voor wie hem maakte (en de beheerder)."""
    owner = accounts.job_owner(job_id)
    if owner is None or (owner != user["id"] and not user["is_admin"]):
        raise HTTPException(404, "Run niet gevonden")


def _safe_name(name: Optional[str], fallback: str) -> str:
    base = Path(str(name or "")).name
    base = re.sub(r"[^A-Za-z0-9._ -]", "_", base).strip(" .")[:120]
    return base or fallback

JOBS: dict[str, dict] = {}


def _sanitize(obj):
    """Recursively converts any numpy scalar (numpy.bool_, numpy.float32,
    numpy.int64, etc. — these can sneak in via OpenCV/Whisper/etc. even
    after casting the obvious spots) into a native Python type, since
    FastAPI's JSON encoder doesn't know how to serialize them. Applied to
    every API response as a blanket safety net."""
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, tuple):
        return [_sanitize(v) for v in obj]
    if hasattr(obj, "item") and callable(getattr(obj, "item")):
        try:
            return obj.item()
        except Exception:
            return obj
    return obj


def read_briefing(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext == ".txt":
        return Path(path).read_text(errors="ignore")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(path)
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception:
            return ""
    if ext == ".docx":
        try:
            import docx
            d = docx.Document(path)
            return "\n".join(p.text for p in d.paragraphs)
        except Exception:
            return ""
    return ""


# Rough share of total wall-clock each phase takes on a CPU-only machine.
# Transcription dominates by a wide margin, so weighting the phases (rather
# than treating them as equal quarters) keeps the percentage from stalling
# at a number that doesn't move for half an hour.
PHASE_WEIGHTS = {"transcribe": 0.66, "people": 0.04, "select": 0.04, "cut": 0.20}
CAPTION_SHARE = 0.06


def _phase_progress(phase: str, fraction: float) -> float:
    """Fraction of a single video's work completed, 0..1."""
    done = 0.0
    for name, weight in PHASE_WEIGHTS.items():
        if name == phase:
            return done + weight * max(0.0, min(1.0, fraction))
        done += weight
    return done


def set_progress(job_id: str, text: str, pct: Optional[float] = None) -> None:
    """Stores the human-readable step plus an overall percentage and a time
    estimate derived from how long the run has taken so far."""
    job = JOBS.get(job_id)
    if not job:
        return
    job["progress"] = text
    if pct is None:
        return
    pct = max(0.0, min(100.0, pct))
    job["pct"] = round(pct, 1)
    elapsed = time.time() - job.get("started_at", time.time())
    # Only estimate once there's enough signal for the number to mean
    # something — an ETA from the first few percent swings wildly.
    if pct >= 3 and elapsed > 20:
        job["eta_seconds"] = int(elapsed / pct * (100 - pct))
    else:
        job["eta_seconds"] = None


def _job_state_path(job_id: str) -> Path:
    return STORAGE / job_id / "job.json"


def save_job_state(job_id: str) -> None:
    """Writes the job's user-visible state to disk next to its clips.

    Without this, a job lives only in memory: if the container restarts
    (a crash, a machine reboot, a `--restart` policy kicking in) an
    overnight run's finished clips would still be on disk but the app
    would report "job niet gevonden" and you'd have no way to reach them.
    """
    job = JOBS.get(job_id)
    if not job:
        return
    try:
        state = {
            "status": job.get("status"),
            "progress": job.get("progress", ""),
            "pct": job.get("pct"),
            "eta_seconds": job.get("eta_seconds"),
            "error": job.get("error"),
            "clips": job.get("clips", []),
            "rules": job.get("rules"),
            "notes": job.get("notes", []),
        }
        path = _job_state_path(job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(_sanitize(state)))
    except Exception:
        # Persistence is best-effort; never let it break an active run.
        pass


def load_job_state(job_id: str) -> Optional[dict]:
    try:
        path = _job_state_path(job_id)
        if path.exists():
            return json.loads(path.read_text())
    except Exception:
        pass
    return None


def _download_quality(settings) -> str:
    if isinstance(settings, dict):
        return str(settings.get("download_quality") or "1080")
    return str(getattr(settings, "download_quality", "1080") or "1080")


def _cleanup_sources(job_dir: Path, videos: list) -> None:
    """Bronvideo's en tussenbestanden weg na een geslaagde run: de clips blijven.
    Zet CLIPNOVA_KEEP_SOURCES=1 om ze te bewaren."""
    if os.environ.get("CLIPNOVA_KEEP_SOURCES") == "1":
        return
    for f in list(job_dir.iterdir()):
        try:
            if str(f) in videos or f.suffix.lower() in (".wav", ".ogg", ".ass", ".srt") or f.name == "groq_audio":
                shutil.rmtree(f, ignore_errors=True) if f.is_dir() else f.unlink(missing_ok=True)
        except OSError:
            pass


def run_job(job_id: str):
    job = JOBS[job_id]
    job_dir = STORAGE / job_id
    try:
        job["status"] = "processing"
        settings = job["settings"]

        pending = job.pop("pending_download", None)
        if pending:
            wanted = pending.get("urls") or ([pending["url"]] if pending.get("url") else [])
            got, failed = [], []
            for n, src in enumerate(wanted, 1):
                label = "Bron downloaden" + (f" ({n}/{len(wanted)})" if len(wanted) > 1 else "")
                set_progress(job_id, label, 1.0)
                try:
                    def _dl(frac, speed, label=label):
                        txt = f"{label} — {frac*100:.0f}%" + (f" ({speed})" if speed and "Unknown" not in speed else "")
                        set_progress(job_id, txt, 1.0)
                    got.append(clipper.download_source(
                        src, str(job_dir), max_minutes=pending["max_minutes"],
                        max_height=_download_quality(settings), progress_cb=_dl))
                except Exception as e:
                    # One unreachable file in a folder should not sink the run.
                    failed.append(f"{src}: {e}")
                    print(f"[ClipNova] Bron overgeslagen — {src}: {e}", flush=True)
            if not got:
                raise RuntimeError("Geen van de bronnen kon worden gedownload. "
                                   + (failed[0] if failed else ""))
            job["videos"] = list(job.get("videos") or []) + got
            if failed:
                job.setdefault("notes", []).extend(
                    [f"Overgeslagen: {f[:160]}" for f in failed])

        provider = settings.llm_provider
        api_key = job.get("api_key")

        n_videos = max(1, len(job["videos"]))
        video_share = (1.0 - CAPTION_SHARE) / n_videos

        rules = None
        if settings.apply_campaign_rules and job["briefing_text"]:
            set_progress(job_id, "Campagneregels uitlezen", 1.0)
            rules = campaign_rules.extract_rules(job["briefing_text"], provider=provider, api_key=api_key)
            job["rules"] = rules

        PHASE_TEXT = {
            "transcribe": "Video uitluisteren",
            "people": "Gezichten herkennen",
            "select": "Beste momenten kiezen",
            "cut": "Clips knippen",
        }

        all_results = []
        for i, video_path in enumerate(job["videos"]):

            def _progress(phase, fraction, video_idx=i):
                within = _phase_progress(phase, fraction)
                overall = (video_idx + within) * video_share * 100
                label = PHASE_TEXT.get(phase, phase)
                if n_videos > 1:
                    label = f"{label} ({video_idx + 1}/{n_videos})"
                set_progress(job_id, label, overall)

            results = clipper.process_video(
                video_path=video_path,
                briefing=job["briefing_text"],
                settings=settings,
                job_dir=str(job_dir),
                api_key=api_key,
                rules=rules,
                progress_cb=_progress,
            )
            all_results.extend(results)

        set_progress(job_id, "Bijschriften schrijven", (1.0 - CAPTION_SHARE) * 100)

        def _caption_for(r):
            compliance = {"checks": {}, "passed": True}
            # Dezelfde taal als de video (clipper.process_video heeft die vastgesteld),
            # tenzij de gebruiker zelf een schrijftaal koos.
            out_lang = (str(settings.output_language or "").strip().lower()
                        or str(getattr(r, "language", "") or "").strip().lower()[:2] or "nl")
            # Altijd via de AI, ook zonder briefing: anders werd het bijschrift
            # gewoon de hook en kwamen er geen hashtags bij.
            caption_data = campaign_rules.generate_caption(
                r.hook, r.reason, rules or {}, provider=provider, api_key=api_key,
                output_language=out_lang, transcript=getattr(r, "text", ""),
                people=getattr(r, "people", None))
            if rules is not None:
                compliance = campaign_rules.check_compliance(
                    clip_duration=float(r.end - r.start),
                    caption=caption_data.get("caption", ""),
                    onscreen_text=caption_data.get("onscreen_text", r.hook),
                    rules=rules,
                    face_detected=r.face_detected,
                    detected_language=r.language,
                    title=caption_data.get("title", ""),
                )
            payload = _clip_payload(r, caption_data, compliance)

            # Write the same clip in the other languages too. Running a Dutch
            # and an American account means each needs its own wording; doing
            # both here avoids a second full run over the same footage.
            extras = {}
            for lang in (getattr(settings, "extra_languages", None) or []):
                lang = str(lang).strip().lower()
                if not lang or lang == out_lang:
                    continue
                try:
                    other = campaign_rules.generate_caption(
                        r.hook, r.reason, rules or {}, provider=provider,
                        api_key=api_key, output_language=lang, transcript=getattr(r, "text", ""),
                        people=getattr(r, "people", None))
                    extras[lang] = {
                        "title": other.get("title", ""),
                        "caption": other.get("caption", ""),
                        "hashtags": other.get("hashtags", []),
                    }
                except Exception as e:
                    print(f"[ClipNova] Bijschrift in {lang} mislukt: "
                          f"{type(e).__name__}: {e}", flush=True)
            if extras:
                payload["translations"] = extras
            return payload

        def _safe_caption(r):
            try:
                return _caption_for(r)
            except Exception as e:
                # A clip that already exists on disk should still reach the
                # user even if writing its caption failed.
                print(f"[ClipNova] Bijschrift voor clip {r.id} mislukt: "
                      f"{type(e).__name__}: {e}", flush=True)
                return _clip_payload(r, {"title": r.hook, "description": r.reason,
                                         "caption": r.hook, "hashtags": [],
                                         "onscreen_text": r.hook},
                                     {"checks": {}, "passed": True})

        def _clip_payload(r, caption_data, compliance):
            return {
                "id": r.id, "start": r.start, "end": r.end, "hook": r.hook,
                "reason": r.reason, "score": r.score,
                "title": caption_data.get("title", ""),
                "description": caption_data.get("description", ""),
                "caption": caption_data.get("caption", ""),
                "hashtags": caption_data.get("hashtags", []),
                "compliance": compliance,
                "url": f"/api/clips/{job_id}/{r.id}",
                "text": getattr(r, "text", ""),
                "caption_ai": bool(caption_data.get("ai", True)),
                "language": getattr(r, "language", None),
                "people": getattr(r, "people", []) or [],
            }

        # One LLM call per clip. Twenty at once is fast but blows straight
        # through a free tier's per-minute token budget, so every call comes
        # back rate-limited and the captions fall back to raw hook text.
        # A small pool stays inside the budget and still overlaps the waiting.
        clips_out = [None] * len(all_results)
        with ThreadPoolExecutor(max_workers=min(2, max(1, len(all_results)))) as pool:
            futures = {pool.submit(_safe_caption, r): idx for idx, r in enumerate(all_results)}
            done = 0
            for fut in as_completed(futures):
                idx = futures[fut]
                clips_out[idx] = fut.result()
                done += 1
                set_progress(job_id, "Bijschriften schrijven",
                             (1.0 - CAPTION_SHARE + CAPTION_SHARE * done / max(1, len(all_results))) * 100)

        job["clips"] = clips_out
        if job.get("owner"):
            accounts.record_usage(job["owner"], len([c for c in clips_out if c]), job_id)
        # Stamp the running version into the report. Half the rounds of
        # debugging have been spent working out whether a fix was even
        # installed; this answers it from the same screen as the result.
        job["notes"] = [f"ClipNova {APP_VERSION}"] + list(
            getattr(clipper.process_video, "last_notes", []))
        no_ai = sum(1 for c in clips_out if c and not c.get("caption_ai", True))
        if no_ai:
            job["notes"].append(
                f"{no_ai} bijschrift(en) zonder AI gemaakt (AI niet bereikbaar of limiet op). "
                "Klik bij die clip op 'Bijschrift opnieuw schrijven'.")
        job["status"] = "done"
        job["pct"] = 100.0
        job["eta_seconds"] = 0
        job["progress"] = f"{len(all_results)} clips klaar"
        save_job_state(job_id)
        _cleanup_sources(job_dir, job.get("videos") or [])
    except Exception as e:
        # Print the full traceback too. Storing it on the job alone meant a
        # failed run showed up as a bare "Mislukt" with nothing in the
        # container logs to work from.
        print(f"[ClipNova] Run {job_id} MISLUKT: {type(e).__name__}: {e}", flush=True)
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
        save_job_state(job_id)


def _save_upload(upload, path: Path) -> None:
    """Upload in stukken naar schijf, zonder de hele video in het geheugen."""
    upload.file.seek(0)
    with open(path, "wb") as out:
        shutil.copyfileobj(upload.file, out, 1024 * 1024)


# ---- Gezichtenbibliotheek: referentiefoto's per persoon -------------------
@app.get("/api/faces")
def faces_list(user: dict = Depends(current_user)):
    return {"people": people.list_library(user_root(user)), "engine_ready": people.available()}


@app.post("/api/faces")
async def faces_add(name: str = Form(...), photos: list[UploadFile] = File(default=[]),
                    user: dict = Depends(current_user)):
    if not name.strip():
        raise HTTPException(400, "Geef een naam op.")
    if not photos:
        raise HTTPException(400, "Voeg minstens een foto toe.")
    for ph in photos:
        data = await ph.read()
        if len(data) > 15 * 1024 * 1024:
            raise HTTPException(400, f"{ph.filename} is te groot (max 15 MB).")
        await asyncio.to_thread(people.add_photo, user_root(user), name, _safe_name(ph.filename, "foto.jpg"), data)
    return faces_list(user)


@app.delete("/api/faces/{slug}")
def faces_delete(slug: str, user: dict = Depends(current_user)):
    if not people.delete_person(user_root(user), slug):
        raise HTTPException(404, "Onbekende persoon.")
    return faces_list(user)


_SETTING_FIELDS = {f.name for f in __import__("dataclasses").fields(clipper.Settings)}
# Deze velden vult de server in, niet de browser.
_SERVER_FIELDS = {"hook_style", "hook_position", "brand_color", "brand_text_color", "subtitle_color",
                  "font_path", "logo_path", "watermark", "faces_root"}


def _settings_for(user: dict, raw: dict) -> "clipper.Settings":
    clean = {k: v for k, v in (raw or {}).items() if k in _SETTING_FIELDS and k not in _SERVER_FIELDS}
    brand = accounts.get_brand(user["id"])
    style = str((raw or {}).get("hook_style") or brand["hook_style"])
    clean.update({
        "hook_style": style if style in clipper.HOOK_STYLES else "tiktok",
        "hook_position": brand["hook_position"], "brand_color": brand["brand_color"],
        "brand_text_color": brand["brand_text_color"], "subtitle_color": brand["subtitle_color"],
        "watermark": brand["watermark"], "faces_root": str(user_root(user)),
        "logo_path": str(user_root(user) / "logo.png") if brand.get("logo") and (user_root(user) / "logo.png").exists() else "",
    })
    return clipper.Settings(**clean)


@app.post("/api/campaign")
async def create_campaign(
    briefing: Optional[UploadFile] = File(None),
    videos: list[UploadFile] = File(default=[]),
    youtube_url: Optional[str] = Form(None),
    settings_json: str = Form(...),
    api_key: Optional[str] = Form(None),
    campaign_id: Optional[str] = Form(None),
    user: dict = Depends(current_user),
):
    quota = accounts.quota(user)
    if not quota["active"]:
        raise HTTPException(402, "Je proefperiode of abonnement is verlopen. Kies een abonnement om verder te clippen.")
    if quota["remaining"] is not None and quota["remaining"] <= 0:
        raise HTTPException(402, f"Je hebt je {quota['limit']} clips voor deze periode gebruikt. "
                                 "Kies een groter abonnement of wacht tot de volgende periode.")
    try:
        settings_dict = json.loads(settings_json)
        settings = _settings_for(user, settings_dict)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"Ongeldige instellingen: {e}")
    if quota["remaining"] is not None:
        settings.max_clips = max(1, min(settings.max_clips or quota["remaining"], quota["remaining"]))
    campaign = accounts.campaign_of(user["id"], campaign_id) if campaign_id else None

    job_id = uuid.uuid4().hex[:12]
    job_dir = STORAGE / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    briefing_text = ""
    if briefing is not None and briefing.filename:
        b_path = job_dir / _safe_name(briefing.filename, "briefing.txt")
        data = await briefing.read()
        await asyncio.to_thread(b_path.write_bytes, data)
        briefing_text = await asyncio.to_thread(read_briefing, str(b_path))

    video_paths = []
    for n, v in enumerate(videos):
        v_path = job_dir / f"{n}_{_safe_name(v.filename, 'video.mp4')}"
        await asyncio.to_thread(_save_upload, v, v_path)
        video_paths.append(str(v_path))

    if not video_paths and not (youtube_url or "").strip():
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(400, "Geen bronvideo's opgegeven (upload of YouTube-URL).")

    title = (campaign["name"] if campaign else "") or (Path(video_paths[0]).name if video_paths else youtube_url or "")
    JOBS[job_id] = {
        "status": "queued",
        "progress": "In de wachtrij",
        "pct": 0.0,
        "eta_seconds": None,
        "started_at": time.time(),
        "videos": video_paths,
        "briefing_text": briefing_text,
        "settings": settings,
        # Klanten gebruiken de sleutels van de server; alleen de beheerder kan er een meegeven.
        "api_key": (api_key or None) if user["is_admin"] else None,
        "clips": [],
        "owner": user["id"],
    }
    if (youtube_url or "").strip():
        # Downloaden gebeurt in de run zelf, zodat dit verzoek meteen terugkomt.
        JOBS[job_id]["pending_download"] = {"urls": [youtube_url.strip()], "max_minutes": None}
    accounts.add_job(job_id, user["id"], campaign["id"] if campaign else None, title, settings.hook_style)
    save_job_state(job_id)

    thread = threading.Thread(target=run_job, args=(job_id,), daemon=True)
    thread.start()

    return {"job_id": job_id}


@app.get("/api/campaign/{job_id}")
def get_campaign(job_id: str, user: dict = Depends(current_user)):
    own_job(job_id, user)
    job = JOBS.get(job_id)
    if not job:
        # The job isn't in memory — most likely the container restarted
        # (crash, reboot, restart policy) partway through or after an
        # overnight run. Its clips and saved state are still on disk, so
        # serve those instead of pretending the job never existed.
        saved = load_job_state(job_id)
        if saved:
            return _sanitize(_with_extras(job_id, user, saved))
        raise HTTPException(404, "Job niet gevonden")
    return _sanitize(_with_extras(job_id, user, {
        "status": job["status"],
        "progress": job.get("progress", ""),
        "pct": job.get("pct"),
        "eta_seconds": job.get("eta_seconds"),
        "error": job.get("error"),
        "clips": job.get("clips", []),
        "rules": job.get("rules"),
        # Why a run produced no clips. This was being collected and then
        # dropped here, so the page could only ever say "none found".
        "notes": job.get("notes", []),
    }))


def _with_extras(job_id: str, user: dict, data: dict) -> dict:
    """Voegt per clip de ingevulde cijfers en de gekoppelde campagne toe."""
    stats = accounts.stats_for_user(user["id"])
    data["stats"] = {cid: row for (jid, cid), row in stats.items() if jid == job_id}
    row = next((j for j in accounts.user_jobs(user["id"]) if j["job_id"] == job_id), None)
    data["campaign_id"] = row.get("campaign_id") if row else None
    return data


@app.get("/api/clips/{job_id}/{clip_id}")
def get_clip(job_id: str, clip_id: str, user: dict = Depends(current_user)):
    own_job(job_id, user)
    if not re.fullmatch(r"[0-9a-f]{8}", clip_id or ""):
        raise HTTPException(404, "Clip niet gevonden")
    path = STORAGE / job_id / f"clip_{clip_id}.mp4"
    if not path.exists():
        raise HTTPException(404, "Clip niet gevonden")
    return FileResponse(str(path), media_type="video/mp4")


@app.get("/api/campaigns")
def list_campaigns(user: dict = Depends(current_user)):
    """Alle runs van deze gebruiker, nieuwste eerst."""
    camps = {c["id"]: c["name"] for c in accounts.list_campaigns(user["id"])}
    items = []
    for row in accounts.user_jobs(user["id"]):
        job_id = row["job_id"]
        job_dir = STORAGE / job_id
        if not job_dir.is_dir():
            continue
        job = JOBS.get(job_id)
        state = ({"status": job.get("status"), "progress": job.get("progress", ""), "error": job.get("error"),
                  "clips": job.get("clips", [])} if job else load_job_state(job_id)) or {}
        items.append({
            "job_id": job_id,
            "title": row.get("title") or "",
            "campaign_id": row.get("campaign_id"),
            "campaign": camps.get(row.get("campaign_id"), ""),
            "status": state.get("status"),
            "progress": state.get("progress", ""),
            "error": state.get("error"),
            "clip_count": len([c for c in state.get("clips") or [] if c]),
            "modified": row["created"],
            "bytes": _dir_bytes(job_dir),
        })
    return _sanitize({"campaigns": items, "total_bytes": sum(i["bytes"] for i in items)})


def _dir_bytes(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


_JOB_ID = __import__("re").compile(r"^[0-9a-f]{12}$")


@app.delete("/api/campaign/{job_id}")
def delete_campaign(job_id: str, user: dict = Depends(current_user)):
    """Removes one run from disk: source videos, clips and all.

    Only folders that are really runs (a 12-character job id with a saved
    state) can go, so a typo or a crafted id can never reach the session or
    settings files that live next to them.
    """
    if not _JOB_ID.match(job_id):
        raise HTTPException(400, "Ongeldige run.")
    own_job(job_id, user)
    job = JOBS.get(job_id)
    if job and job.get("status") in ("queued", "processing"):
        raise HTTPException(409, "Deze run is nog bezig. Wacht tot hij klaar is.")
    job_dir = STORAGE / job_id
    if not job_dir.is_dir() or (job is None and load_job_state(job_id) is None):
        raise HTTPException(404, "Run niet gevonden.")
    freed = _dir_bytes(job_dir)
    shutil.rmtree(job_dir, ignore_errors=True)
    JOBS.pop(job_id, None)
    accounts.delete_job(job_id)
    return {"deleted": job_id, "freed_bytes": freed, "gone": not job_dir.exists()}


@app.get("/api/network-info")
def network_info(user: dict = Depends(admin_user)):
    """Reports the LAN address this server can be reached at, so the UI can
    show a ready-to-type URL for opening the app on a phone on the same
    Wi-Fi network. Inside Docker the container's own IP isn't reachable
    from the phone, so we report the host's LAN IP as seen via the default
    route, falling back to a hint if that can't be determined."""
    import socket
    host_ip = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        host_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return {"container_ip": host_ip, "version": APP_VERSION}


@app.get("/api/llm-status")
def llm_status(provider: str = "groq", api_key: Optional[str] = None, user: dict = Depends(admin_user)):
    """Makes one real, tiny test call to the given LLM provider and reports
    whether it actually works — lets the UI show AI connectivity directly
    instead of having to dig through Docker terminal logs."""
    return clipper.test_llm_connection(provider=provider, api_key=api_key)


# ---------- TikTok-concepten ----------

def _job_clips(job_id: str):
    """Geeft (clips, bewaar-functie) terug, of de run nu in het geheugen
    zit of alleen nog op schijf staat na een herstart."""
    job = JOBS.get(job_id)
    if job is not None:
        return job.get("clips") or [], lambda: save_job_state(job_id)
    saved = load_job_state(job_id)
    if saved is None:
        raise HTTPException(404, "Job niet gevonden")

    def _write():
        _job_state_path(job_id).write_text(json.dumps(_sanitize(saved)))
    return saved.get("clips") or [], _write


def _clip_caption(clip: dict) -> str:
    text = (clip.get("caption") or clip.get("title") or "").strip()
    tags = [t if str(t).startswith("#") else "#" + str(t) for t in (clip.get("hashtags") or [])]
    missing = [t for t in tags if t.lower() not in text.lower()]
    return (text + (" " + " ".join(missing) if missing else "")).strip()


@app.post("/api/campaign/{job_id}/clip/{clip_id}/caption")
def rewrite_caption(job_id: str, clip_id: str, provider: str = Form(""), api_key: str = Form(""),
                    user: dict = Depends(current_user)):
    """Bijschrift van één clip opnieuw laten schrijven, bijvoorbeeld als de
    AI-limiet op was tijdens de run."""
    own_job(job_id, user)
    if not user["is_admin"]:
        api_key = ""
    job = JOBS.get(job_id)
    if not job:
        # Oude run (na een herstart): staat op schijf; terugzetten in het geheugen.
        saved = load_job_state(job_id)
        if not saved:
            raise HTTPException(404, "Run niet gevonden")
        job = JOBS[job_id] = {**saved, "settings": clipper.Settings(), "api_key": None}
    clip = next((c for c in job.get("clips") or [] if c and str(c.get("id")) == str(clip_id)), None)
    if not clip:
        raise HTTPException(404, "Clip niet gevonden")
    settings = job.get("settings")
    prov = provider or getattr(settings, "llm_provider", None) or "groq"
    key = api_key.strip() or job.get("api_key")
    lang = getattr(settings, "output_language", "") or clip.get("language") or "nl"
    data = campaign_rules.generate_caption(
        clip.get("hook", ""), clip.get("reason", ""), job.get("rules") or {}, provider=prov,
        api_key=key, output_language=lang, transcript=clip.get("text", ""))
    if not data.get("ai", True):
        raise HTTPException(503, "De AI was niet bereikbaar of de limiet is nog op. Probeer het over een minuut opnieuw.")
    for k in ("title", "description", "caption", "hashtags"):
        clip[k] = data.get(k, clip.get(k))
    clip["caption_ai"] = True
    if job.get("rules"):
        clip["compliance"] = campaign_rules.check_compliance(
            clip_duration=float(clip["end"] - clip["start"]), caption=clip.get("caption", ""),
            onscreen_text=data.get("onscreen_text", clip.get("hook", "")), rules=job["rules"],
            title=clip.get("title", ""))
    save_job_state(job_id)
    return clip


@app.get("/api/deepgram")
def deepgram_status(user: dict = Depends(admin_user)):
    key = clipper.deepgram_key()
    return {"configured": bool(key), "hint": ("…" + key[-4:]) if key else ""}


@app.post("/api/deepgram")
def deepgram_save(api_key: str = Form(""), user: dict = Depends(admin_user)):
    key = api_key.strip()
    if key and (len(key) < 20 or " " in key):
        raise HTTPException(400, "Dit lijkt geen Deepgram-sleutel. Kopieer hem opnieuw uit je Deepgram-account.")
    clipper.save_deepgram_key(key)
    return deepgram_status()


@app.get("/api/deepgram/test")
async def deepgram_test(user: dict = Depends(admin_user)):
    """Klein testverzoek: één seconde stilte. Kost een fractie van een cent."""
    import subprocess, tempfile
    key = clipper.deepgram_key()
    if not key:
        return {"ok": False, "message": "Nog geen Deepgram-sleutel bewaard."}
    with tempfile.TemporaryDirectory() as d:
        wav = str(Path(d) / "stil.wav")
        subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", wav],
                       capture_output=True)
        try:
            await asyncio.to_thread(clipper.transcribe_deepgram, wav, key, d, None, "nl")
            return {"ok": True, "message": "Deepgram werkt. Nieuwe runs worden hiermee uitgeschreven."}
        except Exception as e:
            msg = str(e)
            if "401" in msg or "403" in msg:
                msg = "Deepgram weigert deze sleutel. Maak in Deepgram een nieuwe aan en plak die hier."
            elif "402" in msg:
                msg = "Je Deepgram-tegoed is op. Vul het aan bij Billing in Deepgram."
            return {"ok": False, "message": msg[:300]}


# Mounting "/" swallows every path registered after it, so this stays last.
# New API routes belong ABOVE this line or they silently 404.
@app.post("/api/campaign-search")
def campaign_search_endpoint(
    niche: str = Form(""),
    provider: str = Form("groq"),
    api_key: Optional[str] = Form(None),
    apify_token: str = Form(""),
    user: dict = Depends(current_user),
):
    if not user["is_admin"]:
        api_key = None
    """Lijst met campagnes, op volgorde voor jouw niche. De app zoekt geen
    video's en leest geen regels: dat regelt de gebruiker zelf."""
    found, error = campaign_search.fetch_directory(apify_token)
    if error:
        return {"campaigns": [], "error": error, "ai": False}
    ranked, ai = campaign_search.rank(found, niche.strip(), provider=provider, api_key=api_key)
    return _sanitize({"campaigns": ranked, "error": None, "ai": ai, "total": len(found)})


# ======================================================================
# Accounts, proefperiode en abonnementen
# ======================================================================
def _set_session(response: Response, token: str, request: Request) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=accounts.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https", path="/")


def _me(user: dict) -> dict:
    return {**accounts.public_user(user), "quota": accounts.quota(user),
            "brand": accounts.get_brand(user["id"]), "version": APP_VERSION}


@app.get("/api/health")
def health():
    return {"ok": True, "version": APP_VERSION}


@app.post("/api/auth/register")
def auth_register(request: Request, response: Response, email: str = Form(...), password: str = Form(...),
                  name: str = Form("")):
    try:
        accounts.register(email, password, name)
    except ValueError as e:
        raise HTTPException(400, str(e))
    token = accounts.login(email, password)
    _set_session(response, token, request)
    return _me(accounts.user_for_token(token))


@app.post("/api/auth/login")
def auth_login(request: Request, response: Response, email: str = Form(...), password: str = Form(...)):
    token = accounts.login(email, password)
    if not token:
        time.sleep(0.5)          # remt wachtwoorden raden
        raise HTTPException(401, "E-mailadres of wachtwoord klopt niet.")
    _set_session(response, token, request)
    return _me(accounts.user_for_token(token))


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        accounts.logout(token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return _me(user)


@app.get("/api/plans")
def plans():
    return {"plans": [{"id": k, **v} for k, v in accounts.PLANS.items() if k not in ("admin",)],
            "trial_days": accounts.TRIAL_DAYS, "payments": accounts.mollie_enabled()}


@app.post("/api/billing/checkout")
def billing_checkout(request: Request, plan: str = Form(...), user: dict = Depends(current_user)):
    if not accounts.mollie_enabled():
        raise HTTPException(503, "Online betalen staat nog niet aan. Neem contact op, dan zet de beheerder je abonnement aan.")
    base = os.environ.get("CLIPNOVA_PUBLIC_URL") or str(request.base_url)
    try:
        return {"checkout_url": accounts.start_payment(user, plan, base)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Betaling starten mislukt: {e}")


@app.post("/api/billing/webhook")
def billing_webhook(id: str = Form(...)):
    try:
        accounts.payment_webhook(id)
    except Exception as e:
        print(f"[ClipNova] Mollie-webhook mislukt: {e}", flush=True)
    return {"ok": True}


@app.get("/api/admin/users")
def admin_users(user: dict = Depends(admin_user)):
    return {"users": accounts.list_users(), "plans": list(accounts.PLANS)}


@app.post("/api/admin/users/{uid}/plan")
def admin_set_plan(uid: int, plan: str = Form(...), days: int = Form(30), user: dict = Depends(admin_user)):
    try:
        return accounts.set_plan(uid, plan, days)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ======================================================================
# Eigen merk en hookstijlen
# ======================================================================
@app.get("/api/brand")
def brand_get(user: dict = Depends(current_user)):
    return {"brand": accounts.get_brand(user["id"]),
            "styles": [{"id": k, "label": v["label"]} for k, v in clipper.HOOK_STYLES.items()]}


@app.post("/api/brand")
def brand_save(hook_style: str = Form(None), hook_position: str = Form(None), brand_color: str = Form(None),
               brand_text_color: str = Form(None), subtitle_color: str = Form(None), watermark: str = Form(None),
               brand_name: str = Form(None), user: dict = Depends(current_user)):
    data = dict(hook_style=hook_style, hook_position=hook_position, brand_color=brand_color,
                brand_text_color=brand_text_color, subtitle_color=subtitle_color, watermark=watermark,
                brand_name=brand_name)
    if hook_style is not None and hook_style not in clipper.HOOK_STYLES:
        raise HTTPException(400, "Onbekende hookstijl.")
    if hook_position is not None and hook_position not in ("boven", "midden"):
        raise HTTPException(400, "Kies boven of midden.")
    for k in ("brand_color", "brand_text_color", "subtitle_color"):
        if data[k] is not None and not re.fullmatch(r"#[0-9A-Fa-f]{6}", data[k]):
            raise HTTPException(400, "Kleuren als #RRGGBB.")
    return accounts.save_brand(user["id"], data)


@app.post("/api/brand/logo")
async def brand_logo(logo: UploadFile = File(...), user: dict = Depends(current_user)):
    data = await logo.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "Logo is te groot (max 5 MB).")
    try:
        from PIL import Image
        import io
        im = Image.open(io.BytesIO(data)).convert("RGBA")
        im.thumbnail((800, 800))
        im.save(user_root(user) / "logo.png", "PNG")
    except Exception:
        raise HTTPException(400, "Dit is geen bruikbare afbeelding. Gebruik PNG (liefst met doorzichtige achtergrond).")
    return accounts.save_brand(user["id"], {"logo": "1"})


@app.delete("/api/brand/logo")
def brand_logo_delete(user: dict = Depends(current_user)):
    (user_root(user) / "logo.png").unlink(missing_ok=True)
    return accounts.save_brand(user["id"], {"logo": ""})


@app.get("/api/brand/logo")
def brand_logo_get(user: dict = Depends(current_user)):
    path = user_root(user) / "logo.png"
    if not path.exists():
        raise HTTPException(404, "Geen logo.")
    return FileResponse(str(path), media_type="image/png")


@app.get("/api/brand/preview")
def brand_preview(text: str = "Dit had niemand verwacht 😱", style: str = "", position: str = "",
                  layout: str = "blur", user: dict = Depends(current_user)):
    """Voorbeeldbeeld (540 x 960) van hoe de hooktekst, het logo en de ondertitel eruitzien."""
    from PIL import Image, ImageDraw, ImageFilter
    import io, tempfile
    b = accounts.get_brand(user["id"])
    w, h = 540, 960
    # Nepvideo: kleurvlakken, in het midden (zoals 'volledig beeld') op een vervaagde kopie.
    src = Image.new("RGB", (640, 360), (40, 32, 90))
    d = ImageDraw.Draw(src)
    for i, col in enumerate([(124, 92, 255), (255, 79, 216), (45, 226, 230), (255, 200, 60)]):
        d.ellipse((60 + i * 140, 110 + (i % 2) * 40, 180 + i * 140, 230 + (i % 2) * 40), fill=col)
    bg = src.resize((w, h)).filter(ImageFilter.GaussianBlur(24))
    if layout == "blur":
        fg = src.resize((w, int(w * 360 / 640)))
        bg.paste(fg, (0, (h - fg.height) // 2))
    else:
        bg = src.resize((int(h * 640 / 360), h)).crop((int((h * 640 / 360 - w) / 2), 0, int((h * 640 / 360 + w) / 2), h))
    frame = bg.convert("RGBA")
    with tempfile.TemporaryDirectory() as tmp:
        hook = clipper._render_hook_png(text[:100], w, h, f"{tmp}/h.png", style=style or b["hook_style"],
                                        position=position or b["hook_position"], brand_color=b["brand_color"],
                                        brand_text_color=b["brand_text_color"])
        if hook:
            frame.alpha_composite(Image.open(hook))
        logo = user_root(user) / "logo.png"
        brand = clipper._render_brand_png(w, h, f"{tmp}/b.png", logo_path=str(logo) if logo.exists() else "",
                                          watermark=b["watermark"])
        if brand:
            frame.alpha_composite(Image.open(brand))
    # Voorbeeld-ondertitel met de accentkleur
    from PIL import ImageFont
    font_file = clipper._hook_box_font()
    if font_file:
        f = ImageFont.truetype(font_file, 34)
        dd = ImageDraw.Draw(frame)
        y = int(h * 0.78)
        words = [("zo", "#FFFFFF"), ("gaat", b["subtitle_color"]), ("het", "#FFFFFF")]
        total = sum(f.getlength(wd) for wd, _ in words) + f.getlength(" ") * 2
        x = (w - total) / 2
        for wd, col in words:
            dd.text((x, y), wd, font=f, fill=col, stroke_width=3, stroke_fill="#000000")
            x += f.getlength(wd + " ")
    out = io.BytesIO()
    frame.convert("RGB").save(out, "JPEG", quality=88)
    return Response(out.getvalue(), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ======================================================================
# Campagnes, verdiensten en analytics
# ======================================================================
@app.get("/api/my-campaigns")
def my_campaigns(user: dict = Depends(current_user)):
    return {"campaigns": accounts.list_campaigns(user["id"])}


@app.post("/api/my-campaigns")
def my_campaign_save(name: str = Form(...), cpm_eur: str = Form("0"), url: str = Form(""), platform: str = Form(""),
                     id: Optional[int] = Form(None), user: dict = Depends(current_user)):
    try:
        return accounts.save_campaign(user["id"], dict(name=name, cpm_eur=cpm_eur, url=url, platform=platform), id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.delete("/api/my-campaigns/{cid}")
def my_campaign_delete(cid: int, user: dict = Depends(current_user)):
    accounts.archive_campaign(user["id"], cid)
    return {"ok": True}


@app.post("/api/campaign/{job_id}/link")
def link_job_campaign(job_id: str, campaign_id: str = Form(""), user: dict = Depends(current_user)):
    own_job(job_id, user)
    camp = accounts.campaign_of(user["id"], campaign_id) if campaign_id else None
    accounts.set_job_campaign(user["id"], job_id, camp["id"] if camp else None)
    return {"ok": True, "campaign": camp}


@app.post("/api/stats/{job_id}/{clip_id}")
def save_clip_stats(job_id: str, clip_id: str, request: Request, posted: Optional[str] = Form(None),
                    platform: Optional[str] = Form(None), post_url: Optional[str] = Form(None),
                    views: Optional[str] = Form(None), likes: Optional[str] = Form(None),
                    comments: Optional[str] = Form(None), shares: Optional[str] = Form(None),
                    payout_eur: Optional[str] = Form(None), user: dict = Depends(current_user)):
    own_job(job_id, user)
    data = {k: v for k, v in dict(posted=posted, platform=platform, post_url=post_url, views=views, likes=likes,
                                  comments=comments, shares=shares, payout_eur=payout_eur).items() if v is not None}
    if post_url and not re.match(r"^https?://", post_url.strip()):
        data["post_url"] = ""
    return accounts.save_stats(user["id"], job_id, clip_id, data)


def _clips_of(job_id: str) -> list:
    job = JOBS.get(job_id)
    if job:
        return [c for c in job.get("clips") or [] if c]
    saved = load_job_state(job_id) or {}
    return [c for c in saved.get("clips") or [] if c]


@app.get("/api/analytics")
def get_analytics(days: int = 30, user: dict = Depends(current_user)):
    jobs = accounts.user_jobs(user["id"])
    clips = {j["job_id"]: _clips_of(j["job_id"]) for j in jobs}
    data = analytics.build(jobs, clips, accounts.stats_for_user(user["id"]), accounts.list_campaigns(user["id"]),
                           days=max(7, min(90, days)))
    data["quota"] = accounts.quota(user)
    return _sanitize(data)


if clipper.FONTS_DIR.exists():
    app.mount("/fonts", StaticFiles(directory=str(clipper.FONTS_DIR)), name="fonts")
frontend_dir = BASE_DIR.parent / "frontend"
if frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(frontend_dir), html=True), name="frontend")

# Shout at startup if an API route ended up behind the mount. Such a route
# answers 404 while looking perfectly correct in the source, which cost a
# whole round of debugging once already.
_verdwenen = [r.path for r in app.routes
              if getattr(r, "path", "").startswith("/api")
              and app.routes.index(r) > [i for i, x in enumerate(app.routes)
                                         if getattr(x, "name", "") == "frontend"][0]]
if _verdwenen:
    print("[ClipNova] LET OP: deze routes staan achter de mount en geven 404:",
          ", ".join(_verdwenen))
