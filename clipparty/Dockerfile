FROM python:3.11-slim

# Forces print()/logging to flush immediately instead of sitting in an
# internal buffer — without this, our own [ClipNova] debug messages could
# stay invisible in `docker logs`/the terminal for a long time (or until the
# process exits) even though everything is actually running fine.
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core fonts-dejavu-extra fonts-noto-color-emoji fonts-inter && rm -rf /var/lib/apt/lists/*

# Deno: yt-dlp heeft sinds eind 2025 een JavaScript-runtime nodig om
# YouTube-video's te kunnen ontsleutelen. Zonder geeft YouTube vaak alleen
# lage kwaliteit of weigert het de download (HTTP 403).
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Gezichtsmodellen (OpenCV YuNet + SFace, samen ~40 MB). Zonder deze twee
# bestanden werkt de app gewoon verder, alleen zonder gezichtsherkenning.
RUN mkdir -p /app/models && python -c "import urllib.request as u; \
b='https://github.com/opencv/opencv_zoo/raw/main/models/'; \
u.urlretrieve(b+'face_detection_yunet/face_detection_yunet_2023mar.onnx','/app/models/face_detection_yunet_2023mar.onnx'); \
u.urlretrieve(b+'face_recognition_sface/face_recognition_sface_2021dec.onnx','/app/models/face_recognition_sface_2021dec.onnx')" \
 || echo "Gezichtsmodellen niet gedownload; herkenning staat uit."

# TikTok Sans (open source, SIL OFL) zit in assets/fonts: voor de hooktekst,
# de ondertitels en het scherm. Ook systeembreed, zodat ffmpeg hem vindt.
COPY assets assets
RUN mkdir -p /usr/share/fonts/truetype/tiktoksans && cp assets/fonts/*.ttf /usr/share/fonts/truetype/tiktoksans/ && fc-cache -f

COPY backend backend
COPY frontend frontend

WORKDIR /app/backend
EXPOSE 8000
# Bij elke start yt-dlp op de achtergrond bijwerken. Docker hergebruikt de
# pip-laag bij een gewone build, dus zonder dit blijft yt-dlp oud terwijl
# YouTube verandert. De app start meteen; het bijwerken loopt ernaast.
CMD ["sh", "-c", "(pip install -q -U 'yt-dlp[default]' >/dev/null 2>&1 &) ; exec uvicorn main:app --host 0.0.0.0 --port 8000"]
