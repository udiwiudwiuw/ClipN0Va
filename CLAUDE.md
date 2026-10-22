# ClipNova: overdracht voor Claude Code

Lees dit en `README.md` eerst. Leg bij elke wijziging eerst kort uit wat je gaat doen en waarom,
en pas het pas toe als de eigenaar akkoord geeft. Communiceer in het Nederlands.

## Wat ClipNova is

Nederlandstalige AI-clipper als abonnementsdienst. Eén lange video erin, staande 9:16-clips eruit,
met hooktekst + emoji in beeld, woord-voor-woord ondertitels, en per clip titel, beschrijving en
bijschrift met hashtags. Klanten zijn clippers die betaald worden per views via campagnes
(o.a. Content Rewards).

Huidige versie: **v127**. Map heet nog `clipparty`, env-variabelen heten nog `CLIPPARTY_*`
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
- **De proefperiode blijft** (7 dagen / 10 clips), met **max. 15 minuten bronvideo per run**
  (alle video's van één run samen). Het gratis abonnement komt er niet voor in de plaats.
- **Bijgekochte credits vervallen niet**: ze blijven staan tot ze op zijn.
- API-sleutels **nooit in de code of de repo**. De beheerder vult ze één keer in de app in
  (`storage/keys.json` op het volume, zie `service_key` in `clipper.py`); env-variabelen zijn reserve.

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

## Hoe het nu werkt (v127)

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
- Bronvideo's worden na elke run verwijderd, ook na een mislukte (`CLIPNOVA_KEEP_SOURCES=1` om te bewaren).
- Sleutels (Groq, Deepgram, Anthropic, OpenAI) en de AI-aanbieder stelt de beheerder in onder
  Instellingen; klanten kiezen de aanbieder niet zelf.
- Maximale lengte van de bron per abonnement: `max_minutes` in `PLANS` (`accounts.py`). Nu alleen
  de proefperiode: 15 min (`CLIPNOVA_TRIAL_MAX_MINUTES`). Gecontroleerd in de browser vóór het uploaden,
  op de server bij uploads (ffprobe) en links (`yt-dlp --print duration`), en na het downloaden.

## Doel: prijzen en credits

Server: gedeelde 16 vCPU, €157,89 per maand incl. btw. Uitvoer altijd 1080x1920.

| Abonnement | Prijs (incl. btw) | Credits (= clips) | Max. lengte bronvideo |
|---|---|---|---|
| Proefperiode | €0 | 10 in 7 dagen | 15 min (gebouwd in v127) |
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
  **Bijgekochte credits vervallen niet** (besloten door de eigenaar): ze blijven staan tot ze op zijn,
  ook als het abonnement afloopt. Voorstel (bevestigen bij de eigenaar): eerst de credits van het
  abonnement gebruiken, dan de bijgekochte.
- **De proefperiode blijft** (besloten door de eigenaar): er komt geen gratis abonnement van 3 per week.
- Netto per abonnement (bruto min 21% btw en ~€0,65–1,15 Mollie): Starter ~€15,88, Pro ~€23,99,
  Business ~€40,17. Break-even op de server: 8 tot 10 betalende gebruikers.
  **Die marge rekent geen AI-kosten mee.** Uitschrijven (Deepgram/Groq) kost per minuut bronvideo,
  ook als er maar 1 clip uit komt; de AI voor momenten en bijschriften kost per video en per clip.
  Meet dit bij de eerste echte runs en reken de marge opnieuw uit. Let vooral op de
  proefperiode: elke nieuwe gebruiker kost tot 15 min uitschrijven per run zonder dat er iets tegenover staat.

## Te bouwen, in deze volgorde

1. **Echt testen.** Docker bouwen met volume (`-v clipnova-data:/app/backend/storage`), account maken,
   run met een echte Nederlandse video en een echte AI-sleutel. Controleer: hooktekst, emoji,
   ondertitels, gezicht volgen, bijschriften, regelcontrole met een echte briefing, Analytics.
   Noteer per run de tijd en de AI-kosten.
2. ~~**Git**~~ Klaar (v127): code staat los in `clipparty/`, met `.gitignore`. Controleer zelf of de repo op GitHub privé staat.
3. **Wachtrij (job queue).** Maximaal 1 à 2 runs tegelijk op de 16 vCPU-server, om geheugentekorten
   (OOM) te voorkomen. Een semafoor of eigen wachtrij-thread in het proces is genoeg; Redis/Celery
   pas bij meerdere servers. Runs die bij een herstart op "bezig" bleven staan, opruimen of opnieuw in de rij zetten.
4. **CPU-limiet per render.** ffmpeg met een vaste `-threads` van 2 à 4 per clip, minder clips tegelijk
   per run (2), en Whisper-threads begrenzen. Reken uit: runs × clips tegelijk × threads ≤ 16.
   Houd preset `veryfast` (nu al zo): `fast` is trager, niet sneller.
   Lokaal Whisper op CPU is traag: gebruik Deepgram of Groq op de server.
5. **Creditmodel** (zie tabel) in `accounts.py`: de nieuwe prijzen en aantallen, bijgekochte credits
   bovenop het abonnement; de proefperiode blijft zoals hij is. De afschrijving per gemaakte clip werkt
   al zo; houd dat. De lengtecontrole is gebouwd (v127): vul alleen `max_minutes` in voor de nieuwe
   abonnementen (20/30/60 min).
   Toon de klant vooraf: "Je hebt nog X credits, deze run maakt maximaal X clips".
6. **Frontend**:
   - Prijstabel met de 4 abonnementen (€0, €20, €30, €50), met credits en maximale lengte per kaart,
     plus de twee pakketten losse credits.
   - Creditteller in de header (vervangt de huidige "Proef: x clips"-chip).
   - Wachtrijstatus tijdens het verwerken: "Je video staat op plek 2 in de wachtrij, geschatte wachttijd: 3 minuten".
7. **Mollie**: testen met een testsleutel. Abonnementen als echte terugkerende betaling
   (Mollie customers + mandates + subscriptions), losse credits als eenmalige betaling.
8. **Wachtwoord vergeten** en e-mailadres bevestigen (mailservice zoals Resend, Postmark of SMTP).
   Bij de gratis proefperiode is dat ook nodig tegen misbruik met nep-accounts.
9. **Online zetten** achter https (bijv. Caddy op de server). Opslagruimte bewaken.
10. **Juridisch**: algemene voorwaarden, privacyverklaring (AVG: accounts, gezichtsfoto's = biometrie),
    KvK/btw. Apple-emoji zijn van Apple: overweeg `CLIPNOVA_EMOJI_CDN=0` (Noto) voor de betaalde versie.
    Downloaden via yt-dlp van YouTube/Twitch voor klanten is een risico; laat klanten bij voorkeur zelf uploaden.

## Onderscheidende functies (gekozen door de eigenaar, bouwen na stap 1–6)

Doel: ClipNova is de tool die gebouwd is om **uitbetaald te krijgen**, in het Nederlands.
Geen van deze functies heeft een TikTok- of Meta-koppeling nodig.

### A. Afkeur-check vóór het posten
- Bouwt op de bestaande regelcontrole (`campaign_rules.check_compliance`).
- Per clip één duidelijk oordeel in gewone taal: "Wordt waarschijnlijk afgekeurd: disclosure ontbreekt,
  clip is 2 s te kort" of "Klaar om te posten".
- Per probleem een knop **Repareer** die het oplost waar dat kan: disclosure/hashtags/tags in het
  bijschrift zetten, clip verlengen tot de minimale duur, verplichte tekst in de hook.
- Wat de app niet kan controleren (bron, platform, looptijd) als afvinklijstje tonen.

### B. "Wat werkt bij jou"-advies
- Uit de eigen analytics: welke hookstijl, emoji, cliplengte, onderwerp en campagne de meeste
  views en verdiensten per clip opleveren. Bijv. "Je hooks met 😱 halen 2,3× meer views",
  "Gaming levert je €0,31 per clip op, business €0,04".
- Pas tonen bij genoeg gegevens (bijv. minstens 5 geposte clips per groep), met het aantal clips erbij.
  Geen verzonnen zekerheid: het zijn patronen in de eigen cijfers.
- Optioneel: de AI gebruikt dit als voorkeur bij het schrijven van nieuwe hooks.
- Extra cijfers per clip om in te vullen (staan in TikTok-analytics): **gem. kijkduur, % helemaal
  bekeken, saves**. Adviezen meten primair op **voltooiing en shares, niet op likes**.

### C. Campagne-waakhond
- Op de achtergrond (bijv. elk uur) de campagnelijst ophalen (Apify, met cache) en per gebruiker
  vergelijken met diens niche.
- Meldingen: "Nieuwe campagne in jouw niche: €1,50 per 1.000 views" en "Budget van Lacy IRL is
  bijna op, post vandaag nog".
- Eerst in de app (bel-icoon met lijst), daarna per e-mail; telefoonmeldingen via web push later.
- Per gebruiker instelbaar: niche, minimale CPM, aan/uit.

### D. Groeigids voor een nieuw clip-account
Een tabblad "Groeien" met een stappenplan per clip-account (een klant kan meerdere accounts hebben,
per platform en niche).

**Opwarmen (dag 1–7), als dagelijkse checklist met voortgang:**
- Dag 1–3: niet posten. 20–30 min per dag alleen naar je niche kijken, video's helemaal uitkijken,
  2–5 relevante accounts volgen.
- Dag 3–5: blijven kijken, 10–15 video's liken per sessie, 3–5 echte reacties (geen losse emoji).
- Dag 5–7: 1 video per dag posten, elke dag blijven kijken en reageren.
- Niet doen: plotselinge pieken in liken, volgen of posten; massaal volgen; van niche wisselen;
  vaak van apparaat of netwerk wisselen; in het begin automatiseren.
- Tekst in de app: dit zijn ervaringsregels uit de clipwereld, geen officiële regels van TikTok.

**Hoe een video viraal gaat (uitleg in de gids):**
1. Testronde: TikTok toont de video eerst aan een klein publiek.
2. Meting: eerst kijkduur en voltooiing, dan rewatches, shares, saves en comments, pas daarna likes.
3. Uitbreiding: bij sterke signalen naar een groter, vergelijkbaar publiek; dit herhaalt zich en kan
   langer dan 24 uur duren. Een video die eerst stilligt, kan later nog doorbreken.
- Volgers doen er weinig toe: een nieuw account kan viraal gaan.
- De eerste 3 seconden en het eerste uur beslissen het meest: daarom zijn hook en in-punt zo belangrijk.

**Viraal blijven (tips, met koppeling aan de app):**
- In één niche blijven: de app waarschuwt als iemand clips voor een andere niche maakt op hetzelfde account.
- 2–5 keer per week posten met hoge kwaliteit; de app toont het postritme per account.
- Een vervolg maken op wat werkte: link naar het advies uit B.
- **Eerste-uur-timer:** zodra een clip als gepost wordt gemarkeerd, toont de app 60 minuten lang
  "Reageer nu op comments: nog 42 min".
- Meten op voltooiing en shares, niet op likes (zie B).

### E. Gegevens ophalen uit Content Rewards (Whop) en ClipArmy (alleen lezen)
Keuze van de eigenaar: **klanten leveren zelf in** op die platforms. ClipNova haalt alleen gegevens
op, zodat Analytics de echte status toont. ClipNova levert niets in en post niets.

**Content Rewards via de Whop-API (bèta):**
- Klant koppelt met "Inloggen met Whop" (OAuth), scope **`bounty:basic:read`**. Tokens versleuteld
  per gebruiker opslaan, ontkoppelen moet altijd kunnen.
- `GET` List Bounty Submissions (docs.whop.com → API reference → beta → bounty-submissions) geeft
  per inzending: `id`, `bounty_id`, `status` (`submitted`/`approved`/`denied`), `deliverable_urls`
  (de postlink), `denial_reason`, `submitted_at`, `resolved_at`. Retrieve Bounty geeft de campagne.
- Koppelen aan ClipNova-clips via de postlink: `deliverable_urls` tegen het veld `post_url` per clip.
  Wat niet matcht: tonen als "inzending zonder ClipNova-clip".
- In Analytics tonen: ingediend / goedgekeurd / afgekeurd per clip en per campagne, met de
  afkeurreden. Afkeurredenen ook gebruiken in de afkeur-check (A) en het advies (B).
- **Views en uitbetaling zitten niet in deze API.** Die blijven handmatig, of later via een andere bron.
- **Eerst controleren voordat je bouwt:** test met het eigen Whop-account van de eigenaar of
  Content Rewards-inzendingen echt in deze bounty-API verschijnen. Zo niet: stoppen en melden.
  Eigenaar maakt hiervoor een Whop-developer-app aan (client ID/secret, redirect-URL).

**ClipArmy (cliparmy.nl):** Nederlands clipplatform, geen openbare API gevonden.
Wat een clipper in ClipArmy ziet (van screenshots van de eigenaar):
- Profiel: totaal views, lifetime earned, aantal gekoppelde social accounts.
- Wallet: saldo, vandaag / 7 dagen / 30 dagen, "x clips earning right now", dagelijks bijgewerkt.
- Locked (escrow): bedrag, aantal clips, ± 7 dagen. Withdrawable: bedrag, minimum €25.
- Per clip ("Mijn inzendingen" / "Your money-making clips"): campagnenaam, postlink (TikTok of
  YouTube Shorts), platform, **views**, **earnings**, "bijgewerkt x geleden", slotje = nog locked.

Bouwen in deze volgorde:
1. **Eigenaar vraagt ClipArmy** om een API, een export (CSV) of partnertoegang. Is die er, gebruik die.
2. **Tot die tijd: import door de klant zelf.** Op de pagina "Mijn inzendingen" alles selecteren en
   kopiëren, en in ClipNova plakken bij "Gegevens uit ClipArmy". ClipNova leest daar per clip de
   campagne, postlink, views en earnings uit (en het wallet-overzicht als dat erbij staat).
   Laat de eigenaar eerst een echte plakselectie aanleveren als testbestand, en bouw de lezer daarop.
   Robuust maken: herken postlinks met een regex, getallen in Nederlandse notatie (88.636, € 27,05).
3. **Koppelen aan ClipNova-clips via de postlink** (veld `post_url` per clip). Links normaliseren:
   TikTok op video-ID (`/video/123…`), YouTube Shorts op video-ID; korte links (vm.tiktok.com) zo
   mogelijk opslaan zoals de klant ze invult. Geen match: tonen als "inzending zonder ClipNova-clip"
   met een knop om hem aan een clip te koppelen.
4. **In Analytics:** views en earnings uit ClipArmy hebben voorrang op handmatige cijfers en op de
   schatting via CPM. Toon bron en tijdstip ("ClipArmy, bijgewerkt 22 okt 14:05") en locked/vrij.
   Totaaloverzicht per platform: ClipArmy, Content Rewards, handmatig.
5. Herinnering in de app: "Je ClipArmy-cijfers zijn 3 dagen oud, plak ze opnieuw."

**Nooit:** met de wachtwoorden van klanten inloggen of hun browser nabootsen (scrapen).
Dat is tegen de voorwaarden van die platforms; klanten kunnen hun account en uitbetalingen kwijtraken.

## Ideeën voor later (nog niet gebouwd)

- Landingspagina met voorbeeldclips, prijzen en "gratis beginnen".
- Meer hookstijlen en lettertypekeuze per klant; hook opnieuw laten schrijven per clip.
- Views automatisch ophalen zodra er goedgekeurde TikTok/Meta-koppelingen zijn.
- Iemand uitnodigen levert extra credits op.
