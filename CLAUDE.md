# ClipNova: overdracht voor Claude Code

Lees dit en `README.md` eerst. Leg bij elke wijziging eerst kort uit wat je gaat doen en waarom,
en pas het pas toe als de eigenaar akkoord geeft. Communiceer in het Nederlands.

## Wat ClipNova is

Nederlandstalige AI-clipper als abonnementsdienst. Eén lange video erin, staande 9:16-clips eruit,
met hooktekst + emoji in beeld, woord-voor-woord ondertitels, en per clip titel, beschrijving en
bijschrift met hashtags. Klanten zijn clippers die betaald worden per views via campagnes
(o.a. Content Rewards).

Huidige versie: **v126**. Map heet nog `clipparty`, env-variabelen heten nog `CLIPPARTY_*`
(bewust, zodat oude Docker-commando's werken).

## Vaste keuzes van de eigenaar (niet veranderen zonder te vragen)

- Lettertype overal **TikTok Sans** (zit in `assets/fonts`, SIL OFL).
- Standaardindeling: **volledig beeld in het midden op vage achtergrond** (`video_format="blur"`),
  hooktekst in witte afgeronde balken boven de video, zoals op TikTok.
- Emoji in de hooktekst in **Apple-look** (jsDelivr `emoji-datasource-apple`), fallback Noto.
- De app **zoekt zelf geen video's en leest geen campagneregels van sites**. "Zoek campagnes"
  toont alleen de lijst (via Apify) met een AI-oordeel per niche; mp4 en briefing regelt de klant zelf.
- **Posten naar TikTok/Instagram/Facebook is eruit gehaald** (v124). Niet terugzetten zonder overleg.
- Gezichtsherkenning met namen: bij twijfel géén naam gebruiken.

## Structuur

- `backend/main.py`: FastAPI, runs (`run_job`), alle endpoints, inlogcontrole (`current_user`, `admin_user`, `own_job`).
- `backend/clipper.py`: uitschrijven (Deepgram > Groq > lokaal faster-whisper), momenten kiezen (LLM),
  knippen met ffmpeg, hooktekst (`_render_hook_png`, `HOOK_STYLES`), logo/watermerk (`_render_brand_png`),
  ondertitels (`_write_ass_for_range`), downloaden (yt-dlp/directe link), `process_video`.
  **Let op:** de tweede helft (vanaf `HOOK_SECONDS`) is in v126 opnieuw geschreven omdat het bestand in
  v123–v125 was afgebroken. Alleen getest met een nagemaakt transcript, niet met echte Whisper of AI-sleutel.
- `backend/accounts.py`: SQLite (`storage/clipnova.db`): gebruikers (scrypt), sessies (cookie `cn_session`),
  proefperiode, `PLANS`, gebruik, merk, eigen campagnes, clipcijfers, Mollie-betaling.
- `backend/analytics.py`: cijfers voor het Analytics-scherm.
- `backend/campaign_rules.py`: briefing → regels, bijschriften, regelcontrole.
- `backend/campaign_search.py`: campagnelijst via Apify + AI-rangschikking.
- `backend/people.py`: gezichtenbibliotheek per gebruiker (YuNet + SFace).
- `frontend/index.html`: de hele interface (één bestand, vanilla JS).

## Hoe het nu werkt (v126)

- Eerste account = beheerder (onbeperkt, ziet AI-sleutels, Deepgram, gebruikersbeheer).
- Limiet telt al **clips** (1 clip = 1 credit): proefperiode 7 dagen / 10 clips; Starter €12,99/30,
  Pro €24,99/100, Studio €49,99/300 per 30 dagen. `max_clips` wordt bij de start begrensd op wat er
  nog over is, en na de run worden de echt gemaakte clips afgeschreven. Prijzen en aantallen worden
  vervangen door de tabel hieronder.
- Mollie (`MOLLIE_API_KEY`, `CLIPNOVA_PUBLIC_URL`): losse betaling per 30 dagen. **Nooit getest.**
  Zonder Mollie zet de beheerder abonnementen handmatig aan.
- Klantcijfers (views, likes, uitbetaling) vult de klant zelf in per clip; verdiensten = uitbetaling,
  anders views/1000 × CPM van de gekoppelde campagne.
- Elke run start een eigen thread, zonder wachtrij. Per run knipt hij tot 4 clips tegelijk, met
  ffmpeg-threads = helft van de cores. Lokaal Whisper gebruikt alle cores.
- Bronvideo's worden na een geslaagde run verwijderd (`CLIPNOVA_KEEP_SOURCES=1` om te bewaren).

## Doel: prijzen en credits

Server: gedeelde 16 vCPU, €157,89 per maand incl. btw. Uitvoer altijd 1080x1920.

| Abonnement | Prijs (incl. btw) | Credits (= clips) | Max. lengte bronvideo |
|---|---|---|---|
| Gratis | €0 | 3 per week | 15 min |
| Starter | €20 /mnd | 20 per maand | 20 min |
| Pro | €30 /mnd | 40 per maand | 30 min |
| Business | €50 /mnd | 80 per maand | 60 min |

- **1 credit = 1 gemaakte clip**, ongeacht hoe lang de bronvideo is. Een run maakt nooit meer clips
  dan de klant aan credits heeft; alleen clips die echt gemaakt zijn, kosten een credit.
- De maximale lengte van de bronvideo hangt af van het abonnement. Een langere bron wordt geweigerd
  vóór het uploaden of downloaden.
- **Losse credits bijkopen moet per clip duurder zijn dan een abonnement**, anders koopt niemand een
  abonnement. Abonnementen kosten per clip: Starter €1,00, Pro €0,75, Business €0,63.
  Voorstel (eigenaar beslist de bedragen): **10 credits €12,50** (€1,25 per clip) en
  **30 credits €33,00** (€1,10 per clip), via een losse Mollie-betaling. Het grote pakket is iets
  voordeliger, maar blijft duurder dan elk abonnement.
  Laat bij het kopen zien welk abonnement goedkoper uitkomt ("Met Pro betaal je €0,75 per clip").
  Bijgekochte credits vervallen niet aan het eind van de maand (bevestigen bij de eigenaar).
- **Het gratis abonnement vervangt de proefperiode** van 7 dagen/10 clips (bevestigen bij de eigenaar).
- Netto per abonnement (bruto min 21% btw en ~€0,65–1,15 Mollie): Starter ~€15,88, Pro ~€23,99,
  Business ~€40,17. Break-even op de server: 8 tot 10 betalende gebruikers.
  **Die marge rekent geen AI-kosten mee.** Uitschrijven (Deepgram/Groq) kost per minuut bronvideo,
  ook als er maar 1 clip uit komt; de AI voor momenten en bijschriften kost per video en per clip.
  Meet dit bij de eerste echte runs en reken de marge opnieuw uit. Let vooral op het gratis
  abonnement: 3 clips uit een video van 15 min betekent 15 min uitschrijven.

## Te bouwen, in deze volgorde

1. **Echt testen.** Docker bouwen met volume (`-v clipnova-data:/app/backend/storage`), account maken,
   run met een echte Nederlandse video en een echte AI-sleutel. Controleer: hooktekst, emoji,
   ondertitels, gezicht volgen, bijschriften, regelcontrole met een echte briefing, Analytics.
   Noteer per run de tijd en de AI-kosten.
2. **Git**: privé-repo met `.gitignore` voor `.env`, `backend/storage/`, `*.db`, `__pycache__/`, `*.mp4`, `models/`.
3. **Wachtrij (job queue).** Maximaal 1 à 2 runs tegelijk op de 16 vCPU-server, om geheugentekorten
   (OOM) te voorkomen. Een semafoor of eigen wachtrij-thread in het proces is genoeg; Redis/Celery
   pas bij meerdere servers. Runs die bij een herstart op "bezig" bleven staan, opruimen of opnieuw in de rij zetten.
4. **CPU-limiet per render.** ffmpeg met een vaste `-threads` van 2 à 4 per clip, minder clips tegelijk
   per run (2), en Whisper-threads begrenzen. Reken uit: runs × clips tegelijk × threads ≤ 16.
   Houd preset `veryfast` (nu al zo): `fast` is trager, niet sneller.
   Lokaal Whisper op CPU is traag: gebruik Deepgram of Groq op de server.
5. **Creditmodel** (zie tabel) in `accounts.py`: de nieuwe prijzen en aantallen, bijgekochte credits
   bovenop het abonnement, en het gratis abonnement per week. De afschrijving per gemaakte clip werkt
   al zo; houd dat. Nieuw: lengte van de bron controleren (uploads met ffprobe, links vóór het
   downloaden met `yt-dlp --print duration`) en weigeren boven de limiet van het abonnement.
   Toon de klant vooraf: "Je hebt nog X credits, deze run maakt maximaal X clips".
6. **Frontend**:
   - Prijstabel met de 4 abonnementen (€0, €20, €30, €50), met credits en maximale lengte per kaart,
     plus de twee pakketten losse credits.
   - Creditteller in de header (vervangt de huidige "Proef: x clips"-chip).
   - Wachtrijstatus tijdens het verwerken: "Je video staat op plek 2 in de wachtrij, geschatte wachttijd: 3 minuten".
7. **Mollie**: testen met een testsleutel. Abonnementen als echte terugkerende betaling
   (Mollie customers + mandates + subscriptions), losse credits als eenmalige betaling.
8. **Wachtwoord vergeten** en e-mailadres bevestigen (mailservice zoals Resend, Postmark of SMTP).
   Bij een gratis abonnement is dat ook nodig tegen misbruik met nep-accounts.
9. **Online zetten** achter https (bijv. Caddy op de server). Opslagruimte bewaken.
10. **Juridisch**: algemene voorwaarden, privacyverklaring (AVG: accounts, gezichtsfoto's = biometrie),
    KvK/btw. Apple-emoji zijn van Apple: overweeg `CLIPNOVA_EMOJI_CDN=0` (Noto) voor de betaalde versie.
    Downloaden via yt-dlp van YouTube/Twitch voor klanten is een risico; laat klanten bij voorkeur zelf uploaden.

## Ideeën voor meer klanten (nog niet gebouwd)

- Landingspagina met voorbeeldclips, prijzen en "gratis beginnen".
- Meer hookstijlen en lettertypekeuze per klant; hook opnieuw laten schrijven per clip.
- Views automatisch ophalen zodra er goedgekeurde TikTok/Meta-koppelingen zijn.
- Iemand uitnodigen levert extra credits op.
