# ClipNova

- `clipnova-v126.zip`: ClipNova v126 (Python/FastAPI): lange video → korte clips met hooks en ondertitels.
- [`posting-bot/`](posting-bot/README.md): **AI Clip Posting Bot** (Next.js): plant en publiceert clips naar
  TikTok, YouTube Shorts en Instagram Reels over meerdere accounts, met wachtrij, kalender en AI-bijschriften.
  Werkt direct in mock mode zonder API-sleutels.
- [`campaign-finder/`](campaign-finder/README.md): **AI Clip Campaign Video Finder** (Next.js): zoekt bronvideo's
  voor campagnes (YouTube API / RSS / demo-data), scoort match- en clippotentie met AI en stelt fragmenten voor.

```bash
cd posting-bot && npm install && npx prisma db push && npm run dev        # :3000
cd campaign-finder && npm install && npx prisma db push && npm run dev    # :3001
```
