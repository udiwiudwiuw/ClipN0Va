# ClipNova Posting Bot

Plan en publiceer clips automatisch op **TikTok**, **YouTube Shorts** en **Instagram Reels**,
met meerdere accounts per platform. Hoort bij het ClipNova-ecosysteem: clips die ClipNova
maakt importeer je met één klik, inclusief titel, bijschrift en hashtags.

**Werkt direct na installatie:** zonder API-sleutels draait alles in **Mock Publishing Mode**.
Koppelen, token-verversing en uploads worden dan lokaal gesimuleerd met realistische
API-responses (en af en toe een tijdelijke fout), zodat je de UI, planner en wachtrij
volledig kunt testen.

## Snel starten

Vereist: Node.js 18.18+ (getest met 22).

```bash
cd posting-bot
npm install
cp .env.example .env        # optioneel: alles werkt ook met de standaardwaarden
npx prisma db push          # maakt prisma/dev.db aan
npm run db:seed             # optioneel: demo-accounts, testclips (met ffmpeg) en planning
npm run dev                 # http://localhost:3000
```

Productie: `npm run build && npm start`.

Tests (planner, wachtrij, multi-account, retries, herautorisatie, imports):

```bash
npm test
```

## Functies

| Scherm | Wat je er doet |
|---|---|
| **Overzicht** | Gekoppelde accounts, bibliotheek-statistieken, eerstvolgende en mislukte publicaties, status van de worker |
| **Accounts** | Per platform meerdere accounts koppelen, herautoriseren, token verversen, pauzeren, ontkoppelen; per account een eigen tijdzone, posttijden en daglimiet |
| **Videobibliotheek** | Raster/lijst met video-preview, filters (campagne, creator, status, bron), uploaden (meerdere tegelijk), bulk-import uit ClipNova of een map, bewerken met AI-suggestie, selecteren en inplannen |
| **Kalender** | Dag-, week- en maandoverzicht; klik op een post om tekst of tijd aan te passen |
| **Wachtrij & logs** | Live status (ververst elke 3 s), goedkeuren, opnieuw proberen, annuleren, nu publiceren; logboek met filters |
| **Instellingen** | API-sleutels, OpenAI, standaardtijden en tijdzone, mock mode, importmappen |

### Zo werkt de planning

1. Selecteer clips in de bibliotheek → **Inplannen** → kies accounts.
2. **Automatisch**: elke clip krijgt het eerstvolgende vrije slot van elk account, in de tijdzone
   van dat account (zomertijd inbegrepen), met inachtneming van het daglimiet en al geplande posts.
   **Vast moment**: vanaf een tijdstip met een vaste tussenruimte.
3. **Slimme bijschriften**: per platform geoptimaliseerd (lengte, toon, aantal hashtags) en per
   account gevarieerd, zodat niet elk account dezelfde tekst post. Met `OPENAI_API_KEY` via
   OpenAI, anders via ingebouwde sjablonen.
4. Posts komen als **concept** binnen; pas de tekst aan en keur goed (of zet "Direct goedkeuren" /
   `AUTO_APPROVE` aan).

### Wachtrij en betrouwbaarheid

Statussen: `draft` → `queued` → `processing` → `success` / `failed` / `needs_reauth` (en `cancelled`).

- **Achtergrond-worker** (node-cron, elke `WORKER_INTERVAL_SECONDS`, standaard 15 s) start
  automatisch met de server via `src/instrumentation.ts`.
- **Atomair claimen**: een post wordt alleen verwerkt als hij nog `queued` is (conditionele update),
  dus twee workers publiceren nooit dezelfde post. Per account maximaal één upload tegelijk;
  accounts lopen parallel.
- **Retries**: tijdelijke fouten (netwerk, 429, 5xx, quota) worden opnieuw geprobeerd met
  exponentiële backoff (30 s, 2 min, 8 min … max 1 uur, met jitter; `Retry-After` wordt
  gerespecteerd), maximaal 4 pogingen. Permanente fouten gaan direct naar `failed`.
- **Tokens**: worden vóór elke upload ververst als ze binnen 5 minuten verlopen, en elk uur
  proactief als ze binnen 24 uur verlopen. Lukt verversen niet (ingetrokken), dan gaan
  account en posts naar `needs_reauth`; na herautorisatie gaan die posts vanzelf terug in de wachtrij.
- **Duplicaatpreventie**: één post per (clip, account) via een unieke idempotency key; dezelfde
  video importeren wordt herkend op SHA-256. Een post met een extern ID wordt nooit opnieuw geüpload.
