"""
ClipNova core engine.

Pipeline per source video:
  1. Extract audio -> transcribe with faster-whisper (word-level timestamps)
  2. Send transcript + campaign briefing to an LLM (Anthropic Claude by default,
     Groq/OpenAI-compatible also supported) -> get back a JSON list of
     clip-worthy segments (start, end, hook line, reason, score)
  3. For each chosen segment: cut with ffmpeg, crop/pad to the requested aspect
     ratio (with simple face-priority cropping via OpenCV), optionally burn in
     a hook-text overlay and/or word-level subtitles.

This is designed to run on a normal Linux box with ffmpeg installed. No GPU
required (faster-whisper runs fine on CPU with the "base"/"small" models,
just slower than on GPU).
"""

import dataclasses
import json
import os
import urllib.error
import urllib.request
import textwrap
import threading
import re
import shutil
import subprocess
import sys
import time as _time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import people
try:
    from faster_whisper import WhisperModel
except ImportError:          # alleen nodig voor lokaal uitschrijven; Deepgram/Groq werken zonder
    WhisperModel = None

# "base" verhaspelt getallen en namen, en dan gaan hooks over ruis. "small" is veel
# nauwkeuriger. Sneller nodig? Zet CLIPPARTY_WHISPER_MODEL=base, of gebruik Deepgram/Groq.
WHISPER_MODEL_SIZE = os.environ.get("CLIPPARTY_WHISPER_MODEL", "small")
_whisper_model = None


def get_whisper_model():
    global _whisper_model
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is niet geïnstalleerd; zet een Deepgram- of Groq-sleutel of installeer faster-whisper.")
    if _whisper_model is None:
        # cpu_threads tells the underlying math library to actually spread
        # the transcription work across every CPU core Docker is allowed to
        # use, instead of leaving cores idle — this is usually the single
        # biggest lever for speed once Docker's own CPU limit is raised.
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE, device="cpu", compute_type="int8",
            cpu_threads=max(1, os.cpu_count() or 4),
        )
    return _whisper_model


@dataclass
class Settings:
    min_clips: int = 0
    max_clips: int = 100
    max_clip_duration: int = 60
    preferred_min: int = 15
    preferred_max: int = 40
    aspect_ratio: str = "9:16"       # "9:16", "1:1", "16:9"
    resolution: str = "1080x1920"
    llm_provider: str = ""           # "groq" | "anthropic" | "openai" — leeg = wat de beheerder koos
    face_priority: bool = True
    avoid_audio_only: bool = True
    subtitles: bool = True
    hook: bool = True
    highest_quality: bool = True
    download_quality: str = "1080"   # "720" | "1080" | "1440" | "max" — hoogte van de download
    apply_campaign_rules: bool = True
    preferred_share: float = 0.4  # share of clips that must land in the preferred window
    spoken_language: str = ""   # ISO code, e.g. "nl" — empty = ClipNova hears it itself (Dutch or English)
    output_language: str = ""   # language for titles/captions/hook text — empty = same language as the video
    # Extra languages to also write titles and captions in. Running one
    # account per language means the same clip needs its own wording for
    # each; generating them together saves a second full run.
    extra_languages: list = field(default_factory=list)
    stack_faces: bool = True    # side-by-side people -> stacked vertically
    reaction_layout: bool = True  # webcam + what the streamer is watching, stacked
    # How a clip is laid out. "auto" keeps the old behaviour: the app decides
    # per clip (reaction layout, two people stacked, or one crop) using the
    # two switches above. The others force one layout for every clip:
    #   "standaard" -- one crop that fills the frame, following the face
    #   "twee"      -- two panes, top and bottom
    #   "blur"      -- the whole frame, centred on a blurred copy of itself
    video_format: str = "blur"
    # Wie zit er in de video? Namen (komma-gescheiden) en/of de videobeschrijving.
    # De app zoekt daarmee gericht naar die mensen in de gezichtenbibliotheek en
    # gebruikt alleen die namen in hook, titel en bijschrift.
    people_names: str = ""
    video_description: str = ""
    # Eigen merk en hookstijl (per gebruiker, door de server ingevuld).
    hook_style: str = "tiktok"      # tiktok | zwart | merk | omlijnd | geel
    hook_position: str = "boven"    # boven | midden
    brand_color: str = "#7C5CFF"    # balkkleur bij stijl "merk"
    brand_text_color: str = "#FFFFFF"
    subtitle_color: str = "#FFE500" # kleur van het woord dat nu klinkt
    font_path: str = ""             # leeg = TikTok Sans
    logo_path: str = ""             # PNG rechtsboven, leeg = geen logo
    watermark: str = ""             # bijv. @jouwnaam, onderin klein
    faces_root: str = ""            # map met de gezichtenbibliotheek van deze gebruiker


@dataclass
class ClipResult:
    id: str
    source_video: str
    start: float
    end: float
    hook: str
    reason: str
    score: float
    output_path: str
    face_detected: bool = False
    language: Optional[str] = None
    text: str = ""   # wat er in de clip gezegd wordt; basis voor het bijschrift
    people: list = field(default_factory=list)   # herkende personen die in deze clip te zien zijn


def run(cmd: list[str]) -> None:
    """Runs a command, raising a readable error that includes the tool's own
    stderr. Without this, a failing ffmpeg surfaced only as 'returned
    non-zero exit status 8' plus the entire command line, with ffmpeg's
    actual explanation thrown away."""
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()
        tail = " | ".join(detail[-3:]) if detail else "geen details"
        raise RuntimeError(f"{Path(cmd[0]).name} mislukt (code {result.returncode}): {tail}")


