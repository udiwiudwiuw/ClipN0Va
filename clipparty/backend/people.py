"""Wie zit er in de video?

Twee bronnen, in deze volgorde van betrouwbaarheid:
  1. De namen die jij opgeeft of die in de videobeschrijving / titel staan.
  2. Gezichtsherkenning, alleen tussen die namen: vergelijkt gezichten in de
     video met referentiefoto's uit de gezichtenbibliotheek.

Alles draait lokaal met OpenCV (YuNet voor detectie, SFace voor herkenning).
Zonder de twee modelbestanden of zonder foto's valt alles terug op alleen de
namen uit de beschrijving, zodat de rest van de app gewoon blijft werken.

Bewust voorzichtig: bij twijfel krijgt een gezicht GEEN naam. Een ontbrekende
naam is beter dan een verkeerde naam in een hooktekst.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

MODELS_DIR = Path(os.environ.get("CLIPPARTY_FACE_MODELS")
                  or Path(__file__).resolve().parent.parent / "models")
YUNET = MODELS_DIR / "face_detection_yunet_2023mar.onnx"
SFACE = MODELS_DIR / "face_recognition_sface_2021dec.onnx"

# Cosinus-drempel die de makers van SFace aanbevelen (0.363). Iets strenger
# gezet: liever geen naam dan een foute naam.
MATCH_THRESHOLD = 0.40
# De beste persoon moet duidelijk beter scoren dan de nummer twee.
MARGIN = 0.06
# Gezichten kleiner dan dit (in pixels, op het verkleinde beeld) zijn te
# onscherp om betrouwbaar te herkennen.
MIN_FACE_PX = 48
# Een naam telt pas voor een clip als die persoon in minstens zoveel van de
# bemonsterde beelden voorkomt.
MIN_SIGHTINGS = 2

FACES_DIR_NAME = "faces"


def available() -> bool:
    return YUNET.exists() and SFACE.exists()


def _slug(name: str) -> str:
    s = re.sub(r"[^\w\- ]", "", name, flags=re.UNICODE).strip()
    return re.sub(r"\s+", "_", s)[:60]


# --------------------------------------------------------------------------
# Bibliotheek met referentiefoto's:  <storage>/faces/<naam>/<foto's>
# --------------------------------------------------------------------------
def library_dir(storage: Path) -> Path:
    d = Path(storage) / FACES_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_library(storage: Path) -> list[dict]:
    out = []
    for d in sorted(library_dir(storage).iterdir()):
        if d.is_dir():
            photos = [p for p in d.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
            name_file = d / "name.txt"
            name = name_file.read_text(encoding="utf-8").strip() if name_file.exists() else d.name.replace("_", " ")
            out.append({"name": name, "slug": d.name, "photos": len(photos)})
    return out


def add_photo(storage: Path, name: str, filename: str, data: bytes) -> str:
    slug = _slug(name)
    if not slug:
        raise ValueError("Geef een naam op.")
    d = library_dir(storage) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / "name.txt").write_text(name.strip(), encoding="utf-8")
    ext = Path(filename).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        ext = ".jpg"
    n = len([p for p in d.iterdir() if p.suffix.lower() == ext]) + 1
    path = d / f"foto_{n}{ext}"
    path.write_bytes(data)
    return str(path)


def delete_person(storage: Path, slug: str) -> bool:
    d = library_dir(storage) / _slug(slug)
    if d.is_dir():
        shutil.rmtree(d)
        return True
    return False


# --------------------------------------------------------------------------
# Namen uit beschrijving / titel / invoer
# --------------------------------------------------------------------------
def split_names(text: str) -> list[str]:
    """'Lacy, Marlon en Jade' -> ['Lacy', 'Marlon', 'Jade']"""
    parts = re.split(r"[,;\n&+]|\ben\b|\band\b|\bmet\b|\bwith\b", text or "", flags=re.I)
    return [p.strip() for p in parts if p and p.strip()]


def names_in_text(text: str, candidates: list[str]) -> list[str]:
    """Welke bekende namen komen in de tekst voor (hele woorden, hoofdletter-onafhankelijk)?"""
    low = " " + re.sub(r"[^\w ]", " ", (text or "").lower(), flags=re.UNICODE) + " "
    found = []
    for c in candidates:
        key = re.sub(r"[^\w ]", " ", c.lower(), flags=re.UNICODE).strip()
        first = key.split(" ")[0] if key else ""
        # Volledige naam, of alleen de voornaam ("Marlon" voor "Marlon de Vries").
        if key and (f" {key} " in low or (len(first) >= 3 and f" {first} " in low)):
            found.append(c)
    return found


# --------------------------------------------------------------------------
# Herkenning
# --------------------------------------------------------------------------
class _Engine:
    """Houdt detector en herkenner bij elkaar; maakt de detector per beeldmaat."""

    def __init__(self):
        self.det = cv2.FaceDetectorYN.create(str(YUNET), "", (320, 320), 0.8, 0.3, 20)
        self.rec = cv2.FaceRecognizerSF.create(str(SFACE), "")

    def faces(self, img):
        h, w = img.shape[:2]
        self.det.setInputSize((w, h))
        _, rows = self.det.detect(img)
        return [] if rows is None else list(rows)

    def embed(self, img, row) -> np.ndarray:
        aligned = self.rec.alignCrop(img, row)
        return self.rec.feature(aligned)

    def cosine(self, a, b) -> float:
        return float(self.rec.match(a, b, cv2.FaceRecognizerSF_FR_COSINE))


def _shrink(img, max_w=960):
    h, w = img.shape[:2]
    if w > max_w:
        s = max_w / w
        img = cv2.resize(img, (max_w, max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    return img


class Cast:
    """Personen waar we naar zoeken, met hun referentie-embeddings."""

    def __init__(self):
        self.embeddings: dict[str, list[np.ndarray]] = {}
        self.skipped: list[str] = []   # namen zonder bruikbare foto

    @property
    def names(self) -> list[str]:
        return list(self.embeddings)


def build_cast(storage: Path, wanted: Optional[list[str]] = None, max_people: int = 12) -> Cast:
    """Laadt referentiefoto's. `wanted` = namen om te zoeken; leeg = hele bibliotheek."""
    cast = Cast()
    if not available():
        return cast
    eng = _Engine()
    lib = list_library(storage)
    if wanted:
        wanted_low = {w.lower() for w in wanted}
        lib = [p for p in lib if p["name"].lower() in wanted_low
               or p["name"].lower().split(" ")[0] in wanted_low]
    for person in lib[:max_people]:
        folder = library_dir(storage) / person["slug"]
        feats = []
        for ph in sorted(folder.iterdir()):
            if ph.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp"):
                continue
            img = cv2.imread(str(ph))
            if img is None:
                continue
            img = _shrink(img)
            rows = eng.faces(img)
            if not rows:
                continue
            # Op een referentiefoto is het grootste gezicht de persoon.
            row = max(rows, key=lambda r: r[2] * r[3])
            feats.append(eng.embed(img, row))
        if feats:
            cast.embeddings[person["name"]] = feats
        else:
            cast.skipped.append(person["name"])
    return cast


