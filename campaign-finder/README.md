# ClipNova Campaign Video Finder

Vindt lange bronvideo's voor clipcampagnes en laat AI per video inschatten hoe goed hij past
en hoeveel clippotentie erin zit, met concrete fragmenten (`02:15 - 03:45`) en een onderbouwing.
Goedkeuren en afwijzen voedt een feedback-loop die de volgende beoordelingen van die campagne stuurt.

**Werkt direct na installatie.** Zonder sleutels draait de app op de ingebouwde **Demo Data
Engine** (realistische video's, metadata en transcripts) en een **heuristische analyse**.
Met sleutels gebruikt hij de YouTube Data API v3 en OpenAI of Anthropic.

## Snel starten

Vereist: Node.js 18.18+ (getest met 22).

```bash
cd campaign-finder
npm install
cp .env.example .env        # optioneel
npx prisma db push          # maakt prisma/dev.db aan
npm run db:seed             # optioneel: 2 demo-campagnes met een eerste zoekronde
npm run dev                 # http://localhost:3001
```

De Posting Bot in deze repo draait op poort 3000, deze app op **3001**; ze kunnen naast elkaar draaien.
Productie: `npm run build && npm start`.

## Testen

```bash
npm test                    # vitest: zoekmachine, dedup, analyse, feedback, planner, export
npm run test:engine         # zoeken + AI-analyse op de command line (schrijft niets weg)
npm run test:engine -- --keywords "podcast,geld" --people "Sam" --lang nl --min 5 --max 90 --exclude crypto --limit 3
```

Of in de browser: `http://localhost:3001/api/test?keywords=podcast,geld&people=Sam&lang=nl&limit=3`.
De testroute geeft per video de feitelijke metadata en de AI-schatting apart terug.

Deze twee gebruiken je echte `.env`. Met een YouTube- of AI-sleutel kost dat dus quotum en tokens.

## Functies

- **Campagnes (CRUD)**: naam, merk/creator, beschrijving, doelgroep, toegestane bronnen
  (kanaal-URL's, @handles, losse video's), zoekwoorden, personen, onderwerpen, taal, min/max
  lengte, regels, gebruiksrechten, uitgesloten onderwerpen, actief en automatisch zoeken.
- **Zoeken**: per zoekronde verzamelen, filteren op lengte, dedupliceren (op `platform + video-id`
  én URL, binnen de ronde en over rondes en campagnes heen) en direct analyseren. Rondes lopen via
  een in-memory wachtrij (één tegelijk, één per campagne). De voortgang en het log zie je live op
  het dashboard.
- **Automatisch zoeken**: elke 5 minuten kijkt een planner (node-cron) welke actieve campagnes
  volgens hun interval (elk uur … wekelijks) aan de beurt zijn.
- **AI-analyse per video**:
  - *Match score* (0-100): past de video bij de campagne?
  - *Clip score* (0-100): geschikt voor TikTok, Shorts en Reels?
  - Een oordeel (geschikt, twijfel of ongeschikt), een onderbouwing en regelovertredingen.
  - *Fragmenten* met start, eind, reden en hook.
- **Feiten vs. schattingen**: de UI, de detailweergave en de export scheiden feitelijke metadata
  (van het platform) van wat de AI schat. Demo-video's zijn overal als *demo* gemarkeerd.
- **Dashboard**:
  - Campagnekiezer en een filter- en sorteerbalk (platform, taal, min. match/clip score, status, bron).
  - Kaarten met thumbnail, scores, fragmenten en 👍/👎.
  - Een detailweergave met het transcript, waarin de voorgestelde fragmenten gemarkeerd zijn.
  - Eigen notities per video.
- **Feedback-loop**: geef bij afwijzen of goedkeuren een reden. Voeg daarnaast campagneregels toe:
  *Meer van*, *Vermijden* of een vrije *Instructie*. Alles wat actief is gaat mee in elke volgende
  analyse: in de LLM-prompt, en in de heuristiek als boni en mali. Met **Herbeoordelen** scoor je
  bestaande nieuwe video's opnieuw.
- **Export**: goedgekeurde video's als CSV (Excel-vriendelijk, beschermd tegen formule-injectie) of JSON.

## Bronnen en providers

| Instelling | Gedrag |
|---|---|
| `SEARCH_MODE=auto` (standaard) | YouTube API als `YOUTUBE_API_KEY` er is; anders RSS-feeds voor kanaalbronnen plus demo-data |
| `SEARCH_MODE=youtube` / `rss` / `mock` | Forceer één bron |
| `AI_PROVIDER=auto` (standaard) | OpenAI als `OPENAI_API_KEY` er is, anders Anthropic, anders heuristiek |
| `AI_PROVIDER=openai` / `anthropic` / `heuristic` | Forceer een provider |

- **YouTube Data API v3**: zoekt per zoekwoord/persoon en binnen opgegeven kanalen, en haalt
  daarna duur, statistieken en tags op. Een zoekopdracht kost 100 quota-eenheden (dagquotum
  10.000), dus de app doet maximaal 4 vrije zoekopdrachten plus één per kanaal per ronde.
  Captions zijn via de API alleen beschikbaar voor de eigenaar van de video. Bij echte video's
  analyseert de AI daarom titel, beschrijving, tags en hoofdstukken (`00:00 Intro` in de
  beschrijving).
- **RSS**: de openbare kanaalfeeds (laatste ~15 uploads, geen sleutel nodig, zonder duur).
- **OpenAI**: `gpt-4o-mini` met Structured Outputs (strikt JSON Schema).
- **Anthropic**: `claude-opus-5-5` (aan te passen met `ANTHROPIC_MODEL`), met een verplichte
  tool-call als gestructureerde output.
- **Validatie**: elke AI-uitkomst wordt nagekeken. Scores worden begrensd op 0-100, fragmenten
  moeten binnen de video vallen, mogen max. 3 minuten zijn en eindigen na hun start. Faalt een
  provider, dan valt de analyse terug op de heuristiek; de fout zie je in de detailweergave.

## Projectstructuur

```
campaign-finder/
├─ prisma/schema.prisma        Campaign, Video, CampaignVideo, Feedback, SearchRun (SQLite)
├─ prisma/seed.ts              demo-campagnes
├─ scripts/test-engine.ts      CLI-test voor zoeken + analyse
├─ src/instrumentation.ts      start de planner
├─ src/lib/
│  ├─ search/                  youtube.ts, rss.ts, mock.ts (Demo Data Engine), engine.ts (ronde: zoeken → dedup → opslaan → analyseren)
│  ├─ ai/                      prompt.ts, providers.ts (OpenAI/Anthropic), heuristic.ts, types.ts (schema + validatie), analyze.ts
│  ├─ queue.ts, scheduler.ts   wachtrij en periodiek zoeken
│  └─ matches.ts, export.ts, config.ts, campaign-schema.ts
├─ src/app/                    dashboard, campagnebeheer, api/ routes
└─ tests/                      vitest-suite
```

## API (kort)

| Route | Doel |
|---|---|
| `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id` | Campagnebeheer |
| `POST /api/campaigns/:id/search` · `GET` voor de laatste rondes | Zoekronde starten / voortgang |
| `GET /api/campaigns/:id/videos?status=&language=&minScore=&minClipScore=&source=&sort=match\|clip\|date\|found&q=` | Gefilterde resultaten |
| `PATCH /api/matches/:id` `{status, reason, notes}` | Goedkeuren/afwijzen (wordt feedback) |
| `POST /api/matches/:id/analyze`, `POST /api/campaigns/:id/reanalyze` | (Her)analyseren |
| `GET/POST /api/campaigns/:id/feedback`, `PATCH/DELETE /api/feedback/:id` | Feedback-regels |
| `GET /api/campaigns/:id/export?format=csv\|json&status=approved` | Export |
| `GET /api/test?…` | Zoeken + analyse testen zonder opslaan |
| `GET /api/status` | Actieve bron/provider en wachtrij |

## Voor je online gaat

- De app heeft geen login. Draai hem lokaal of zet hem achter een reverse proxy met authenticatie.
- Draai één instantie: de wachtrij en de planner leven in het serverproces.
- De echte YouTube- en LLM-koppelingen volgen de officiële documentatie, maar zijn niet getest met
  echte sleutels. Probeer ze eerst met `npm run test:engine`.