def _has_audio(video_path: str) -> bool:
    """Checks for an audio stream before trying to extract one."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
             "stream=index", "-of", "csv=p=0", video_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        return bool(r.stdout.strip())
    except Exception:
        return True          # assume there is audio; extraction will tell us


def _moments_evenly_spaced(settings, video_end, hard_min: float) -> list:
    """Last resort: spread clips across the footage.

    Silent gameplay has neither speech nor sound to go on, but the material is
    still usable. Evenly spaced excerpts are a weak selection, yet far better
    than returning nothing for a campaign that only needs raw gameplay.
    """
    if not video_end or video_end < hard_min * 2:
        return []
    length = max(hard_min, min(settings.preferred_min, settings.max_clip_duration))
    count = min(settings.max_clips or 3, max(1, int(video_end // (length * 2))))
    step = video_end / (count + 1)
    out = []
    for i in range(count):
        start = max(0.0, min(step * (i + 1) - length / 2, video_end - length))
        out.append({"start": start, "end": start + length, "score": 0.3,
                    "reason": "gelijkmatig over de opname verdeeld",
                    "hook": "", "title": "", "caption": ""})
    return out


def extract_audio(video_path: str, out_dir: str) -> str:
    audio_path = str(Path(out_dir) / f"{Path(video_path).stem}.wav")
    run(["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "16000", audio_path])
    return audio_path


# ---------- Deepgram (betaald, snelst) ----------
# Sleutels die de beheerder één keer in de app invult. Ze staan op het volume
# (storage/keys.json), dus ze blijven bewaard na een herstart of een nieuwe build
# en hoeven niet bij elke `docker run` mee. Staat er niets, dan geldt de
# omgevingsvariabele. Nooit in de code of de repo zetten.
KEYS_FILE = Path(__file__).parent / "storage" / "keys.json"
DEEPGRAM_FILE = Path(__file__).parent / "storage" / "deepgram.json"   # oud (t/m v126)
KEY_ENV = {"deepgram": "DEEPGRAM_API_KEY", "groq": "GROQ_API_KEY",
           "anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
AI_PROVIDERS = ("groq", "anthropic", "openai")
_KEYS_LOCK = threading.Lock()


def _stored_keys() -> dict:
    try:
        data = json.loads(KEYS_FILE.read_text())
        data = data if isinstance(data, dict) else {}
    except Exception:
        data = {}
    if not data.get("deepgram"):
        try:
            old = json.loads(DEEPGRAM_FILE.read_text()).get("api_key")
            if old:
                data["deepgram"] = old
        except Exception:
            pass
    return data


def service_key(name: str) -> Optional[str]:
    """Sleutel uit de app (storage/keys.json), anders uit de omgevingsvariabele."""
    return (str(_stored_keys().get(name) or "").strip()
            or os.environ.get(KEY_ENV.get(name, ""), "").strip() or None)


def key_source(name: str) -> str:
    """'app', 'env' of '' — waar de sleutel vandaan komt, voor het scherm."""
    if str(_stored_keys().get(name) or "").strip():
        return "app"
    return "env" if os.environ.get(KEY_ENV.get(name, ""), "").strip() else ""


def _write_keys(data: dict) -> None:
    KEYS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = KEYS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.chmod(tmp, 0o600)
    tmp.replace(KEYS_FILE)


def save_service_key(name: str, key: str) -> None:
    with _KEYS_LOCK:
        data = _stored_keys()
        if key and key.strip():
            data[name] = key.strip()
        else:
            data.pop(name, None)
        _write_keys(data)
        if name == "deepgram":
            DEEPGRAM_FILE.unlink(missing_ok=True)


def preferred_provider() -> str:
    """De AI-aanbieder die de beheerder koos (standaard Groq)."""
    p = str(_stored_keys().get("ai_provider") or os.environ.get("CLIPNOVA_AI_PROVIDER") or "groq").lower()
    return p if p in AI_PROVIDERS else "groq"


def save_preferred_provider(provider: str) -> None:
    if provider not in AI_PROVIDERS:
        raise ValueError(f"Onbekende aanbieder: {provider}")
    with _KEYS_LOCK:
        data = _stored_keys()
        data["ai_provider"] = provider
        _write_keys(data)


def resolve_ai(provider: Optional[str] = None, api_key: Optional[str] = None) -> tuple:
    """(aanbieder, sleutel) die echt bij elkaar horen. Tot v126 kon een
    Groq-sleutel naar Anthropic gaan (of andersom), en dan viel de run stil
    terug op 'geen AI'. Heeft de gekozen aanbieder geen sleutel, dan de eerste
    aanbieder die er wel een heeft."""
    provider = provider if provider in AI_PROVIDERS else ""
    if api_key:
        return provider or preferred_provider(), api_key
    order = [p for p in (provider, preferred_provider()) + AI_PROVIDERS if p]
    for p in dict.fromkeys(order):
        key = service_key(p)
        if key:
            return p, key
    return provider or preferred_provider(), None


def deepgram_key() -> Optional[str]:
    return service_key("deepgram")


def save_deepgram_key(key: str) -> None:
    save_service_key("deepgram", key)


def _deepgram_request(body: bytes, key: str, model: str, language: Optional[str]) -> dict:
    import urllib.request, urllib.error, urllib.parse
    q = {"model": model, "smart_format": "true", "punctuate": "true", "utterances": "true"}
    if language:
        q["language"] = language
    else:
        q["detect_language"] = "true"
    req = urllib.request.Request(
        os.environ.get("CLIPPARTY_DEEPGRAM_BASE", "https://api.deepgram.com") + "/v1/listen?" + urllib.parse.urlencode(q),
        data=body, method="POST",
        headers={"Authorization": f"Token {key}", "Content-Type": "audio/ogg"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Deepgram HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}")


def transcribe_deepgram(audio_path: str, key: str, work_dir: str, progress_cb=None,
                        language: Optional[str] = None) -> tuple[list[dict], dict]:
    """Uitschrijven via Deepgram Nova-3: de hele video in één verzoek.

    Eerst naar kleine Opus-audio (32 kbit/s, een uur is ~15 MB), zodat het
    uploaden op een thuisverbinding geen minuten duurt. Kent Nova-3 de taal
    niet, dan nog één keer met Nova-2."""
    small = str(Path(work_dir) / "deepgram.ogg")
    run(["ffmpeg", "-y", "-i", audio_path, "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "libopus", "-b:a", "32k", small])
    if progress_cb:
        progress_cb(0.15)
    body = Path(small).read_bytes()
    try:
        data = _deepgram_request(body, key, "nova-3", language)
    except RuntimeError as e:
        if "HTTP 400" not in str(e):
            raise
        data = _deepgram_request(body, key, "nova-2", language)
    finally:
        Path(small).unlink(missing_ok=True)
    results = data.get("results") or {}
    segments = [{"start": float(u["start"]), "end": float(u["end"]), "text": u["transcript"].strip()}
                for u in results.get("utterances") or [] if (u.get("transcript") or "").strip()]
    if not segments:
        # Geen utterances (heel kort of stil): dan de zinnen uit de alinea's.
        alt = ((results.get("channels") or [{}])[0].get("alternatives") or [{}])[0]
        for para in (alt.get("paragraphs") or {}).get("paragraphs") or []:
            for sen in para.get("sentences") or []:
                if (sen.get("text") or "").strip():
                    segments.append({"start": float(sen["start"]), "end": float(sen["end"]), "text": sen["text"].strip()})
    detected = ((results.get("channels") or [{}])[0].get("detected_language"))
    if progress_cb:
        progress_cb(1.0)
    return segments, {"language": (language or detected or "nl").split("-")[0], "probability": 1.0 if language else 0.9}


GROQ_WHISPER_MODEL = os.environ.get("CLIPPARTY_GROQ_WHISPER", "whisper-large-v3-turbo")
GROQ_CHUNK_SECONDS = 20 * 60   # 20 min Opus op 32 kbit/s is ~5 MB, ruim onder de 25 MB-grens


def _groq_transcribe_file(path: str, key: str, language: Optional[str]) -> dict:
    import urllib.request, urllib.error
    boundary = "----clipparty" + uuid.uuid4().hex
    fields = {"model": GROQ_WHISPER_MODEL, "response_format": "verbose_json", "temperature": "0"}
    if language:
        fields["language"] = language
    body = b""
    for k, v in fields.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").encode()
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.ogg\"\r\n"
             "Content-Type: audio/ogg\r\n\r\n").encode() + Path(path).read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        os.environ.get("CLIPPARTY_GROQ_BASE", "https://api.groq.com") + "/openai/v1/audio/transcriptions",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Groq transcriptie HTTP {e.code}: {e.read()[:200]!r}")


def transcribe_groq(video_or_audio: str, key: str, work_dir: str, progress_cb=None,
                    language: Optional[str] = None) -> tuple[list[dict], dict]:
    """Uitschrijven via Groq (Whisper large-v3-turbo in de cloud).

    Op een gewone pc is dit tientallen keren sneller dan faster-whisper op de
    cpu, en nauwkeuriger dan het lokale "base"-model. De audio gaat in stukken
    van 20 minuten als kleine Opus-bestanden, parallel, met de tijden
    achteraf teruggeschoven naar de positie in de hele video."""
    out_dir = Path(work_dir) / "groq_audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    run(["ffmpeg", "-y", "-i", video_or_audio, "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "libopus", "-b:a", "32k", "-f", "segment", "-segment_time", str(GROQ_CHUNK_SECONDS),
         "-reset_timestamps", "1", str(out_dir / "part%03d.ogg")])
    parts = sorted(out_dir.glob("part*.ogg"))
    if not parts:
        raise RuntimeError("geen audio om uit te schrijven")
    results = [None] * len(parts)
    done = 0
    with ThreadPoolExecutor(max_workers=min(3, len(parts))) as pool:
        futs = {pool.submit(_groq_transcribe_file, str(p), key, language): i for i, p in enumerate(parts)}
        for fut in as_completed(futs):
            results[futs[fut]] = fut.result()
            done += 1
            if progress_cb:
                progress_cb(done / len(parts))
    segments, lang = [], None
    for i, r in enumerate(results):
        offset = i * GROQ_CHUNK_SECONDS
        lang = lang or r.get("language")
        for seg in r.get("segments") or []:
            text = (seg.get("text") or "").strip()
            if text:
                segments.append({"start": float(seg["start"]) + offset,
                                 "end": float(seg["end"]) + offset, "text": text})
    for p in parts:
        p.unlink(missing_ok=True)
    # Groq geeft de taal als woord ("dutch"); de rest van de app werkt met codes.
    names = {"dutch": "nl", "english": "en", "german": "de", "french": "fr", "spanish": "es"}
    code = names.get(str(lang or "").lower(), lang) or language
    return segments, {"language": code, "probability": 1.0 if language else 0.9}


# ---------- Taal van de video herkennen (Nederlands of Engels) ----------
LANG_NAMES = {"nl": "Dutch", "en": "English", "de": "German", "fr": "French", "es": "Spanish"}
# Uit welke talen kiest ClipNova als het zelf luistert? Bewust maar twee: tussen
# Nederlands en Engels is Whisper zeker, terwijl het op rumoerige streamaudio
# soms "Arabisch" of "Russisch" raadt. Wil je ook Duits e.d.? Voeg de code toe.
DETECT_CANDIDATES = ("nl", "en")

_STOPWORDS = {
    "nl": set("""de het een en van ik je jij dat die niet op te voor met zijn maar ook nog wel dan nu hij ze wij
        er aan als dit zo bij naar kan want om wat hebben heb hier daar toch gewoon nou echt heel jullie mij
        mijn hun dus hebt wordt werd meer veel over uit door deze geen iets weer goed ja""".split()),
    "en": set("""the a and of to that it you i for on with this they are but not be have at or as he she from my
        your so just what there like do dont don't did its it's i'm you're going gonna get about can will
        would if all out up know think really yeah""".split()),
}


def _guess_language_from_text(transcript: list, max_words: int = 20000) -> Optional[str]:
    """Raadt 'nl' of 'en' uit de uitgeschreven tekst, aan de hand van veelvoorkomende
    functiewoorden. Kost niets en werkt hetzelfde voor lokale Whisper, Groq en Deepgram.
    Geeft None als de tekst te kort of te twijfelachtig is."""
    words = []
    for seg in transcript or []:
        words.extend(re.findall(r"[a-z']+", str(seg.get("text") or "").lower()))
        if len(words) >= max_words:
            break
    if len(words) < 30:
        return None
    n = float(len(words))
    nl = sum(1 for w in words if w in _STOPWORDS["nl"]) / n
    en = sum(1 for w in words if w in _STOPWORDS["en"]) / n
    top, other = (nl, en) if nl >= en else (en, nl)
    if top < 0.08 or top < 1.4 * max(other, 1e-9):
        return None
    return "nl" if nl >= en else "en"


def _detect_spoken_language(audio_path: str) -> Optional[str]:
    """Luistert naar een paar stukjes van 30 seconden, verspreid over de hele opname,
    en kiest daaruit Nederlands of Engels. Eén stuk aan het begin (zoals Whisper zelf
    doet) is te weinig: streams beginnen vaak met muziek of stilte.
    Geeft None als het niet lukt; dan beslist Whisper zelf."""
    try:
        model = get_whisper_model()
        dur = _video_duration(audio_path) or 0.0
        if dur < 5:
            return None
        window = 30.0
        n = 5 if dur > 600 else 3
        score = {c: 0.0 for c in DETECT_CANDIDATES}
        for i in range(n):
            start = max(0.0, min(dur - window, dur * (i + 0.5) / n))
            raw = subprocess.run(
                ["ffmpeg", "-v", "error", "-ss", f"{start:.1f}", "-t", f"{window:.0f}", "-i", audio_path,
                 "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120).stdout
            audio = np.frombuffer(raw, dtype=np.float32)
            if audio.size < 16000 * 3:
                continue
            res = model.detect_language(audio=audio)
            probs = dict(res[2]) if len(res) >= 3 and res[2] else {res[0]: res[1]}
            for code in DETECT_CANDIDATES:
                score[code] += float(probs.get(code, 0.0))
        if sum(score.values()) < 0.3:
            return None      # vrijwel geen spraak gehoord
        return max(score, key=score.get)
    except Exception as e:
        print(f"[ClipNova] Taal herkennen mislukt ({type(e).__name__}: {e}) — Whisper kiest zelf.", flush=True)
        return None


def _resolve_output_language(settings: "Settings", rules: Optional[dict], language_info: dict,
                             transcript: list) -> str:
    """In welke taal schrijft ClipNova hook, titel, beschrijving en bijschrift?
    1. de taal die de campagnebriefing eist,
    2. anders wat de gebruiker zelf koos,
    3. anders de taal die in de video gesproken wordt."""
    explicit = str((rules or {}).get("language_code") or settings.output_language or "").strip().lower()[:2]
    if explicit:
        return explicit
    guess = _guess_language_from_text(transcript)
    if guess:
        return guess
    heard = str((language_info or {}).get("language") or "").strip().lower()[:2]
    return heard if heard in LANG_NAMES else "nl"


# Zet CLIPNOVA_WORD_TIMING=1 voor echte woordtijden van Whisper (nauwkeuriger
# ondertitels, maar het transcriberen duurt langer). Standaard: tijd per woord
# verdelen over de zin, wat voor korte ondertitelregels bijna niet te zien is.
_WORD_TIMING = os.environ.get("CLIPNOVA_WORD_TIMING", "").lower() in ("1", "true", "yes")


def transcribe(audio_path: str, progress_cb=None, language: Optional[str] = None) -> tuple[list[dict], dict]:
    """Transcribes with voice-activity filtering on by default (skips
    silence, which speeds things up a lot). Falls back to no VAD filtering
    if that crashes — a known faster-whisper edge case when a video has
    little or no detected speech at all (e.g. mostly music/gameplay-sound
    footage), where the VAD step can raise 'max() arg is an empty
    sequence'. Without VAD it just transcribes everything, which is slower
    but always works, and for a speech-light video there isn't much to
    transcribe anyway.

    Two more free speed choices worth noting:
    - word_timestamps is off — nothing in this app actually reads word-level
      timing (subtitles work off segment start/end), so leaving it on was
      pure wasted compute, often a large chunk of total transcribe time.
    - beam_size=1 (greedy decoding) instead of the library default (5) —
      several times faster, at a small, usually unnoticeable accuracy cost
      for this app's purposes (picking clip-worthy moments, not
      publishing a transcript).

    Returns (segments, language_info) — language_info is used later to
    check a campaign's language requirement (e.g. "Nederlandstalig")
    against what was actually spoken in the clip."""
    model = get_whisper_model()
    if not language:
        # Eerst zelf de taal vaststellen. Whisper met een verkeerde taal "vertaalt" of
        # hallucineert en probeert elk stuk meerdere keren opnieuw: dat is veel trager
        # en geeft een onbruikbaar transcript.
        language = _detect_spoken_language(audio_path)
        if language:
            print(f"[ClipNova] Gesproken taal herkend: {language}", flush=True)

    def _run(vad: bool):
        # Pinning the language matters a lot here. Left on auto-detect, Whisper
        # guesses per audio window, and on noisy stream audio (music, game
        # sound, crosstalk) it regularly guesses wrong and "transcribes" Dutch
        # speech as Arabic or Russian script — which then poisons the clip
        # titles and captions downstream. If the campaign states a language, or
        # the user picks one, we tell Whisper instead of letting it guess.
        segments, info = model.transcribe(
            audio_path, word_timestamps=_WORD_TIMING, vad_filter=vad, beam_size=1,
            language=language or None,
        )
        # faster-whisper returns a generator: the actual work happens as we
        # iterate, so this loop is where the minutes go. Reporting each
        # segment's end position against the audio duration turns the app's
        # longest phase from a blank wait into a real percentage.
        total = float(getattr(info, "duration", 0) or 0)
        out = []
        for seg in segments:
            item = {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
            }
            if _WORD_TIMING and getattr(seg, "words", None):
                item["words"] = [{"word": w.word.strip(), "start": float(w.start), "end": float(w.end)}
                                 for w in seg.words]
            out.append(item)
            if progress_cb and total > 0:
                progress_cb(min(1.0, float(seg.end) / total))
        if progress_cb:
            progress_cb(1.0)
        language_info = {
            "language": getattr(info, "language", None),
            "probability": float(getattr(info, "language_probability", 0) or 0),
        }
        return out, language_info

    try:
        return _run(vad=True)
    except Exception:
        return _run(vad=False)


def _merge_short_segments(transcript: list[dict], min_seconds: float = 6.0) -> list[dict]:
    """Glues very short speech segments together into longer lines.

    Whisper emits a line every few seconds, and each line costs a timestamp.
    On an hour of speech that timestamp overhead is larger than the words
    themselves. Merging up to a few seconds keeps the timing accurate enough
    to cut on - clips run tens of seconds - while roughly halving the volume.
    """
    if not transcript:
        return transcript
    out = []
    for seg in transcript:
        if out and (float(seg["end"]) - float(out[-1]["start"])) <= min_seconds:
            out[-1] = {"start": out[-1]["start"], "end": seg["end"],
                       "text": (out[-1]["text"].rstrip() + " " + seg["text"].lstrip()).strip()}
        else:
            out.append({"start": seg["start"], "end": seg["end"], "text": seg["text"]})
    return out


def _transcript_to_text(transcript: list[dict]) -> str:
    """One line per segment, timestamp in whole seconds.

    The end time is left out: the next line's start says where this one
    stops, so printing it twice only spends tokens. Tenths of a second are
    dropped for the same reason - nothing downstream cuts that precisely.
    """
    merged = _merge_short_segments(transcript)
    lines = [f"[{int(float(s['start']))}] {s['text']}" for s in merged]
    return "\n".join(lines)


def _api_headers(key: str) -> dict:
    """Headers for OpenAI-compatible endpoints (Groq/OpenAI).

    The User-Agent matters: Python's urllib default ("Python-urllib/3.x")
    is on Cloudflare's blocklist, so requests get rejected with HTTP 403
    error code 1010 *even with a perfectly valid API key* — which is
    exactly what was happening here. Sending a normal application
    User-Agent avoids that."""
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "ClipNova/1.0",
    }


def clip_text(transcript, start: float, end: float, limit: int = 1500) -> str:
    """Tekst van alle stukken die de clip overlappen (niet alleen die er
    helemaal binnen vallen: Deepgram-zinnen kunnen over de rand lopen)."""
    parts = [str(seg.get("text") or "").strip() for seg in (transcript or [])
             if float(seg.get("end", 0)) > start and float(seg.get("start", 0)) < end]
    return " ".join(p for p in parts if p)[:limit]


def call_llm(system: str, user: str, provider: str = "anthropic", api_key: Optional[str] = None,
             max_tokens: int = 2000, temperature: float = 0.4) -> Optional[str]:
    """Generic LLM call used for clip selection, rule extraction, and caption
    generation. Returns None if no key is configured or the call fails, so
    callers can fall back to heuristics. Prints what happened either way, so
    a fallback shows up clearly in `docker logs`/the terminal instead of
    failing silently."""
    provider, key = resolve_ai(provider, api_key)
    if not key:
        print(f"[ClipNova] Geen AI-sleutel ingesteld (Groq, Anthropic of OpenAI) — gebruik heuristische fallback (geen echte AI).")
        return None
    try:
        if provider == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=key)
            resp = client.messages.create(
                model="claude-sonnet-4-6", max_tokens=max_tokens, system=system,
                messages=[{"role": "user", "content": user}],
            )
            print(f"[ClipNova] LLM-call ({provider}) gelukt.")
            return "".join(b.text for b in resp.content if b.type == "text")
        else:
            import urllib.request
            import urllib.error
            base = "https://api.groq.com/openai/v1/chat/completions" if provider == "groq" else "https://api.openai.com/v1/chat/completions"
            model_name = "openai/gpt-oss-120b" if provider == "groq" else "gpt-4o-mini"
            body = {
                "model": model_name,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "temperature": temperature,
            }
            if provider == "groq":
                # gpt-oss denkt eerst na; "low" kost veel minder tokens en
                # houdt je zo langer onder de gratis limiet per minuut.
                body["reasoning_effort"] = "low"
            payload = json.dumps(body).encode()
            for attempt in range(6):
              req = urllib.request.Request(base, data=payload, headers=_api_headers(key))
              try:
                  with urllib.request.urlopen(req, timeout=60) as r:
                      data = json.loads(r.read())
              except urllib.error.HTTPError as e:
                # The response body usually contains the real reason (bad
                # key, wrong/retired model name, rate limit) — a bare
                # "HTTP Error 401" without it isn't enough to debug from.
                  body = e.read().decode(errors="ignore")[:500]
                  if e.code == 429 and attempt < 5:
                    # Per-minute token budget momentarily exhausted. Waiting
                    # is the correct response: the request itself is fine.
                    # Groq zegt in retry-after hoe lang; anders oplopend.
                      try:
                          wait = min(60, max(3, int(float(e.headers.get("retry-after", "0")) + 1)))
                      except Exception:
                          wait = 0
                      wait = wait or min(60, 15 * (attempt + 1))
                      print(f"[ClipNova] Tokenlimiet bereikt, {wait}s wachten.", flush=True)
                      _time.sleep(wait)
                      continue
                  raise RuntimeError(f"HTTP {e.code}: {body}") from e
              break
            print(f"[ClipNova] LLM-call ({provider}) gelukt.")
            msg = data["choices"][0]["message"]
            # Reasoning-style models sometimes leave "content" empty and put
            # everything in a separate field; take whichever holds text.
            return (msg.get("content") or msg.get("reasoning")
                    or msg.get("reasoning_content") or "")
    except Exception as e:
        print(f"[ClipNova] LLM-call ({provider}) MISLUKT: {type(e).__name__}: {e} — gebruik heuristische fallback.")
        return None


def test_llm_connection(provider: str = "anthropic", api_key: Optional[str] = None) -> dict:
    """Makes one small real API call to verify the configured provider is
    reachable and the key actually works, and returns a clear, displayable
    result — meant to be surfaced directly in the UI, since relying on
    Docker terminal logs to debug this has proven unreliable in practice."""
    if api_key is None and provider in AI_PROVIDERS:
        # De test gaat over precies deze aanbieder, dus niet uitwijken naar een andere.
        key = service_key(provider)
    else:
        provider, key = resolve_ai(provider, api_key)
    if not key:
        return {"connected": False, "provider": provider, "message": f"Nog geen sleutel voor {provider}. Plak hem hierboven en klik op Bewaren."}
    try:
        if provider == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=key)
            resp = client.messages.create(model="claude-sonnet-4-6", max_tokens=10, messages=[{"role": "user", "content": "Reply with only the word OK"}])
            text = "".join(b.text for b in resp.content if b.type == "text")
        else:
            import urllib.request
            import urllib.error
            base = "https://api.groq.com/openai/v1/chat/completions" if provider == "groq" else "https://api.openai.com/v1/chat/completions"
            model_name = "openai/gpt-oss-120b" if provider == "groq" else "gpt-4o-mini"
            payload = json.dumps({
                "model": model_name,
                "messages": [{"role": "user", "content": "Reply with only the word OK"}],
                "max_tokens": 10,
            }).encode()
            req = urllib.request.Request(base, data=payload, headers=_api_headers(key))
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read())
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="ignore")[:500]
                raise RuntimeError(f"HTTP {e.code}: {body}") from e
            text = data["choices"][0]["message"]["content"]
        return {"connected": True, "provider": provider, "message": f"Verbonden — AI antwoordde: \"{text.strip()[:60]}\""}
    except Exception as e:
        return {"connected": False, "provider": provider, "message": f"{type(e).__name__}: {e}"}


def _parse_json_block(text: str):
    """Pulls JSON out of a model reply, however it chose to wrap it.

    Requiring the whole reply to be bare JSON is too strict in practice:
    models wrap it in ```json fences, prefix it with a sentence, or append a
    closing remark. Any of those made the reply "unreadable" and the feature
    silently fell back to nothing. This finds the first balanced JSON value in
    the text instead.
    """
    if not text:
        raise ValueError("leeg antwoord")
    cleaned = text.strip()

    # ```json ... ``` fences
    fence = re.search(r"```(?:json)?\s*(.+?)```", cleaned, re.S | re.I)
    if fence:
        cleaned = fence.group(1).strip()

    try:
        return json.loads(cleaned)
    except Exception:
        pass

    # Fall back to the first balanced [...] or {...} anywhere in the reply.
    # Order by whichever bracket appears first in the text, not by a fixed
    # preference: starting with "[" on an object reply picks up a nested array
    # ({"platforms": ["tiktok"]} would return just ["tiktok"]).
    first_sq, first_cu = cleaned.find("["), cleaned.find("{")
    pairs = [("[", "]"), ("{", "}")]
    if first_cu != -1 and (first_sq == -1 or first_cu < first_sq):
        pairs.reverse()
    for opener, closer in pairs:
        start = cleaned.find(opener)
        while start != -1:
            depth, in_str, esc = 0, False, False
            for i in range(start, len(cleaned)):
                ch = cleaned[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(cleaned[start:i + 1])
                        except Exception:
                            break
            start = cleaned.find(opener, start + 1)

    raise ValueError(f"geen JSON gevonden in antwoord: {text[:120]!r}")


LLM_SYSTEM_PROMPT = """You are a viral short-form video editor working on a paid brand campaign.
You are given a timestamped transcript of a longer video, the campaign briefing, and (if
available) a structured rule-set already extracted from that briefing. Pick the best standalone
moments to turn into short clips that are BOTH likely to get views AND compliant with the rules.

Rules:
- Only use timestamps that appear in the transcript.
- Aim for {pref_min}-{pref_max} seconds per clip: most of your picks should land in that
  range, so include enough surrounding context rather than returning bare snippets. A
  moment that genuinely only works shorter or longer may fall outside it, but that should
  be the exception: a full story with a beginning, a middle and a reveal or punchline may run
  longer, a pure one-liner may run shorter. Never exceed {max_dur} seconds or go under {min_dur}.
- Pick between {min_clips} and {max_clips} clips total.
- QUALITY OVER QUANTITY: a few clips that really work beat many average ones. Skip a moment
  rather than pick a weak one.

HOW SHORT-FORM VIDEO IS RANKED (this decides what you pick):
- The platforms mainly reward COMPLETION (do people watch to the end?), REWATCH (do they
  replay it?) and SHARES/SAVES. Likes matter least. Length by itself earns nothing: a tight
  25-second clip that people finish beats a 60-second clip they abandon.
- So choose moments where attention never dips: no dead air, no slow build-up, a payoff that
  the viewer is waiting for the whole time.

WHAT MAKES A CLIP WORK (use this to choose and to score):
1. EMOTION + RECOGNITION. Strong emotion (laughter, shock, anger, awkwardness, pride) combined
   with something the viewer recognises from their own life beats neutral information.
2. THE FIRST 3 SECONDS. Set "start" exactly where the most surprising, emotional, funny or
   controversial sentence begins, so the clip opens IN the action or with the conflict, reaction
   or claim. Cut in late. Never start on greetings, filler ("so", "um", "welcome back"), intros or
   setup that can be skipped; the context is delivered by the hook text instead of by waiting.
3. CURIOSITY GAP. Prefer moments where a question, tension or promise is opened early and only
   answered at the end, so the viewer must stay to close the loop.
4. SOCIAL CURRENCY. Prefer moments people want to send to a friend or save: useful, surprising,
   quotable, "this is so you", or "you should know this".
5. SPECIFIC BEATS VAGUE. A concrete number, amount, name, result or claim ("2 jaar, 0 euro,
   toen dit") is stronger than a general statement.
6. PACE AND VARIETY. Prefer fragments with energy, reactions, interruptions and changes of
   subject. A calm monologue with no movement or emphasis loses viewers; skip it unless the
   content itself is exceptional.
- Prefer: bold claims, strong opinions, unexpected reveals, conflict, big emotion, laughs, a
  concrete story with a twist, a surprising number, or a "wait, what?" moment.
- Avoid: rambling, explanations that need earlier context, slow build-ups, small talk, and
  moments that only make sense if you saw the rest of the video.
- END RIGHT AFTER THE PAYOFF (punchline, answer, reveal). Do not trail off into extra sentences:
  a short clip that ends on a high beats a longer one that fades out. Best of all is an ending
  that connects back to the opening line, or leaves a small open question, so people replay it.
- Every clip must be self-contained: one idea, one payoff, understandable cold.
- Make the clips clearly different from each other; do not pick overlapping or near-identical moments.
- Be strict with "score": 0.9+ only for exceptional moments, 0.5-0.7 for decent ones. Do not give
  everything a high score.

REJECT THESE (do not return them at all):
- Moments where the transcript looks garbled, or is mostly numbers, single words or fragments you
  cannot turn into a clear story. If you cannot say in one plain sentence WHAT HAPPENS in the
  clip, skip it.
- Someone only reading out, counting or guessing numbers/items with no reaction, conflict, story or
  payoff a stranger would care about.
- Anything that only makes sense if you watched the stream before it.
THE STRANGER TEST: imagine someone who has never seen this streamer, scrolling at night. Would they
understand what is going on within 3 seconds AND want to see how it ends? If not, skip it.

THE "hook" FIELD is the on-screen text and the MOST IMPORTANT part of the clip: people decide in
1-2 seconds whether to keep watching, and many watch without sound. Rules for the hook:
- Max 12 words (about 75 characters), on at most 3 short lines. Short enough to read in one glance. It must NOT be a
  description like "Funny moment" or a copy of the first words spoken.
- Write it in {out_lang}, the language spoken in the clip, never in another language.
- THE HOOK MUST NAME THE CONCRETE EVENT: who does or says what, using real nouns from the clip
  ("Lacy schat het gewicht en zit er 400 gram naast"), not a vague teaser. A viewer who reads only
  the hook must already know what the clip is about.
- BANNED, because they say nothing: "Here is what he says about <X>", "Hij zegt dit over <X>",
  "You won't believe...", "Wait for it", "Dit ga je niet geloven", "will blow your mind", a hook
  that is only a number or a single word, any hook that would fit on any clip. Never build a hook
  on a number or word you are not sure was really said (the transcript may be mistranscribed).
- Put the most interesting word early. Use specifics that are really said in the clip (a number,
  an amount, a job, a result). NEVER invent facts, numbers or credentials that are not in the
  transcript, the source title or the campaign brief, and only promise something that really
  happens in the clip.
- MATCH THE TONE OF THE CLIP. First decide what kind of clip it is:
  * FUNNY / RELATABLE / AWKWARD clip -> a POV hook that puts the viewer in the scene, with 1-2
    emoji that fit (😂 💀 😭 🤣). Style examples: "POV: jij en je vrienden gaan in de nacht eten
    maken😂💀", "POV: je zegt "dat kan ik wel blind" en je vrienden nemen het letterlijk",
    "POV: je zegt "nog één potje" om 3 uur 's nachts😂".
  * SERIOUS clip (money, business, advice, health, personal stories, anything with weight) ->
    a serious hook with NO jokes and NO POV: a specific claim, a number, a credential or a
    surprising fact, with an open loop that makes people watch to the end. At most one calm
    emoji, or none. Examples: "Zo bouwde hij een webshop op van €0 naar €1M", "Dit fout kostte
    hem 50.000 euro", "Niemand vertelt je dit over e-commerce". Never mock the topic.
  * DRAMA / PEOPLE / RELATIONSHIP / GOSSIP clip (people talking about each other, arguments, love,
    break-ups, funny or awkward situations between known people) -> a STORY HEADLINE in plain
    spoken Dutch that names the people and says what happens, like a friend telling it. This is the
    style of Dutch clip pages that reach tens of thousands of views per clip. Style examples:
    "Gio begon Athena leuk te vinden en showt het off naar Jade 🥀😭",
    "POV: Gio laat Athena vloggen om Jade te pesten 💀😭",
    "Toen Gio met Athena ging om over zijn liefdesverdriet heen te komen 😭",
    "Zo ontstond Lil Kleine zijn relatie met Jamie Vaes 🥹",
    "Enzo en Myron ruzie tijdens autorijden maar de liefde blijft ❤️",
    "Bokoesam verpest podcast en Lil Kleine zit te stoken 😆".
    Patterns: "Toen X ...", "X begon ... en ...", "Zo ontstond ...", "POV: ...", or "X na de
    breakup ...". Use the real first names or names of the people in the clip, one or two emoji at the
    end (😭 💀 🥹 🥀 😆 ❤️). Only use names that are really said in the transcript, the source
    title or the brief; if you are not sure who is who, describe it without a name instead of guessing.
  * SHOCKING / CONFLICT / EMOTIONAL clip -> open with the reaction or the claim itself:
    "Hij zegt dit live in zijn stream 😳", "Dit had niemand verwacht 😱".
- Proven formulas to choose from (pick the one that fits THIS fragment, vary them between clips):
    1. POV (funny only): "POV: ..." with a specific, recognisable situation.
    2. CONFLICT / REACTION FIRST: state the incident or the reaction, not the context.
    3. SPECIFIC NUMBER OR CREDENTIAL: "Jonge ondernemer die 2m+ p/m maakt legt het uit".
    4. CURIOSITY GAP: tease the result and withhold the how: "Zijn grootste fout kostte hem 50k".
    5. NOBODY TELLS YOU THIS / CONTRARIAN: "Dit vertelt niemand je over geld verdienen",
       "Hierom word je nooit rijk met een 9-5".
    6. DIRECT QUESTION or CALL-OUT to the viewer: "Zou jij dit durven?", "Dit is voor jou als je...".
    7. MISTAKE WARNING: "Doe dit niet als je net begint".
- If a SOURCE VIDEO title/description is given, USE IT: it says who is speaking and what makes them
  interesting. Combine that credential with what is said in the specific clip, so the hook tells
  the viewer who is talking, why to listen, and teases the payoff.
- Never reuse the same hook wording for two clips.
{avoid_audio_only}
- Follow the campaign briefing's tone/topic instructions.
{rules_block}

Write "hook" and "reason" in {out_lang}, the language spoken in the video. The transcript may be noisy or partly mistranscribed
into the wrong script -- ignore that and write clean, natural {out_lang}; never copy raw
transcript fragments into the hook.

Respond ONLY with a JSON array, no prose, no markdown fences. Each item:
{{"start": number, "end": number, "hook": "short on-screen hook text, max 12 words, in the tone of
the clip, must satisfy the on-screen text requirements from the rules if any", "reason": "why this
works (emotion, curiosity gap, specific payoff...) AND why it's compliant, one sentence", "score":
number between 0 and 1}}
"""



# Roughly 4 characters per token; keep each request well under a typical
# free-tier per-minute budget so there is room for the prompt and answer.
MAX_TRANSCRIPT_CHARS = 12000


def _chunk_transcript(transcript: list[dict], max_chars: int) -> list[list[dict]]:
    """Splits a transcript into consecutive windows small enough to send in
    one request. Splits only between segments, so no sentence is cut in half
    and every timestamp stays valid."""
    if not transcript:
        return [transcript]
    windows, current, size = [], [], 0
    for seg in transcript:
        seg_len = len(seg.get("text", "")) + 10  # "[123] " plus newline
        if current and size + seg_len > max_chars:
            windows.append(current)
            current, size = [], 0
        current.append(seg)
        size += seg_len
    if current:
        windows.append(current)
    return windows


def select_clips_with_llm(transcript: list[dict], briefing: str, settings: Settings, api_key: Optional[str] = None, rules: Optional[dict] = None, source_context: str = "",
                          people_timeline: Optional[list] = None, known_names: Optional[list] = None) -> list[dict]:
    """Calls an LLM to choose clip-worthy segments. Falls back to a naive
    heuristic (evenly spaced segments) if no API key is configured, so the
    pipeline still produces output during local testing."""
    transcript_text = _transcript_to_text(transcript)
    avoid_line = "- Do not pick silent or audio-only stretches with nothing visually interesting." if settings.avoid_audio_only else ""
    min_dur = 15
    if rules and rules.get("min_duration_seconds"):
        min_dur = min(min_dur, rules["min_duration_seconds"])
    rules_block = f"\nEXTRACTED CAMPAIGN RULES (must be respected):\n{json.dumps(rules)}" if rules else ""
    # The brief's own advice on what works best is the most reliable guide to
    # what that campaign wants, so spell it out instead of leaving it buried
    # in the JSON above.
    tips = [t for key in ("creative_tips", "editing_tips") for t in ((rules or {}).get(key) or [])]
    examples = (rules or {}).get("caption_ideas") or []
    if tips:
        rules_block += ("\n\nCAMPAIGN TIPS FROM THE BRIEF (choose and shape clips to follow these closely; "
                        "they say what works best for this campaign):\n- " + "\n- ".join(tips))
    if examples:
        rules_block += ("\n\nEXAMPLE HOOKS/CAPTIONS FROM THE BRIEF (inspiration for tone and angle only; "
                        "never copy them literally, write a new hook that fits the chosen fragment):\n- "
                        + "\n- ".join(examples))
    lang_names = {"nl": "Dutch", "en": "English", "de": "German", "fr": "French", "es": "Spanish"}
    lang_code = ((rules or {}).get("language_code") or settings.output_language or "nl").lower()
    system = LLM_SYSTEM_PROMPT.format(
        min_dur=min_dur, max_dur=settings.max_clip_duration,
        pref_min=settings.preferred_min, pref_max=settings.preferred_max,
        min_clips=settings.min_clips, max_clips=settings.max_clips,
        avoid_audio_only=avoid_line, rules_block=rules_block,
        out_lang=lang_names.get(lang_code, lang_code),
    )
    ctx_block = ""
    if source_context:
        ctx_block = ("SOURCE VIDEO (public title/channel/description of the video these clips come from; "
                     "it tells you who speaks and why this video is interesting):\n"
                     f"{source_context}\n\n")
    if known_names:
        ctx_block += ("PEOPLE IN THIS VIDEO (names from the user or the video description). Use ONLY these "
                      "names for people; if you are not sure who is who in a fragment, describe it without "
                      "a name instead of guessing:\n" + ", ".join(known_names) + "\n\n")

    def _screen_block(start, end):
        t = people.timeline_text(people_timeline or [], start, end)
        return (("WHO IS ON SCREEN (face recognition, [seconds-seconds] names; people not listed here "
                 "are not recognised, never guess their name):\n" + t + "\n\n") if t else "")

    user = (f"{ctx_block}{_screen_block(0, 10**9)}"
            f"CAMPAIGN BRIEFING:\n{briefing}\n\nTRANSCRIPT:\n{transcript_text}")

    # A full hour of speech is ~30k tokens, far past the per-minute token
    # budget of a free API tier (Groq's is 8k), so sending the whole
    # transcript in one request simply fails and the app silently drops to
    # the dumb fallback. Splitting it into windows keeps every request small
    # and lets the model actually read all of the material.
    # Chunk the merged transcript, not the raw one: after merging, the same
    # material needs far fewer windows, and fewer windows means fewer requests.
    windows = _chunk_transcript(_merge_short_segments(transcript), MAX_TRANSCRIPT_CHARS)
    per_window = max(2, -(-settings.max_clips // max(1, len(windows))) + 1)
    if len(windows) > 1:
        print(f"[ClipNova] Transcript opgesplitst in {len(windows)} delen "
              f"(te groot voor één aanvraag).", flush=True)

    def _one_window(item):
        idx, window = item
        w_system = system.replace(
            f"Pick between {settings.min_clips} and {settings.max_clips} clips total.",
            f"Pick up to {per_window} clips from this part of the video.",
        )
        try:
            w_start = float(window[0]["start"]); w_end = float(window[-1].get("end", window[-1]["start"]))
        except Exception:
            w_start, w_end = 0.0, 10**9
        w_user = (f"{ctx_block}{_screen_block(w_start, w_end)}"
                  f"CAMPAIGN BRIEFING:\n{briefing}\n\nTRANSCRIPT:\n{_transcript_to_text(window)}")
        text = call_llm(w_system, w_user, provider=settings.llm_provider, api_key=api_key)
        if text is None:
            return []
        try:
            part = _parse_json_block(text)
            return part if isinstance(part, list) else []
        except Exception as e:
            print(f"[ClipNova] Deel {idx + 1} onleesbaar ({type(e).__name__}) — overgeslagen.", flush=True)
            return []

    # The windows do not depend on each other, so they can go out together.
    # Sending them one at a time meant waiting out every round trip in series,
    # which is most of the wall clock on a long video. The pool stays small so
    # a free API tier's per-minute budget is not blown in one burst.
    collected = []
    if len(windows) == 1:
        collected = _one_window((0, windows[0]))
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(3, len(windows))) as pool:
            for part in pool.map(_one_window, list(enumerate(windows))):
                collected.extend(part)

    if not collected:
        print("[ClipNova] Geen bruikbaar AI-antwoord — heuristische fallback.", flush=True)
        return _heuristic_clips(transcript, settings)
    return collected


_FILLER_START = {
    "nl": ("ja", "nou", "dus", "hoi", "hallo", "welkom", "oké", "oke", "okay", "eh", "uh", "ehm", "kijk", "zeg maar"),
    "en": ("so", "um", "uh", "well", "okay", "ok", "hi", "hello", "welcome", "like", "you know", "yeah"),
}
_PUNCH_WORDS = {
    "nl": ("nooit", "niemand", "altijd", "geheim", "fout", "waarheid", "eerlijk", "gek", "crazy", "serieus",
           "probleem", "bang", "eng", "pijn", "fucking", "verdomd", "schokkend", "onmogelijk", "verloren",
           "gewonnen", "miljoen", "miljard", "duizend", "rijk", "arm", "faillissement", "schuld", "geld",
           "verdien", "omzet", "winst", "leren", "les", "waarom", "hoe", "stop", "belangrijkste", "grootste"),
    "en": ("never", "nobody", "always", "secret", "mistake", "truth", "honestly", "crazy", "seriously",
           "problem", "scared", "pain", "fucking", "shocking", "impossible", "lost", "won", "million",
           "billion", "thousand", "rich", "poor", "bankrupt", "debt", "money", "earn", "revenue",
           "profit", "lesson", "why", "how", "stop", "biggest", "most important"),
}
_NUM_RE = re.compile(
    r"(?:€|\$)?\s?\d[\d.,]*\s?(?:k|m|mln|mld|miljoen|miljard|duizend|procent|percent|%|euro|keer|x|million|billion|thousand)?"
    r"(?:\s?(?:per|p\/|a)\s?(?:maand|jaar|week|dag|month|year|week|day|m|j))?", re.I)


def _lang_key(settings) -> str:
    lang = (getattr(settings, "output_language", "") or "nl").lower()[:2]
    return lang if lang in ("nl", "en") else "nl"


def _score_sentence(text: str, lang: str) -> float:
    low = text.lower()
    score = 0.0
    if _NUM_RE.search(text) and re.search(r"\d", text):
        score += 2.0                      # concrete numbers/amounts hook people
    score += 0.8 * sum(1 for w in _PUNCH_WORDS[lang] if re.search(r"\b" + re.escape(w), low))
    if "?" in text:
        score += 1.0
    if "!" in text:
        score += 0.8
    return score


def _heuristic_hook(text: str, lang: str, idx: int = 0, used: Optional[set] = None) -> str:
    """Template hook without an LLM. Takes the most striking sentence of the
    clip and puts a proven hook pattern around it; plain trimming of the
    first words (the old behaviour) read like a transcript, not a hook.
    Hooks in `used` (lowercase) are skipped, so clips of one run do not all
    get the same text."""
    used = used or set()
    sentences = [x.strip() for x in re.split(r"(?<=[.!?])\s+", " ".join(text.split())) if len(x.strip()) > 8]
    if not sentences:
        return " ".join(text.split())[:60]
    ranked = sorted(sentences, key=lambda x: (-_score_sentence(x, lang), sentences.index(x)))
    num_pats = {
        "nl": ["Dit zegt hij over {n} 😱", "Wat doet hij met {n}? 😱", "{n}… hoe dan? 😱"],
        "en": ["Here is what he says about {n} 😱", "What he does with {n} 😱", "{n}… how? 😱"],
    }[lang]
    text_pats = {
        "nl": ["Dit vertelt niemand je 👀", "Let op: {t}", "{t} 🤯"],
        "en": ["Nobody tells you this 👀", "Pay attention: {t}", "{t} 🤯"],
    }[lang]

    def _rot(pats):
        return pats[idx % len(pats):] + pats[:idx % len(pats)]

    candidates = []
    for sentence in ranked:
        words = sentence.rstrip(".!?…,").split()
        teaser = " ".join(words[:9]) + ("…" if len(words) > 9 else "")
        m = [x.group(0).strip() for x in _NUM_RE.finditer(sentence) if re.search(r"\d", x.group(0))]
        if "?" in sentence:
            candidates.append(teaser.rstrip("…") + "?")
        if m:
            num = max(m, key=len)
            candidates.extend(p.format(n=num) for p in _rot(num_pats))
        candidates.extend(p.format(t=teaser) for p in _rot(text_pats))
    for hook in candidates:
        if hook.lower() not in used:
            return hook
    return candidates[0]


def _heuristic_clips(transcript: list[dict], settings: Settings) -> list[dict]:
    """No-LLM fallback. Scores sliding windows of transcript segments on the
    things that make a clip hook people (numbers, strong words, questions,
    speech energy, a clean start and end), picks the best non-overlapping
    ones and writes a template hook for each. No API key needed."""
    clips = []
    if not transcript:
        return clips
    lang = _lang_key(settings)
    lo, hi = float(settings.preferred_min), float(settings.preferred_max)
    hi = min(hi, float(settings.max_clip_duration))
    fillers = _FILLER_START[lang]
    n = len(transcript)
    seg_scores = [_score_sentence(seg["text"], lang) for seg in transcript]

    cands = []
    for i in range(n):
        first = " ".join(transcript[i]["text"].lower().split())
        # Do not start on greetings/filler; the next segment starts stronger.
        if any(first == f or first.startswith(f + " ") or first.startswith(f + ",") for f in fillers):
            continue
        t0 = float(transcript[i]["start"])
        best = None
        for j in range(i, n):
            dur = float(transcript[j]["end"]) - t0
            if dur > hi:
                break
            if dur < lo:
                continue
            text = " ".join(x["text"] for x in transcript[i:j + 1])
            words = len(text.split())
            energy = words / max(dur, 1.0)           # words per second
            score = sum(seg_scores[i:j + 1]) / max(dur, 1.0) * 12
            score += 1.5 * seg_scores[i]              # strong opening line
            score += min(energy, 3.5) * 0.6           # lively speech beats dead air
            if text.rstrip().endswith((".", "!", "?")):
                score += 1.0                          # ends on a finished sentence
            if best is None or score > best[0]:
                best = (score, j, dur, text)
        if best:
            cands.append((best[0], i, best[1], best[2], best[3]))

    cands.sort(key=lambda c: -c[0])
    used = []
    used_hooks = set()
    top = cands[0][0] if cands else 1.0
    for score, i, j, dur, text in cands:
        a, b = float(transcript[i]["start"]), float(transcript[j]["end"])
        if any(a < ub and b > ua for ua, ub in used):
            continue
        used.append((a, b))
        clips.append({
            "start": a, "end": b,
            "hook": _heuristic_hook(text, lang, len(clips), used_hooks),
            "reason": "Heuristische score (geen AI): cijfers, sterke woorden, tempo",
            "score": round(0.45 + 0.45 * (score / top if top > 0 else 0), 2),
            "ai": False,
        })
        used_hooks.add(clips[-1]["hook"].lower())
        if len(clips) >= settings.max_clips:
            break
    clips.sort(key=lambda c: c["start"])
    return clips[: settings.max_clips]


def _aspect_to_wh(aspect_ratio: str, resolution: str) -> tuple[int, int]:
    if resolution and "x" in resolution:
        w, h = resolution.lower().split("x")
        return int(w), int(h)
    presets = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}
    return presets.get(aspect_ratio, (1080, 1920))


def _analyze_faces(video_path: str, start: float, end: float, samples: int = 6) -> tuple:
    """Samples several frames across the clip and returns the normalized
    x-centres (0-1) of the people found, left to right.

    Looking at a single frame (the old behaviour) failed often: if the person
    happened to look away, lean out of shot, or the stream cut to gameplay at
    that exact second, the crop fell back to the centre of a 16:9 frame and
    the creator ended up outside the 9:16 result -- which breaks the
    "creator must be recognizable" rule the payout depends on. Sampling
    across the clip and clustering the hits is far steadier, and it also
    tells us when there are genuinely two people side by side.
    """
    detect = _face_detector()
    if detect is None:
        return [], []
    cap = cv2.VideoCapture(video_path)
    duration = max(0.5, end - start)
    hits = []
    boxes = []
    for i in range(samples):
        t = start + duration * (i + 0.5) / samples
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        fh_px, fw_px = frame.shape[0], frame.shape[1]
        # Gezichten zoeken op een frame van max 640 px breed is ~5-10x sneller dan
        # op 1080p of 4K en vindt dezelfde gezichten; alle posities zijn genormaliseerd.
        scale = 1.0
        if fw_px > 640:
            scale = 640.0 / fw_px
            frame = cv2.resize(frame, (640, max(1, int(fh_px * scale))), interpolation=cv2.INTER_AREA)
        min_px = max(24, int(48 * scale))
        gh, gw = frame.shape[0], frame.shape[1]
        try:
            found = detect(frame, min_px)
        except Exception as e:
            print(f"[ClipNova] Gezichtsdetectie mislukt ({e}) — midden van het beeld.", flush=True)
            found = []
        for (x, y, w, h) in found:
            hits.append(((x + w / 2) / gw, float(w * h)))
            boxes.append((x / gw, y / gh, w / gw, h / gh))
    cap.release()

    if not hits:
        return [], []

    # Cluster hits that sit close together horizontally: repeated detections
    # of the same person across frames collapse into one position.
    hits.sort(key=lambda p: p[0])
    clusters = [[hits[0]]]
    for pos, area in hits[1:]:
        if pos - clusters[-1][-1][0] < 0.16:
            clusters[-1].append((pos, area))
        else:
            clusters.append([(pos, area)])

    # Keep clusters seen often enough to be a real person, not a stray match.
    min_hits = max(2, samples // 3)
    solid = [c for c in clusters if len(c) >= min_hits] or [max(clusters, key=len)]
    solid.sort(key=lambda c: -sum(a for _p, a in c))
    solid = solid[:2]
    faces = []
    for c in solid:
        cx = sum(p for p, _a in c) / len(c)
        widths = [b[2] for b in boxes if abs((b[0] + b[2] / 2) - cx) < 0.16]
        faces.append({"cx": cx, "w": (sum(widths) / len(widths)) if widths else 0.0})
    faces.sort(key=lambda f: f["cx"])
    return faces, boxes




_DETECTOR = None


def _face_detector():
    """Geeft detect(frame, min_px) -> [(x, y, w, h)] terug, of None.

    OpenCV 4 heeft de snelle Haar-cascade. OpenCV 5 heeft die niet meer; dan
    gebruiken we YuNet (het model van de gezichtsherkenning) als dat er is.
    Zonder beide werkt alles door, alleen zonder gezicht volgen."""
    global _DETECTOR
    if _DETECTOR is not None:
        return _DETECTOR or None
    cascade = None
    try:
        xml = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        if os.path.exists(xml):
            cascade = cv2.CascadeClassifier(xml)
            if cascade.empty():
                cascade = None
    except Exception:
        cascade = None
    if cascade is not None:

        def _haar(frame, min_px):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            return [tuple(r) for r in cascade.detectMultiScale(gray, 1.1, 5, minSize=(min_px, min_px))]
        _DETECTOR = _haar
    elif people.available() and hasattr(cv2, "FaceDetectorYN"):
        yunet = cv2.FaceDetectorYN.create(str(people.YUNET), "", (320, 320), 0.8, 0.3, 20)
        lock = threading.Lock()

        def _yunet(frame, min_px):
            with lock:
                yunet.setInputSize((frame.shape[1], frame.shape[0]))
                _, rows = yunet.detect(frame)
            return [] if rows is None else [tuple(int(v) for v in r[:4]) for r in rows if r[2] >= min_px]
        _DETECTOR = _yunet
    else:
        print("[ClipNova] Geen gezichtsdetectie beschikbaar — clips worden in het midden uitgesneden.", flush=True)
        _DETECTOR = False
    return _DETECTOR or None


def _video_size(path: str) -> Optional[tuple]:
    """Reads the source video's pixel dimensions via ffprobe."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        w, h = r.stdout.strip().split("x")[:2]
        return int(w), int(h)
    except Exception:
        return None


def _webcam_box(boxes: list) -> Optional[tuple]:
    """Given face boxes sampled across a clip, decide whether this looks like a
    reaction stream: one small webcam inset while the rest of the frame shows
    whatever the streamer is watching.

    The give-away is size. A face that fills a decent part of the frame means
    the camera is the shot. A face only a fraction of the frame wide, showing
    up in roughly the same spot every time, is a webcam overlay sitting on top
    of shared screen content -- and for that footage a single 9:16 crop has to
    choose between the streamer and the clip he is reacting to, when the
    campaign needs both.
    """
    if not boxes:
        return None
    small = [b for b in boxes if b[2] < 0.22]
    if len(small) < max(2, len(boxes) // 2):
        return None
    n = len(small)
    fx = sum(b[0] for b in small) / n
    fy = sum(b[1] for b in small) / n
    fw = sum(b[2] for b in small) / n
    fh = sum(b[3] for b in small) / n
    # Position must be stable; a face wandering around the frame is a person
    # moving in shot, not a fixed overlay.
    if max(abs(b[0] - fx) for b in small) > 0.12:
        return None
    return (fx, fy, fw, fh)



_HOOK_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _hook_font() -> str:
    """First available bold italic font (falls back to plain bold)."""
    for path in _HOOK_FONTS:
        if os.path.exists(path):
            return path
    return _HOOK_FONTS[-1]


def _hook_for_overlay(text: str) -> str:
    """Clean hook text for ffmpeg drawtext. The fonts have no colour emoji,
    so '!' emoji become a plain '!' and other emoji are dropped (the emoji
    stays in the caption instead)."""
    text = " ".join(str(text or "").split())
    text = text.replace("\u2757", "!").replace("\u2755", "!").replace("\u203c", "!")
    text = "".join(ch for ch in text if ord(ch) < 0x2190)
    text = re.sub(r"\s+([!?.,])", r"\1", text).strip()
    return text[:80]


_EMOJI_FONTS = ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
                "/usr/share/fonts/noto/NotoColorEmoji.ttf"]


def _is_emoji(ch: str) -> bool:
    o = ord(ch)
    return (0x1F000 <= o <= 0x1FAFF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF
            or o in (0x203C, 0x2049, 0x2190, 0x2B50, 0x2764, 0x00A9, 0x00AE))


def _hook_tokens(text: str) -> list:
    """Splits a hook into ('t', text) and ('e', emoji) pieces. Variation
    selectors and joiners stay with the emoji they belong to."""
    out = []
    for ch in text:
        if ch in ("\ufe0f", "\u200d"):
            continue
        if _is_emoji(ch):
            out.append(("e", ch))
        elif out and out[-1][0] == "t":
            out[-1] = ("t", out[-1][1] + ch)
        else:
            out.append(("t", ch))
    return out


HOOK_SECONDS = 3   # zo lang blijft de hooktekst in beeld

# ---------------------------------------------------------------------------
# Lettertype (TikTok Sans) en emoji
# ---------------------------------------------------------------------------
_APP_ROOT = Path(__file__).resolve().parent.parent
FONTS_DIR = Path(os.environ.get("CLIPNOVA_FONTS_DIR", str(_APP_ROOT / "assets" / "fonts")))

_BOX_FONTS = [
    str(FONTS_DIR / "TikTokSans-Bold.ttf"),
    "/usr/share/fonts/truetype/tiktoksans/TikTokSans-Bold.ttf",
    "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
    "/usr/share/fonts/truetype/inter/Inter-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _hook_box_font(preferred: str = "") -> Optional[str]:
    """TikTok Sans Bold, anders een goed leesbaar alternatief."""
    import glob
    for path in [preferred, os.environ.get("CLIPPARTY_FONT", "")] + _BOX_FONTS:
        if path and os.path.exists(path):
            return path
    for pattern in ("/usr/share/fonts/**/Inter*Bold*", "/usr/share/fonts/**/*Bold.ttf"):
        found = sorted(glob.glob(pattern, recursive=True))
        if found:
            return found[0]
    return None


# Emoji: eerst een eigen map met PNG's (CLIPNOVA_EMOJI_DIR, bestandsnaam = hex
# codepoint, bijv. 1f62d.png), dan de Apple-set via jsDelivr, en als laatste
# Noto Color Emoji (open licentie, staat in de Docker-image).
_EMOJI_DIR = os.environ.get("CLIPNOVA_EMOJI_DIR", "")
_EMOJI_CACHE = Path(os.environ.get("CLIPNOVA_EMOJI_CACHE", "/tmp/clipnova_emoji"))
_EMOJI_CDN = os.environ.get("CLIPNOVA_EMOJI_CDN", "1") != "0"


def _emoji_hex(emoji_str: str) -> str:
    return "-".join(f"{ord(ch):x}" for ch in emoji_str if ch not in ("️", "‍"))


def _noto_emoji(emoji_str: str, target_h: int):
    from PIL import Image, ImageDraw, ImageFont
    for path in _EMOJI_FONTS:
        if not os.path.exists(path):
            continue
        try:
            font = ImageFont.truetype(path, 109)       # Noto Color Emoji kent alleen 109 px
            im = Image.new("RGBA", (136, 128), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((0, 0), emoji_str, font=font, embedded_color=True)
            box = im.getbbox()
            if not box:
                continue
            im = im.crop(box)
            r = target_h / max(im.height, 1)
            return im.resize((max(1, int(im.width * r)), target_h), Image.LANCZOS)
        except Exception:
            continue
    return None


def _get_apple_emoji_img(emoji_str: str, target_h: int):
    """Emoji als plaatje op de gevraagde hoogte (Apple-look waar mogelijk)."""
    try:
        from PIL import Image
        hex_code = _emoji_hex(emoji_str)
        candidates = []
        if _EMOJI_DIR:
            candidates.append(Path(_EMOJI_DIR) / f"{hex_code}.png")
        cached = _EMOJI_CACHE / f"{hex_code}.png"
        candidates.append(cached)
        found = next((c for c in candidates if c.exists()), None)
        if found is None and _EMOJI_CDN:
            _EMOJI_CACHE.mkdir(parents=True, exist_ok=True)
            for url in (f"https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/{hex_code}.png",
                        f"https://cdn.jsdelivr.net/npm/emoji-datasource-apple@5.0.1/img/apple/64/{hex_code}.png"):
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                    with urllib.request.urlopen(req, timeout=4) as resp:
                        data = resp.read()
                    if data[:4] == b"\x89PNG":
                        cached.write_bytes(data)
                        found = cached
                        break
                except Exception:
                    pass
        if found is not None:
            im = Image.open(found).convert("RGBA")
            r = target_h / max(im.height, 1)
            return im.resize((max(1, int(im.width * r)), target_h), Image.LANCZOS)
    except Exception as e:
        print(f"[ClipNova] Emoji laden mislukt: {e}", flush=True)
    return _noto_emoji(emoji_str, target_h)


def _hex_rgba(value: str, default=(255, 255, 255), alpha: int = 255) -> tuple:
    v = str(value or "").strip().lstrip("#")
    if len(v) == 3:
        v = "".join(c * 2 for c in v)
    try:
        return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16), alpha)
    except (ValueError, IndexError):
        return (*default, alpha)


# Hookstijlen: (balkkleur, tekstkleur, randkleur of None). "merk" gebruikt de
# kleuren uit het eigen merk.
HOOK_STYLES = {
    "tiktok":  {"label": "TikTok (wit)",   "box": "#FFFFFF", "text": "#000000", "stroke": None},
    "zwart":   {"label": "Zwart",          "box": "#000000", "text": "#FFFFFF", "stroke": None},
    "merk":    {"label": "Merkkleur",      "box": None,      "text": None,      "stroke": None},
    "omlijnd": {"label": "Omlijnd",        "box": None,      "text": "#FFFFFF", "stroke": "#000000"},
    "geel":    {"label": "Geel omlijnd",   "box": None,      "text": "#FFE500", "stroke": "#000000"},
}


def _render_hook_png(text: str, w: int, h: int, out_png: str, style: str = "tiktok",
                     position: str = "boven", brand_color: str = "#7C5CFF",
                     brand_text_color: str = "#FFFFFF", font_path: str = "") -> Optional[str]:
    """Tekent de hooktekst als doorzichtige PNG van w x h: afgeronde balken die
    tegen elkaar aan liggen (zoals de tekstbalken op TikTok) of omlijnde tekst,
    in TikTok Sans met kleuren-emoji."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        text = " ".join(str(text or "").split())
        if len(text) > 100:
            text = text[:100].rsplit(" ", 1)[0]
        font_file = _hook_box_font(font_path)
        if not text or not font_file:
            return None
        st = HOOK_STYLES.get(style) or HOOK_STYLES["tiktok"]
        if style == "merk":
            box_rgba = _hex_rgba(brand_color, (124, 92, 255))
            text_rgba = _hex_rgba(brand_text_color, (255, 255, 255))
            stroke_rgba = None
        else:
            box_rgba = _hex_rgba(st["box"]) if st["box"] else None
            text_rgba = _hex_rgba(st["text"], (0, 0, 0))
            stroke_rgba = _hex_rgba(st["stroke"]) if st["stroke"] else None

        fs = max(24, int(w * (0.056 if box_rgba else 0.064)))
        font = ImageFont.truetype(font_file, fs)
        stroke_w = max(2, fs // 9) if stroke_rgba else 0
        e_px = int(fs * 1.15)
        e_gap = fs * 0.12
        space = font.getlength(" ")
        pad_x = fs * 0.75 if box_rgba else stroke_w

        words = []
        for raw in text.split(" "):
            pieces, width = [], 0.0
            for kind, val in _hook_tokens(raw):
                if kind == "e":
                    g = _get_apple_emoji_img(val, e_px)
                    if g:
                        pieces.append(("e", g))
                        width += g.width + e_gap
                else:
                    pieces.append(("t", val))
                    width += font.getlength(val)
            if pieces:
                words.append((pieces, width))
        if not words:
            return None

        max_line_w = w * 0.84
        lines, cur, cur_w = [], [], 0.0
        for pieces, wl in words:
            add = (space if cur else 0.0) + wl
            if cur and cur_w + add > max_line_w:
                lines.append((cur, cur_w))
                cur, cur_w = [pieces], wl
            else:
                cur.append(pieces)
                cur_w += add
        if cur:
            lines.append((cur, cur_w))
        lines = lines[:4]

        box_h = fs * 1.65
        radius = box_h * 0.35
        pitch = box_h * (0.98 if box_rgba else 1.0)   # balken raken elkaar, zoals op TikTok
        total_h = box_h + (len(lines) - 1) * pitch
        top_y = int(h * 0.12) if position != "midden" else int((h - total_h) / 2)

        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(canvas)
        for i, (l_words, l_w) in enumerate(lines):
            bw = int(l_w + 2 * pad_x)
            bx = int((w - bw) / 2)
            by = int(top_y + i * pitch)
            if box_rgba:
                d.rounded_rectangle((bx, by, bx + bw, by + box_h), radius=radius, fill=box_rgba)
            y_mid = by + box_h / 2
            x = bx + pad_x
            for w_idx, pieces in enumerate(l_words):
                if w_idx:
                    x += space
                for kind, val in pieces:
                    if kind == "t":
                        d.text((x, y_mid), val, font=font, fill=text_rgba, anchor="lm",
                               stroke_width=stroke_w, stroke_fill=stroke_rgba)
                        x += font.getlength(val)
                    else:
                        canvas.paste(val, (int(x), int(y_mid - val.height / 2)), val)
                        x += val.width + e_gap
        canvas.save(out_png, "PNG")
        return out_png
    except Exception as e:
        print(f"[ClipNova] _render_hook_png mislukt ({e})", flush=True)
        return None


def _render_brand_png(w: int, h: int, out_png: str, logo_path: str = "",
                      watermark: str = "", font_path: str = "") -> Optional[str]:
    """Logo rechtsboven en/of @naam onderin, als doorzichtige laag over de hele clip."""
    if not (logo_path and os.path.exists(logo_path)) and not watermark.strip():
        return None
    try:
        from PIL import Image, ImageDraw, ImageFont
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        if logo_path and os.path.exists(logo_path):
            logo = Image.open(logo_path).convert("RGBA")
            lw = int(w * 0.16)
            logo = logo.resize((lw, max(1, int(logo.height * lw / max(logo.width, 1)))), Image.LANCZOS)
            alpha = logo.getchannel("A").point(lambda a: int(a * 0.9))
            logo.putalpha(alpha)
            margin = int(w * 0.04)
            canvas.paste(logo, (w - lw - margin, int(h * 0.045)), logo)
        if watermark.strip():
            font_file = _hook_box_font(font_path)
            if font_file:
                fs = max(18, int(w * 0.03))
                font = ImageFont.truetype(font_file, fs)
                d = ImageDraw.Draw(canvas)
                d.text((w / 2, h * 0.93), watermark.strip()[:40], font=font, anchor="mm",
                       fill=(255, 255, 255, 190), stroke_width=max(1, fs // 12), stroke_fill=(0, 0, 0, 150))
        canvas.save(out_png, "PNG")
        return out_png
    except Exception as e:
        print(f"[ClipNova] Logo/watermerk tekenen mislukt ({e})", flush=True)
        return None


# ---------------------------------------------------------------------------
# Knippen
# ---------------------------------------------------------------------------
_FFMPEG_THREADS = max(1, (os.cpu_count() or 4) // 2)


def _ff_path(path: str) -> str:
    """Pad veilig binnen een ffmpeg-filter."""
    return str(path).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def _finish_chain(chain: str, extras: list) -> str:
    """Sluit een filtergraaf af met de overlays: [vb] -> [v].

    extras: lijst van ("filter", tekst) of ("png", invoer-index, enable_tot)."""
    label = "vb0"
    chain += f"[{label}]"
    n = 0
    for item in extras:
        n += 1
        nxt = f"vb{n}"
        if item[0] == "filter":
            chain += f";[{label}]{item[1]}[{nxt}]"
        else:
            _, idx, until = item
            enable = f":enable='between(t,0,{until})'" if until else ""
            chain += f";[{label}][{idx}:v]overlay=0:0:format=auto{enable}[{nxt}]"
        label = nxt
    return chain + f";[{label}]format=yuv420p[v]"


def cut_clip(video_path: str, start: float, end: float, out_path: str, settings: "Settings",
             hook_text: str = "", full_transcript: Optional[list] = None) -> bool:
    """Knipt, maakt staand, brandt ondertitels/hooktekst/logo in en codeert één
    clip. Geeft terug of er een gezicht in beeld was (voor de regelcontrole
    "maker herkenbaar")."""
    target_w, target_h = _aspect_to_wh(settings.aspect_ratio, settings.resolution)
    target_w, target_h = target_w // 2 * 2, target_h // 2 * 2
    duration = max(0.5, end - start)
    faces, boxes = _analyze_faces(video_path, start, end)
    face_detected = len(faces) > 0
    webcam = _webcam_box(boxes) if (settings.reaction_layout and settings.face_priority) else None
    portrait = target_h > target_w
    two_people = (len(faces) >= 2 and faces[-1]["cx"] - faces[0]["cx"] > 0.3
                  and min(f["w"] for f in faces) > 0.06)
    reaction = bool(webcam) and portrait
    stack = (settings.stack_faces and settings.face_priority and two_people and portrait and not reaction)

    fmt = str(getattr(settings, "video_format", "auto") or "auto").lower()
    blur = False
    if fmt == "standaard":
        reaction = stack = False
    elif fmt == "twee":
        reaction = False
        stack = portrait
        if stack and not two_people:
            faces = [{"cx": 0.27, "w": 0}, {"cx": 0.73, "w": 0}]
    elif fmt == "blur":
        reaction = stack = False
        blur = True

    # ---- Lagen: ondertitels, hooktekst, logo ----
    extras = []
    inputs = []
    if settings.subtitles and full_transcript:
        ass = _write_ass_for_range(full_transcript, start, end, out_path, target_w, target_h,
                                   active_color=getattr(settings, "subtitle_color", "#FFE500"),
                                   font_path=getattr(settings, "font_path", ""))
        if ass:
            extras.append(("filter", f"ass='{_ff_path(ass)}':fontsdir='{_ff_path(FONTS_DIR)}'"))
        else:
            srt = _write_srt_for_range(full_transcript, start, end, out_path)
            if srt:
                extras.append(("filter", f"subtitles='{_ff_path(srt)}':fontsdir='{_ff_path(FONTS_DIR)}':force_style="
                                         "'FontName=TikTok Sans,Fontsize=11,Bold=1,PrimaryColour=&H00FFFFFF,"
                                         "OutlineColour=&H00000000,Outline=2,Shadow=0,Alignment=2,MarginV=60'"))
    hook_png = None
    if settings.hook and hook_text:
        hook_png = _render_hook_png(
            hook_text, target_w, target_h, str(Path(out_path).with_suffix(".hook.png")),
            style=getattr(settings, "hook_style", "tiktok"), position=getattr(settings, "hook_position", "boven"),
            brand_color=getattr(settings, "brand_color", "#7C5CFF"),
            brand_text_color=getattr(settings, "brand_text_color", "#FFFFFF"),
            font_path=getattr(settings, "font_path", ""))
        if hook_png:
            inputs.append(hook_png)
            extras.append(("png", len(inputs), HOOK_SECONDS))
        else:
            text_path = str(Path(out_path).with_suffix(".hook.txt"))
            with open(text_path, "w", encoding="utf-8") as f:
                f.write("\n".join(textwrap.wrap(_hook_for_overlay(hook_text), width=17)[:4]))
            extras.append(("filter",
                           f"drawtext=fontfile='{_ff_path(_hook_box_font() or _hook_font())}':textfile='{_ff_path(text_path)}'"
                           ":expansion=none:fontsize=h/26:fontcolor=white:borderw=4:bordercolor=black"
                           f":line_spacing=8:x=(w-text_w)/2:y=h*0.14:enable='between(t,0,{HOOK_SECONDS})'"))
    brand_png = _render_brand_png(target_w, target_h, str(Path(out_path).with_suffix(".brand.png")),
                                  logo_path=getattr(settings, "logo_path", ""),
                                  watermark=getattr(settings, "watermark", ""),
                                  font_path=getattr(settings, "font_path", ""))
    if brand_png:
        inputs.append(brand_png)
        extras.append(("png", len(inputs), None))

    # ---- Beeldindeling ----
    if blur:
        bw = max(2, target_w // 4) // 2 * 2
        bh = max(2, target_h // 4) // 2 * 2
        chain = (f"[0:v]split=2[bgsrc][fgsrc];"
                 f"[bgsrc]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},"
                 f"boxblur=10:2,eq=brightness=-0.10,scale={target_w}:{target_h},setsar=1[bg];"
                 f"[fgsrc]scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
                 f"scale='trunc(iw/2)*2':'trunc(ih/2)*2',setsar=1[fg];"
                 f"[bg][fg]overlay='(W-w)/2':'(H-h)/2'")
    elif reaction:
        top_h = (target_h // 2) // 2 * 2
        bot_h = target_h - top_h
        fx, fy, fw, fh = webcam
        cx, cy = fx + fw / 2, min(0.95, fy + fh / 2 + fh * 0.15)
        zoom = 2.8
        ch = f"min(ih,min(iw,{fw * zoom:.4f}*iw)*{bot_h}/{target_w})"
        cw = f"({ch})*{target_w}/{bot_h}"
        x = f"max(0,min(iw-({cw}),{cx:.4f}*iw-({cw})/2))"
        y = f"max(0,min(ih-({ch}),{cy:.4f}*ih-({ch})/2))"
        # Het scherm boven, zonder de webcam: snij de kant weg waar die zit.
        margin = 0.01
        losses = {"right": 1 - max(0, fx - margin), "left": min(1, fx + fw + margin),
                  "bottom": 1 - max(0, fy - margin), "top": min(1, fy + fh + margin)}
        side = min(losses, key=losses.get)
        if losses[side] > 0.45:
            top_src = "[0:v]"
        elif side == "right":
            top_src = f"[0:v]crop='iw*{max(0.05, fx - margin):.4f}':ih:0:0,"
        elif side == "left":
            keep = 1 - min(0.95, fx + fw + margin)
            top_src = f"[0:v]crop='iw*{keep:.4f}':ih:'iw*{1 - keep:.4f}':0,"
        elif side == "bottom":
            top_src = f"[0:v]crop=iw:'ih*{max(0.05, fy - margin):.4f}':0:0,"
        else:
            keep = 1 - min(0.95, fy + fh + margin)
            top_src = f"[0:v]crop=iw:'ih*{keep:.4f}':0:'ih*{1 - keep:.4f}',"
        if top_src == "[0:v]":
            top_src = "[0:v]null,"
        chain = (f"[0:v]split=2[rs0][rs1];"
                 f"{top_src.replace('[0:v]', '[rs0]', 1)}scale={target_w}:{top_h}:force_original_aspect_ratio=increase,"
                 f"crop={target_w}:{top_h},setsar=1[top];"
                 f"[rs1]crop='{cw}':'{ch}':'{x}':'{y}',scale={target_w}:{bot_h},setsar=1[bot];"
                 f"[top][bot]vstack=inputs=2")
    elif stack:
        half_h = (target_h // 2) // 2 * 2
        cw = f"min(iw,ih*{target_w}/{half_h})"
        ch = f"min(ih,iw*{half_h}/{target_w})"
        panes = [f"[0:v]split=2[s0][s1]"]
        for idx, cx in enumerate((faces[0]["cx"], faces[-1]["cx"])):
            panes.append(f"[s{idx}]crop='{cw}':'{ch}':'max(0,min(iw-{cw},iw*{cx:.4f}-{cw}/2))':'(ih-{ch})/2',"
                         f"scale={target_w}:{half_h},setsar=1[p{idx}]")
        chain = ";".join(panes) + f";[p0][p1]vstack=inputs=2,scale={target_w}:{target_h}"
    else:
        cx = faces[0]["cx"] if (faces and settings.face_priority) else 0.5
        if faces and settings.face_priority and len(faces) > 1:
            cx = sum(f["cx"] for f in faces) / len(faces)
        cw = f"min(iw,ih*{target_w}/{target_h})"
        ch = f"min(ih,iw*{target_h}/{target_w})"
        chain = (f"[0:v]crop='{cw}':'{ch}':'max(0,min(iw-{cw},iw*{cx:.4f}-{cw}/2))':'(ih-{ch})/2',"
                 f"scale={target_w}:{target_h},setsar=1")

    chain = _finish_chain(chain, extras)
    quality = (["-crf", "20", "-preset", "veryfast"] if settings.highest_quality
               else ["-crf", "23", "-preset", "superfast"])
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", video_path]
    for png in inputs:
        cmd += ["-i", png]
    cmd += ["-t", f"{duration:.3f}", "-filter_complex", chain, "-map", "[v]", "-map", "0:a?",
            "-threads", str(_FFMPEG_THREADS), "-filter_threads", str(_FFMPEG_THREADS),
            "-c:v", "libx264", *quality, "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out_path]
    run(cmd)
    for leftover in (".hook.png", ".brand.png", ".hook.txt"):
        try:
            Path(out_path).with_suffix(leftover).unlink(missing_ok=True)
        except OSError:
            pass
    if not Path(out_path).exists() or Path(out_path).stat().st_size < 1000:
        raise RuntimeError("ffmpeg leverde geen bruikbare clip op")
    return face_detected


def _cut_plain(video_path: str, start: float, end: float, out_path: str, settings: "Settings") -> bool:
    """Noodweg: alleen knippen en staand uitsnijden, zonder lagen."""
    w, h = _aspect_to_wh(settings.aspect_ratio, settings.resolution)
    w, h = w // 2 * 2, h // 2 * 2
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", video_path,
           "-t", f"{max(0.5, end - start):.3f}",
           "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path]
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        print(f"[ClipNova] Ook eenvoudig knippen mislukte: {(r.stderr or '')[-300:]}", flush=True)
        return False
    return Path(out_path).exists() and Path(out_path).stat().st_size > 20000


# ---------------------------------------------------------------------------
# Ondertitels
# ---------------------------------------------------------------------------
_SUB_WHITE = "&H00FFFFFF"
_SUB_NUMBER = "&H0084DC3D"   # groen voor getallen en bedragen
_NUM_RE = re.compile(r"(\d|€|\$|%)")


def _ass_color(hex_value: str, default: str = "&H0000E5FF") -> str:
    v = str(hex_value or "").strip().lstrip("#")
    if len(v) != 6:
        return default
    try:
        int(v, 16)
    except ValueError:
        return default
    return f"&H00{v[4:6]}{v[2:4]}{v[0:2]}".upper()   # ASS is BBGGRR


def _srt_ts(t: float) -> str:
    t = max(0.0, t)
    h, m, s = int(t // 3600), int((t % 3600) // 60), int(t % 60)
    ms = int(round((t - int(t)) * 1000)) % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ass_ts(t: float) -> str:
    cs = int(round(max(0.0, t) * 100))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    sec, cs = divmod(rem, 100)
    return f"{h:d}:{m:02d}:{sec:02d}.{cs:02d}"


def _segment_words(seg: dict) -> list:
    """[(woord, start, einde)]. Echte woordtijden als die er zijn, anders wordt
    de tijd van het segment naar woordlengte verdeeld."""
    if seg.get("words"):
        out = []
        for w in seg["words"]:
            word = str(w.get("word", "")).strip()
            if word:
                out.append((word, float(w.get("start", seg["start"])), float(w.get("end", seg["end"]))))
        if out:
            return out
    words = str(seg.get("text", "")).split()
    if not words:
        return []
    s0, s1 = float(seg["start"]), float(seg["end"])
    weights = [len(w) + 2 for w in words]
    total = sum(weights)
    out, t = [], s0
    for word, wt in zip(words, weights):
        dur = (s1 - s0) * wt / total
        out.append((word, t, t + dur))
        t += dur
    return out


def _chunk_words(words: list, max_words: int = 3, max_chars: int = 18) -> list:
    """Korte regels van hooguit 3 woorden; een regel eindigt na een leesteken of pauze."""
    chunks, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        text = " ".join(x[0] for x in cur)
        nxt = words[i + 1] if i + 1 < len(words) else None
        gap = (nxt[1] - w[2]) if nxt else 0.0
        if (len(cur) >= max_words or len(text) >= max_chars
                or w[0].endswith((".", "!", "?", ",", ":", ";")) or gap > 0.5):
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    return chunks


def _ass_escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def _words_in_range(full_transcript: list, start: float, end: float) -> list:
    words = []
    for seg in full_transcript or []:
        if seg.get("end", 0) < start or seg.get("start", 0) > end:
            continue
        for word, ws, we in _segment_words(seg):
            if we <= start or ws >= end:
                continue
            words.append((word, max(0.0, ws - start), min(end - start, we - start)))
    return words


def _write_srt_for_range(full_transcript: list, start: float, end: float, clip_path: str) -> Optional[str]:
    """Blokondertitels voor dit stuk, uit het transcript van de hele video."""
    lines = []
    for seg in full_transcript or []:
        if seg.get("end", 0) < start or seg.get("start", 0) > end:
            continue
        s = max(0.0, seg["start"] - start)
        e = min(end - start, seg["end"] - start)
        if e - s < 0.2 or not str(seg.get("text", "")).strip():
            continue
        lines.append(f"{len(lines) + 1}\n{_srt_ts(s)} --> {_srt_ts(e)}\n{seg['text'].strip()}\n")
    if not lines:
        return None
    path = str(Path(clip_path).with_suffix(".srt"))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path


def _write_ass_for_range(full_transcript: list, start: float, end: float, clip_path: str,
                         w: int, h: int, active_color: str = "#FFE500", font_path: str = "") -> Optional[str]:
    """Woord-voor-woord ondertitels: de korte regel staat in beeld en het woord
    dat nu klinkt krijgt de accentkleur en wordt iets groter."""
    try:
        words = _words_in_range(full_transcript, start, end)
        if not words:
            return None
        active = _ass_color(active_color)
        font_name = "TikTok Sans" if not font_path else Path(font_path).stem.split("-")[0]
        size = max(36, int(w * 0.062))
        margin_v = int(h * 0.2)
        events = []
        chunks = _chunk_words(words)
        for ci, chunk in enumerate(chunks):
            chunk_end = chunk[-1][2]
            nxt_start = chunks[ci + 1][0][1] if ci + 1 < len(chunks) else None
            if nxt_start is not None and 0 < nxt_start - chunk_end < 0.4:
                chunk_end = nxt_start          # geen flits tussen twee regels
            chunk_end = max(chunk_end, chunk[0][1] + 0.2)
            for i, (word, ws, we) in enumerate(chunk):
                ev_start = ws
                ev_end = chunk[i + 1][1] if i + 1 < len(chunk) else chunk_end
                if ev_end - ev_start < 0.04:
                    continue
                parts = []
                for j, (other, _s, _e) in enumerate(chunk):
                    o = _ass_escape(other)
                    color = _SUB_NUMBER if _NUM_RE.search(other) else _SUB_WHITE
                    if j == i:
                        parts.append(f"{{\\c{active}\\fscx112\\fscy112}}{o}{{\\r}}")
                    else:
                        parts.append(f"{{\\c{color}}}{o}{{\\r}}" if color != _SUB_WHITE else o)
                events.append(f"Dialogue: 0,{_ass_ts(ev_start)},{_ass_ts(ev_end)},Sub,,0,0,0,,{' '.join(parts)}")
        if not events:
            return None
        header = (
            "[Script Info]\nScriptType: v4.00+\n"
            f"PlayResX: {w}\nPlayResY: {h}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
            "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
            "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
            f"Style: Sub,{font_name},{size},{_SUB_WHITE},{_SUB_WHITE},&H00000000,&H80000000,"
            f"1,0,0,0,100,100,0,0,1,{max(3, size // 12)},2,2,60,60,{margin_v},1\n\n"
            "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
        path = str(Path(clip_path).with_suffix(".ass"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(header + "\n".join(events) + "\n")
        return path
    except Exception as e:
        print(f"[ClipNova] Woord-ondertitels mislukt ({type(e).__name__}: {e}) -- gebruik blokondertitels.", flush=True)
        return None


# ---------------------------------------------------------------------------
# Bronvideo downloaden (YouTube/Twitch via yt-dlp, of een directe bestandslink)
# ---------------------------------------------------------------------------
_DIRECT_FILE_HOSTS = ("dropbox.com", "dropboxusercontent.com", "drive.google.com", "docs.google.com",
                      "onedrive.live.com", "1drv.ms", "wetransfer.com", "amazonaws.com",
                      "cloudfront.net", "storage.googleapis.com", "cdn.")
_VIDEO_SUFFIXES = (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".flv", ".ts")
_SOURCE_CONTEXT: dict = {}
_YTDLP_UPDATED = False


def _direct_download_url(url: str) -> str:
    """Maakt van een deel-link een link die het bestand zelf geeft."""
    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    if "dropbox.com" in url:
        parts = urlparse(url)
        query = parse_qs(parts.query)
        query["dl"] = ["1"]
        return urlunparse(parts._replace(query=urlencode(query, doseq=True)))
    m = (re.search(r"drive\.google\.com/file/d/([A-Za-z0-9_-]{15,})", url)
         or re.search(r"drive\.google\.com/(?:uc|open)\?(?:[^#]*&)?id=([A-Za-z0-9_-]{15,})", url))
    if m:
        return f"https://drive.usercontent.google.com/download?id={m.group(1)}&export=download&confirm=t"
    return url


def _download_file(url: str, out_dir: str) -> str:
    """Haalt een videobestand op via gewone HTTP(S)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(out).free
    if free < 2_000_000_000:
        raise RuntimeError(f"Nog maar {free // 1_000_000} MB vrij op de schijf. Ruim eerst op.")
    req = urllib.request.Request(_direct_download_url(url), headers={"User-Agent": "Mozilla/5.0 (ClipNova)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "text/html" in ctype:
            raise RuntimeError("Die link geeft een webpagina terug in plaats van een videobestand. "
                               "Download het bestand zelf en upload het.")
        name = ""
        m = re.search(r"filename\*?=(?:UTF-8'')?\"?([^\";]+)", resp.headers.get("Content-Disposition", ""))
        if m:
            name = m.group(1)
        name = Path(name or url.split("?")[0]).name or "bron.mp4"
        if not name.lower().endswith(_VIDEO_SUFFIXES):
            name += ".mp4"
        target = out / f"src_{uuid.uuid4().hex[:8]}_{re.sub(r'[^A-Za-z0-9._-]', '_', name)[-80:]}"
        with open(target, "wb") as f:
            shutil.copyfileobj(resp, f, 1024 * 1024)
    if target.stat().st_size < 100_000:
        target.unlink(missing_ok=True)
        raise RuntimeError("Het gedownloade bestand is te klein om video te zijn.")
    return str(target)


def _format_args(max_height: str = "1080") -> list:
    """yt-dlp-keuze voor de gekozen downloadkwaliteit."""
    q = str(max_height or "1080").strip().lower()
    if q in ("max", "best", "hoogste"):
        return ["-f", "bv*+ba/best"]
    if not q.isdigit():
        q = "1080"
    return ["-f", f"bv*[height<={q}]+ba/b[height<={q}]/bv*+ba/best", "-S", f"res:{q},vcodec:h264"]


def _update_ytdlp() -> None:
    global _YTDLP_UPDATED
    if _YTDLP_UPDATED:
        return
    _YTDLP_UPDATED = True
    print("[ClipNova] yt-dlp bijwerken…", flush=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "yt-dlp[default]"],
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _ytdlp_error(message: str) -> str:
    lines = [l for l in (message or "").splitlines() if "ERROR" in l] or (message or "").splitlines()[-2:]
    text = " ".join(lines)
    text = re.sub(r"https?://[^\s]*googlevideo\.com[^\s]*", "[video-adres]", text)
    text = re.sub(r"https?://\S{120,}", "[lang adres]", text)
    known = {"HTTP Error 403": "YouTube weigert de download (403). Vaak opgelost door yt-dlp bij te werken.",
             "Sign in to confirm you": "YouTube denkt dat dit een bot is. Probeer het later opnieuw.",
             "Private video": "Deze video is privé.",
             "Video unavailable": "Deze video is niet (meer) beschikbaar."}
    for key, nice in known.items():
        if key in text:
            return f"{nice} ({text[:300]})"
    return text[:400] or "onbekende fout"


def source_duration(url: str) -> Optional[float]:
    """Lengte van een link in seconden, zonder te downloaden. None als dat niet
    lukt (directe bestandslinks, livestreams): dan wordt na het downloaden gemeten."""
    low = url.lower().split("?")[0]
    if low.endswith(_VIDEO_SUFFIXES) or any(h in url.lower() for h in _DIRECT_FILE_HOSTS):
        return None
    try:
        r = subprocess.run(["yt-dlp", "--no-playlist", "--playlist-items", "1", "--skip-download",
                            "--print", "duration", url],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        return float(r.stdout.strip().splitlines()[0]) if r.returncode == 0 else None
    except Exception:
        return None


def _source_info(url: str) -> str:
    """Titel, kanaal en beschrijving van de bron: helpt de AI met namen en context."""
    try:
        r = subprocess.run(["yt-dlp", "--no-playlist", "--playlist-items", "1", "--skip-download", "--dump-json", url],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
        if r.returncode != 0:
            return ""
        info = json.loads(r.stdout.strip().splitlines()[0])
    except Exception:
        return ""
    parts = []
    if info.get("title"):
        parts.append(f"Title: {info['title']}")
    if info.get("channel") or info.get("uploader"):
        parts.append(f"Channel: {info.get('channel') or info.get('uploader')}")
    if info.get("description"):
        parts.append("Description: " + " ".join(str(info["description"]).split())[:1500])
    return "\n".join(parts)


def _filename_context(path: str) -> str:
    """Een bestandsnaam als 'Lacy en Marlon IRL.mp4' zegt iets; 'video_0012.mp4' niet."""
    stem = re.sub(r"[_\-]+", " ", Path(path).stem).strip()
    stem = re.sub(r"^src [0-9a-f]{8} ", "", stem)
    if re.fullmatch(r"[\w-]{11} NA", stem):
        return ""
    cleaned = re.sub(r"(?i)(upload|video|src|source|clip|bron|film|vid|img|mov)[ \d]*", "", stem).strip()
    if len(cleaned) < 2 or not re.search(r"[A-Za-z]{3}", cleaned):
        return ""
    return f"Title: {stem}"


def _download_source_impl(url: str, out_dir: str, max_minutes: Optional[int] = None,
                          max_height: str = "1080", progress_cb=None) -> str:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    low = url.lower().split("?")[0]
    if low.endswith(_VIDEO_SUFFIXES) or any(h in url.lower() for h in _DIRECT_FILE_HOSTS):
        return _download_file(url, out_dir)

    tag = uuid.uuid4().hex[:8]
    template = str(out / f"src_{tag}_%(id)s.%(ext)s")
    progress_re = re.compile(r"\[download\]\s+([\d.]+)%(?:.*?\bat\s+(\S+))?")

    def build(fmt_args):
        cmd = ["yt-dlp", "-N", "8", *fmt_args, "--merge-output-format", "mp4", "--retries", "5",
               "--fragment-retries", "10", "--no-playlist", "--playlist-items", "1", "--newline", "-o", template]
        if max_minutes:
            cmd += ["--download-sections", f"*0-{int(max_minutes) * 60}"]
        return cmd + [url]

    def attempt(cmd):
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except FileNotFoundError:
            raise RuntimeError("yt-dlp is niet geïnstalleerd in deze container.")
        tail = []
        for line in proc.stdout:
            tail = (tail + [line.rstrip()])[-40:]
            m = progress_re.search(line)
            if m and progress_cb:
                try:
                    progress_cb(float(m.group(1)) / 100.0, m.group(2) or "")
                except Exception:
                    pass
        proc.wait()
        return proc.returncode, "\n".join(tail)

    code, log = attempt(build(_format_args(max_height)))
    if code != 0:
        print(f"[ClipNova] Download-poging mislukt: {_ytdlp_error(log)}", flush=True)
        if "no video formats found" in log.lower() or "Unsupported URL" in log:
            raise RuntimeError("Deze link is geen videopagina en ook niet als bestand op te halen: " + url)
        if any(k in log for k in ("Private video", "Video unavailable", "This video is not available",
                                   "members-only", "Sign in to confirm your age")):
            raise RuntimeError("Download mislukt: " + _ytdlp_error(log))
        _update_ytdlp()
        for f in out.glob(f"src_{tag}_*"):
            f.unlink(missing_ok=True)
        code, log = attempt(build(["-f", "b/bv*+ba"]))
        if code != 0:
            raise RuntimeError("Download mislukt: " + _ytdlp_error(log))
    files = [f for f in out.glob(f"src_{tag}_*")
             if f.is_file() and f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov", ".m4v")
             and not f.name.endswith((".part", ".ytdl"))]
    if not files:
        raise RuntimeError("Download leverde geen videobestand op.")
    return str(max(files, key=lambda p: p.stat().st_size))


def download_source(url: str, out_dir: str, max_minutes: Optional[int] = None,
                    max_height: str = "1080", progress_cb=None) -> str:
    """Downloadt de bron en onthoudt titel/beschrijving als context voor de AI."""
    path = _download_source_impl(url, out_dir, max_minutes=max_minutes, max_height=max_height,
                                 progress_cb=progress_cb)
    low = url.lower().split("?")[0]
    direct = low.endswith(_VIDEO_SUFFIXES) or any(h in url.lower() for h in _DIRECT_FILE_HOSTS)
    context = "" if direct else _source_info(url)
    _SOURCE_CONTEXT[path] = context or _filename_context(path)
    return path


def _video_context(video_path: str) -> str:
    return str(_SOURCE_CONTEXT.get(video_path) or _filename_context(video_path))


# ---------------------------------------------------------------------------
# Wie zit erin?
# ---------------------------------------------------------------------------
def _detect_people(video_path: str, settings: "Settings", job_dir: str, report) -> tuple:
    """(tijdlijn [(t, [namen])], bekende namen). Alleen namen uit de invoer of
    uit herkenning; bij twijfel geen naam."""
    root = Path(getattr(settings, "faces_root", "") or Path(job_dir).parent)
    typed = people.split_names(getattr(settings, "people_names", "") or "")
    desc = getattr(settings, "video_description", "") or ""
    try:
        library = [p["name"] for p in people.list_library(root)]
    except Exception:
        library = []
    from_text = people.names_in_text(" ".join([desc, _video_context(video_path)]), library) if library else []
    wanted = list(dict.fromkeys(typed + from_text))
    if not library:
        return [], wanted
    if not people.available():
        print("[ClipNova] Gezichtsmodellen ontbreken (zie models/) — alleen namen uit de tekst.", flush=True)
        return [], wanted
    try:
        report("people", 0.0)
        t0 = _time.time()
        cast = people.build_cast(root, wanted=wanted or None)
        if cast.skipped:
            print("[ClipNova] Geen gezicht gevonden op de foto's van: " + ", ".join(cast.skipped), flush=True)
        timeline = people.scan_video(video_path, cast, _video_duration(video_path) or 0,
                                     progress_cb=lambda f: report("people", f))
        seen = sorted({n for _t, names in timeline for n in names})
        print(f"[ClipNova] Gezichten herkend in {_time.time() - t0:.0f}s: {', '.join(seen) or 'niemand'}", flush=True)
        report("people", 1.0)
        return timeline, list(dict.fromkeys(wanted + seen))
    except Exception as e:
        print(f"[ClipNova] Gezichtsherkenning mislukt ({type(e).__name__}: {str(e)[:160]}) — alleen namen uit de tekst.",
              flush=True)
        return [], wanted


# ---------------------------------------------------------------------------
# Momenten kiezen en op lengte brengen
# ---------------------------------------------------------------------------
def _video_duration(path: str) -> Optional[float]:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=noprint_wrappers=1:nokey=1", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        return float(r.stdout.strip())
    except Exception:
        return None


def _usable_duration(video_path: str) -> Optional[float]:
    """Tot waar de video echt beeld heeft. Een afgebroken download meldt vaak
    de volle lengte terwijl het bestand halverwege ophoudt."""
    total = _video_duration(video_path)
    if not total:
        return total
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-read_intervals", f"{max(0.0, total - 90):.0f}%",
                            "-show_entries", "packet=pts_time", "-of", "csv=p=0", video_path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        times = [float(x.strip().rstrip(",")) for x in r.stdout.splitlines()
                 if x.strip().rstrip(",").replace(".", "", 1).isdigit()]
        if times:
            return max(times)
    except Exception:
        pass
    return total


def _as_seconds(value) -> Optional[float]:
    """12.5, "12.5", "01:23", "1:02:03" -> seconden."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        if ":" in text:
            total = 0.0
            for part in text.split(":"):
                total = total * 60 + float(re.sub(r"[^\d.\-]", "", part) or 0)
            return total
        return float(re.sub(r"[^\d.\-]", "", text))
    except ValueError:
        return None


def _normalise_clips(raw) -> list:
    """Accepteert wat een AI teruggeeft (lijst, of {clips: [...]}) en maakt er
    nette dicts van met start/end/score/reason/hook/title/caption."""
    if isinstance(raw, dict):
        for key in ("clips", "moments", "results", "items", "segments"):
            if isinstance(raw.get(key), list):
                raw = raw[key]
                break
        else:
            raw = [raw]
    out = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        start = _as_seconds(item.get("start", item.get("start_time")))
        end = _as_seconds(item.get("end", item.get("end_time")))
        if start is None or end is None or end <= start:
            continue
        clip = dict(item)
        try:
            score = float(item.get("score", 0.5))
        except (TypeError, ValueError):
            score = 0.5
        if score > 1:
            score = score / 10.0 if score <= 10 else 1.0
        clip.update({
            "start": max(0.0, start), "end": end, "score": score,
            "reason": str(item.get("reason", ""))[:300],
            "hook": str(item.get("hook", ""))[:200],
            "title": str(item.get("title", ""))[:200],
            "caption": str(item.get("caption", ""))[:2000],
        })
        out.append(clip)
    return out


def _clamp_hard(clip: dict, settings: "Settings", video_end: Optional[float], hard_min: float) -> dict:
    """Houdt een clip tussen de harde grenzen: minstens hard_min, hooguit de maximale lengte."""
    c = dict(clip)
    s, e = float(c["start"]), float(c["end"])
    if e - s > settings.max_clip_duration:
        e = s + settings.max_clip_duration
    if e - s < hard_min:
        grow = hard_min - (e - s)
        s -= grow * 0.35
        e = s + hard_min
    if video_end:
        if e > video_end:
            s, e = s - (e - video_end), video_end
        s = max(0.0, s)
        e = min(e, video_end)
    else:
        if s < 0:
            e, s = e - s, 0.0
    c["start"], c["end"] = round(s, 2), round(e, 2)
    return c


def _reshape_to_window(clip: dict, settings: "Settings", video_end: Optional[float], hard_min: float) -> dict:
    """Brengt een clip binnen de voorkeurslengte; verlengen gebeurt vooral na
    het moment (35% ervoor), inkorten aan het eind zodat het sterke begin blijft."""
    c = dict(clip)
    s, e = float(c["start"]), float(c["end"])
    pmin = max(hard_min, float(settings.preferred_min))
    pmax = max(pmin, min(float(settings.preferred_max), float(settings.max_clip_duration)))
    length = e - s
    if length < pmin:
        grow = pmin - length
        s -= grow * 0.35
        e = s + pmin
    elif length > pmax:
        e = s + pmax
    c["start"], c["end"] = s, e
    return _clamp_hard(c, settings, video_end, hard_min)


def _apply_preferred_duration(clips: list, settings: "Settings", video_end: Optional[float], hard_min: float) -> list:
    """Zorgt dat minstens preferred_share van de clips in de voorkeurslengte
    valt; de rest blijft zoals de AI hem koos, binnen de harde grenzen."""
    if not clips:
        return []
    pmin, pmax = float(settings.preferred_min), float(settings.preferred_max)

    def inside(c):
        return pmin - 0.01 <= c["end"] - c["start"] <= pmax + 0.01

    def distance(c):
        length = c["end"] - c["start"]
        return 0.0 if inside(c) else min(abs(length - pmin), abs(length - pmax))

    out = [_clamp_hard(c, settings, video_end, hard_min) for c in clips]
    need = int(round(len(out) * max(0.0, min(1.0, float(settings.preferred_share or 0)))))
    have = sum(1 for c in out if inside(c))
    if have < need:
        order = sorted(range(len(out)), key=lambda i: distance(out[i]))
        for i in order:
            if have >= need:
                break
            if not inside(out[i]):
                out[i] = _reshape_to_window(out[i], settings, video_end, hard_min)
                if inside(out[i]):
                    have += 1
    return out


def _audio_energy(video_path: str, window: float = 1.0) -> list:
    """Luidheid per venster van `window` seconden: [(t, rms)]."""
    rate = 1000
    try:
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", video_path, "-vn", "-ac", "1", "-ar", str(rate),
                            "-f", "s16le", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        return []
    if r.returncode != 0 or not r.stdout:
        return []
    samples = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32)
    per = max(1, int(rate * window))
    n = samples.size // per
    if n == 0:
        return []
    rms = np.sqrt(np.mean(samples[: n * per].reshape(n, per) ** 2, axis=1))
    return [(i * window, float(v)) for i, v in enumerate(rms)]


def _moments_from_audio(video_path: str, settings: "Settings", video_end: Optional[float], hard_min: float) -> list:
    """Zonder bruikbare tekst: de luidste momenten (gejuich, geschreeuw, lachen)."""
    energy = _audio_energy(video_path)
    if len(energy) < 10:
        return []
    values = np.array([v for _t, v in energy])
    if values.max() <= 0 or values.max() < np.median(values) * 1.25:
        return []
    threshold = np.percentile(values, 90)
    length = max(hard_min, min(float(settings.preferred_min), float(settings.max_clip_duration)))
    peaks = sorted(((t, v) for t, v in energy if v >= threshold), key=lambda p: -p[1])
    out = []
    limit = settings.max_clips or 10
    for t, v in peaks:
        start = max(0.0, t - length * 0.45)
        end = start + length
        if video_end:
            end = min(end, video_end)
            start = max(0.0, end - length)
        if any(not (end <= c["start"] or start >= c["end"]) for c in out):
            continue
        out.append({"start": round(start, 2), "end": round(end, 2),
                    "score": round(0.45 + 0.3 * float(v / values.max()), 2),
                    "reason": "luidste moment in de opname", "hook": "", "title": "", "caption": ""})
        if len(out) >= limit:
            break
    return sorted(out, key=lambda c: c["start"])


# ---------------------------------------------------------------------------
# De hele video verwerken
# ---------------------------------------------------------------------------
class UserError(RuntimeError):
    """Fout waarvan de tekst voor de klant bedoeld is (zonder technische foutnaam)."""


class TranscribeError(UserError):
    """Uitschrijven lukte op geen enkele manier."""


def too_long_message(seconds: float, max_minutes: int, plan_name: str = "", count: int = 1) -> str:
    where = f"In je {plan_name.lower()}" if plan_name else "Met je abonnement"
    what = "Deze video duurt" if count <= 1 else f"Deze {count} video's duren samen"
    return (f"{what} {seconds / 60:.0f} minuten. {where} kun je video's tot "
            f"{max_minutes} minuten gebruiken (alle video's van één run samen). "
            "Knip de video korter of kies een groter abonnement.")


def process_video(video_path: str, briefing: str, settings: "Settings", job_dir: str,
                  api_key: Optional[str] = None, rules: Optional[dict] = None,
                  progress_cb=None) -> list:
    """Uitschrijven -> wie zit erin -> momenten kiezen -> knippen. Geeft
    ClipResults terug; process_video.last_notes zegt hoe het ging."""
    def report(phase, fraction):
        if progress_cb:
            try:
                progress_cb(phase, fraction)
            except Exception:
                pass

    notes = []
    process_video.rescued = []
    process_video.failures = []
    has_audio = _has_audio(video_path)
    transcript, language_info = [], {}
    spoken = str((rules or {}).get("language_code") or settings.spoken_language or "").strip().lower()[:2] or None
    report("transcribe", 0.0)
    if has_audio:
        audio = extract_audio(video_path, job_dir)
        groq_key = (api_key if settings.llm_provider == "groq" else None) or service_key("groq")
        local_only = os.environ.get("CLIPPARTY_LOCAL_WHISPER") == "1"
        dg_key = None if local_only else deepgram_key()
        done = False
        if dg_key:
            try:
                t0 = _time.time()
                transcript, language_info = transcribe_deepgram(
                    audio, dg_key, job_dir, progress_cb=lambda f: report("transcribe", f), language=spoken)
                print(f"[ClipNova] Uitgeschreven via Deepgram in {_time.time() - t0:.0f}s", flush=True)
                done = True
            except Exception as e:
                print(f"[ClipNova] Deepgram mislukt, verder met Groq/lokaal: {str(e)[:200]}", flush=True)
        if not done and groq_key and not local_only:
            try:
                t0 = _time.time()
                transcript, language_info = transcribe_groq(
                    audio, groq_key, job_dir, progress_cb=lambda f: report("transcribe", f), language=spoken)
                print(f"[ClipNova] Uitgeschreven via Groq in {_time.time() - t0:.0f}s", flush=True)
                done = True
            except Exception as e:
                print(f"[ClipNova] Groq-transcriptie mislukt, lokaal verder: {str(e)[:200]}", flush=True)
        if not done:
            try:
                transcript, language_info = transcribe(audio, progress_cb=lambda f: report("transcribe", f),
                                                       language=spoken)
            except Exception as e:
                # Zonder tekst geen ondertitels en geen hooks: liever stoppen (zonder
                # credits af te schrijven) dan halve clips maken.
                print(f"[ClipNova] Lokaal uitschrijven mislukt: {type(e).__name__}: {e}", flush=True)
                raise TranscribeError(
                    "Het uitschrijven van de video lukte niet, dus er zijn geen clips gemaakt en geen "
                    "credits gebruikt. Probeer het later opnieuw."
                    + ("" if (dg_key or groq_key) else
                       " (Beheerder: stel een Deepgram- of Groq-sleutel in onder Account.)")
                    + f" [{type(e).__name__}: {str(e)[:120]}]") from e
    else:
        print("[ClipNova] Video zonder geluidsspoor — transcriptie overgeslagen.", flush=True)
        language_info = {"language": spoken or "nl"}
    report("transcribe", 1.0)

    out_lang = _resolve_output_language(settings, rules, language_info, transcript)
    settings = dataclasses.replace(settings, output_language=out_lang)
    print(f"[ClipNova] Taal van de hooktekst en bijschriften: {out_lang}", flush=True)
    spoken_lang = str(language_info.get("language") or out_lang or "")[:2] or None

    timeline, known_names = _detect_people(video_path, settings, job_dir, report)

    report("select", 0.0)
    context = "\n".join(x for x in (
        _video_context(video_path),
        ("Description: " + settings.video_description.strip()[:1500]) if settings.video_description.strip() else "",
    ) if x)
    chosen = []
    if any(str(seg.get("text", "")).strip() for seg in transcript):
        chosen = select_clips_with_llm(transcript, briefing, settings, api_key=api_key, rules=rules,
                                       source_context=context, people_timeline=timeline,
                                       known_names=known_names)
    report("select", 1.0)

    min_dur = 5.0
    if rules and rules.get("min_duration_seconds"):
        try:
            min_dur = max(min_dur, float(rules["min_duration_seconds"]))
        except (TypeError, ValueError):
            pass
    video_end = _video_duration(video_path)
    real_end = _usable_duration(video_path)
    if video_end and real_end and real_end < video_end * 0.9:
        print(f"[ClipNova] Video meldt {video_end:.0f}s maar is maar tot {real_end:.0f}s bruikbaar.", flush=True)
        notes.append(f"bestand meldt {video_end / 60:.1f} min maar is maar tot {real_end / 60:.1f} min "
                     "bruikbaar — download waarschijnlijk afgebroken")
        video_end = real_end

    chosen = _normalise_clips(chosen)
    by_ai = sum(1 for c in chosen if c.get("ai", True))
    if by_ai:
        notes.append(f"AI koos {by_ai} moment(en) uit de tekst")
    elif chosen:
        notes.append(f"{len(chosen)} moment(en) uit de tekst gekozen zonder AI "
                     "(geen AI-sleutel ingesteld of AI niet bereikbaar)")
    notes.insert(0, "taal van de video: " + LANG_NAMES.get(spoken_lang or "", spoken_lang or "onbekend"))

    if not chosen:
        spoken_parts = sum(1 for seg in transcript if str(seg.get("text", "")).strip())
        notes.append("deze video heeft geen geluidsspoor" if not has_audio
                     else f"transcript leverde {spoken_parts} gesproken fragment(en) op")
        print("[ClipNova] Geen momenten uit de tekst — zoeken op geluid.", flush=True)
        energy = _audio_energy(video_path) if has_audio else []
        if has_audio and not energy:
            notes.append("de video heeft geen bruikbaar geluidsspoor")
        elif has_audio and len(energy) < 10:
            notes.append(f"de video duurt maar {len(energy)} seconde(n)")
        elif has_audio:
            chosen = _moments_from_audio(video_path, settings, video_end, min_dur)
            if chosen:
                print(f"[ClipNova] {len(chosen)} moment(en) gevonden op geluid.", flush=True)
            else:
                notes.append("het geluid is overal even hard, dus geen piek te vinden")
        if not chosen:
            chosen = _moments_evenly_spaced(settings, video_end, min_dur)
            if chosen:
                notes.append(f"{len(chosen)} fragment(en) gelijkmatig over de opname gekozen")
                print(f"[ClipNova] {len(chosen)} fragment(en) gelijkmatig verdeeld.", flush=True)
        if not chosen and video_end:
            notes.append(f"bronvideo is {video_end / 60:.1f} minuten")
    if rules and rules.get("min_duration_seconds"):
        notes.append(f"campagne eist minstens {min_dur:g} seconden per clip")

    before_filter = len(chosen)
    chosen = _apply_preferred_duration(chosen, settings, video_end, min_dur)
    chosen = [c for c in chosen if min_dur - 0.01 <= c["end"] - c["start"] <= settings.max_clip_duration + 0.5]
    if before_filter and not chosen:
        notes.append(f"{before_filter} moment(en) gevonden, maar allemaal buiten "
                     f"{min_dur:g}-{settings.max_clip_duration:g} seconden")

    # Overlap weghalen: twee clips over hetzelfde moment zijn dubbel werk.
    chosen = sorted(chosen, key=lambda c: -c.get("score", 0))
    unique = []
    for c in chosen:
        if all(min(c["end"], u["end"]) - max(c["start"], u["start"]) < 0.5 * (c["end"] - c["start"]) for u in unique):
            unique.append(c)
    chosen = unique
    strong = [c for c in chosen if c.get("score", 0) >= 0.55]
    dropped = len(chosen) - len(strong)
    if strong and dropped and len(strong) >= 3:
        notes.append(f"{dropped} zwakke moment(en) overgeslagen (score onder 0,55)")
        chosen = strong
    if settings.max_clips:
        chosen = chosen[: settings.max_clips]

    cores = max(1, os.cpu_count() or 4)
    workers = max(1, min(4, max(1, cores // 2), len(chosen) or 1))
    results = [None] * len(chosen)
    rescued, failures = process_video.rescued, process_video.failures

    def _work(i: int, c: dict):
        clip_id = uuid.uuid4().hex[:8]
        out_path = str(Path(job_dir) / f"clip_{clip_id}.mp4")
        try:
            face = cut_clip(video_path, c["start"], c["end"], out_path, settings,
                            hook_text=c.get("hook", ""), full_transcript=transcript)
        except Exception as e:
            print(f"[ClipNova] Clip {i + 1} mislukte ({e}) — eenvoudige poging.", flush=True)
            if _cut_plain(video_path, c["start"], c["end"], out_path, settings):
                rescued.append(f"{c['start']:.0f}-{c['end']:.0f}s")
                face = False
            else:
                failures.append(f"{c['start']:.0f}-{c['end']:.0f}s: {str(e)[:120]}")
                return i, None
        return i, ClipResult(
            id=clip_id, source_video=video_path, start=float(c["start"]), end=float(c["end"]),
            hook=c.get("hook", ""), reason=c.get("reason", ""), score=float(c.get("score", 0)),
            output_path=out_path, face_detected=bool(face), language=spoken_lang,
            text=clip_text(transcript, float(c["start"]), float(c["end"])),
            people=people.people_between(timeline, float(c["start"]), float(c["end"])) if timeline else [],
        )

    report("cut", 0.0)
    if chosen:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_work, i, c) for i, c in enumerate(chosen)]
            done = 0
            for fut in as_completed(futures):
                i, result = fut.result()
                results[i] = result
                done += 1
                report("cut", done / max(1, len(chosen)))
    made = [r for r in results if r is not None]
    made.sort(key=lambda r: r.start)
    if rescued:
        notes.append(f"{len(rescued)} clip(s) zonder opmaak geknipt omdat de normale manier faalde")
    if failures:
        notes.append(f"{len(failures)} van {len(chosen)} clip(s) konden niet geknipt worden")
        notes.extend("  " + f for f in failures[:3])
    process_video.last_notes = notes
    return made


process_video.last_notes = []
process_video.rescued = []
process_video.failures = []