def _identify_face(eng: _Engine, cast: Cast, feat) -> Optional[str]:
    scores = []
    for name, feats in cast.embeddings.items():
        scores.append((max(eng.cosine(feat, f) for f in feats), name))
    if not scores:
        return None
    scores.sort(reverse=True)
    best, name = scores[0]
    second = scores[1][0] if len(scores) > 1 else -1.0
    if best >= MATCH_THRESHOLD and (best - second) >= MARGIN:
        return name
    # Een enkele persoon in de cast heeft geen nummer twee om mee te vergelijken.
    if len(scores) == 1 and best >= MATCH_THRESHOLD + 0.05:
        return name
    return None


def scan_video(video_path: str, cast: Cast, duration: float,
               step: float = 8.0, max_samples: int = 150, progress_cb=None) -> list[tuple[float, list[str]]]:
    """Bemonstert de video elke `step` seconden. Geeft [(tijd, [namen])] terug."""
    if not cast.embeddings or duration <= 0:
        return []
    step = max(step, duration / max_samples)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return []
    eng = _Engine()
    out: list[tuple[float, list[str]]] = []
    t, n_total = 0.0, int(duration // step) + 1
    i = 0
    try:
        while t < duration:
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
            ok, frame = cap.read()
            if ok and frame is not None:
                frame = _shrink(frame)
                seen = set()
                for row in eng.faces(frame):
                    if row[2] < MIN_FACE_PX:
                        continue
                    name = _identify_face(eng, cast, eng.embed(frame, row))
                    if name:
                        seen.add(name)
                out.append((t, sorted(seen)))
            i += 1
            if progress_cb:
                progress_cb(min(1.0, i / n_total))
            t += step
    finally:
        cap.release()
    return out


def people_between(timeline: list[tuple[float, list[str]]], start: float, end: float,
                   pad: float = 4.0) -> list[str]:
    """Namen die in dit stuk minstens MIN_SIGHTINGS keer gezien zijn (op volgorde van vaakst)."""
    counts: dict[str, int] = {}
    for t, names in timeline:
        if start - pad <= t <= end + pad:
            for n in names:
                counts[n] = counts.get(n, 0) + 1
    ok = [(c, n) for n, c in counts.items() if c >= MIN_SIGHTINGS]
    # Een heel kort stuk heeft weinig steekproeven; dan telt één keer wel.
    if not ok and (end - start) < 20:
        ok = [(c, n) for n, c in counts.items() if c >= 1]
    return [n for _, n in sorted(ok, reverse=True)]


def timeline_text(timeline: list[tuple[float, list[str]]], start: float, end: float) -> str:
    """Compacte regel voor in de AI-prompt: wie is wanneer te zien."""
    if not timeline:
        return ""
    lines, prev, seg_start = [], None, None
    pts = [(t, tuple(n)) for t, n in timeline if start - 5 <= t <= end + 5]
    for t, names in pts:
        if names != prev:
            if prev:
                lines.append(f"[{int(seg_start)}-{int(t)}] {', '.join(prev)}")
            prev, seg_start = names, t
    if prev:
        lines.append(f"[{int(seg_start)}-{int(end)}] {', '.join(prev)}")
    return "\n".join(lines)