- **Vastgelopen uploads** (server herstart tijdens upload): bij mock-accounts terug in de wachtrij;
  bij echte accounts naar `failed` met de vraag eerst op het platform te kijken. Zo ontstaan geen
  dubbele posts.

### Mock-accounts testen

Op een mock-account staan testknoppen: **token laten verlopen** (wordt bij de volgende upload
automatisch ververst) en **autorisatie intrekken** (account → herautorisatie nodig). Met
`MOCK_FAILURE_RATE` (standaard 0,1) zie je retries in actie.

## Echte platforms koppelen

Alle stappen staan ook in `.env.example`. Vul sleutels in via `.env` of de pagina Instellingen.
Accounts die je in mock mode koppelde blijven mock-accounts; koppel echte accounts opnieuw.

**TikTok** (Content Posting API): app op developers.tiktok.com met Login Kit + Content Posting
API, scopes `user.info.basic,video.publish,video.upload`, redirect
`{PUBLIC_BASE_URL}/api/oauth/tiktok/callback`. Tot je app is geaudit, mag TikTok alleen
privé (`SELF_ONLY`) posten.

**YouTube Shorts** (Data API v3): Google Cloud-project met YouTube Data API v3, OAuth-client
(web), redirect `{PUBLIC_BASE_URL}/api/oauth/youtube/callback`. Elk kanaal koppel je apart; het
Google-scherm vraagt telkens welk kanaal. Let op het dagquotum (een upload kost 1.600 eenheden
van de standaard 10.000).

**Instagram Reels** (Instagram API met Instagram Login): Business-app op developers.facebook.com,
product Instagram, scopes `instagram_business_basic,instagram_business_content_publish`, redirect
`{PUBLIC_BASE_URL}/api/oauth/instagram/callback`. Alleen professionele accounts. Instagram
downloadt de video zelf, dus `PUBLIC_BASE_URL` moet een publiek **https**-adres zijn; de bot
geeft daarvoor een tijdelijk ondertekende media-URL mee.

> De koppelingen met de echte API's volgen de officiële documentatie, maar zijn in deze versie
> niet getest met echte sleutels. Test eerst met één account en privé-zichtbaarheid.

## ClipNova-import

Stel `CLIPNOVA_STORAGE_DIR` in op de storage-map van ClipNova (`backend/storage`, of het
gemounte Docker-volume `clipnova-data`). **Bulk-import → Uit ClipNova** leest elke
`<job_id>/job.json`, neemt van elke clip titel, bijschrift en hashtags over en kopieert
`clip_<id>.mp4` naar de bibliotheek. Opnieuw importeren slaat clips over die er al zijn.

**Uit map**: elke `.mp4/.mov/.webm/.m4v` in `IMPORT_DIR` (twee niveaus diep). Een
`<naam>.json` naast de video mag `title`, `caption`, `hashtags`, `campaign` en `creator` bevatten.

## Projectstructuur

```
posting-bot/
├─ prisma/schema.prisma      Account, Clip, Post, Log, Setting (SQLite)
├─ prisma/seed.ts            demo-data
├─ src/instrumentation.ts    start de worker bij het opstarten van de server
├─ src/middleware.ts         optionele login (APP_PASSWORD)
├─ src/lib/
│  ├─ platforms/             tiktok.ts, youtube.ts, instagram.ts, mock.ts (+ foutclassificatie)
│  ├─ scheduler.ts           slots per account/tijdzone, inplannen, duplicaatpreventie
│  ├─ queue.ts               claimen, publiceren, retries/backoff, herstel
│  ├─ worker.ts              node-cron loop + token-onderhoud
│  ├─ accounts.ts            tokens verversen, (her)koppelen, needs_reauth
│  ├─ ai.ts                  OpenAI- en sjabloonbijschriften met variatie
│  ├─ importers.ts           upload, map- en ClipNova-import
│  └─ settings.ts, crypto.ts, media.ts, log.ts
├─ src/app/                  dashboardpagina's + api/ routes
└─ tests/                    vitest-suite
```

## Voor je online gaat

- Zet `APP_PASSWORD`: de app heeft verder geen gebruikersaccounts.
- Zet `TOKEN_ENCRYPTION_KEY` (32+ tekens) om tokens versleuteld op te slaan. Verander hem daarna
  niet, anders moeten alle accounts opnieuw worden gekoppeld.
- Draai één instantie: de worker draait in het serverproces. Meerdere instanties zijn veilig
  (atomair claimen), maar SQLite is bedoeld voor één server.
- Maak een back-up van `prisma/dev.db` en de map `storage/`.
