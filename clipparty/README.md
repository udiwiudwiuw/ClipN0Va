# ClipNova v126

Eén lange video erin, tientallen staande clips eruit: hooktekst met emoji in beeld,
woord-voor-woord ondertitels, en per clip een titel, beschrijving en bijschrift.
Klanten hebben een eigen account met proefperiode, abonnement, merkstijl,
campagnes en analytics.

## Nieuw in v126

- **Clips maken werkt weer.** In v123–v125 was `backend/clipper.py` afgebroken: knippen,
  ondertitels, downloaden en `process_video` ontbraken. Die zijn opnieuw geschreven en getest
  (indelingen: volledig beeld, één beeld, twee boven elkaar, reactie-indeling).
- **Accounts en proefperiode.** Inloggen met e-mail en wachtwoord. Nieuwe gebruikers krijgen
  7 dagen en 10 clips gratis (`CLIPNOVA_TRIAL_DAYS`, `CLIPNOVA_TRIAL_CLIPS`). De eerste
  gebruiker die zich aanmeldt is de **beheerder**: onbeperkt clips, en alleen die ziet de
  AI-sleutels, Deepgram en het gebruikersbeheer.
- **Abonnementen:** Starter €12,99 (30 clips), Pro €24,99 (100), Studio €49,99 (300) per
  30 dagen. Aan te passen in `PLANS` bovenin `backend/accounts.py`.
  - Met `MOLLIE_API_KEY` (en `CLIPNOVA_PUBLIC_URL`, je https-adres) betalen klanten via Mollie
    (iDEAL e.d.); na betaling gaat het abonnement 30 dagen in. Dit is een losse betaling per
    maand, geen automatische incasso. **Nog niet getest met een echte Mollie-sleutel.**
  - Zonder Mollie zet de beheerder het abonnement aan onder Instellingen → Gebruikers.
- **Hookstijlen en eigen merk** (Instellingen): TikTok wit, zwart, merkkleur, omlijnd, geel;
  hooktekst boven of midden; eigen ondertitelkleur; logo rechtsboven; watermerk (@naam).
  Met live voorbeeld. Bij Clippen kun je per run een andere stijl kiezen.
- **Campagnes en verdiensten:** onder Campagnes leg je je campagnes vast met de uitbetaling
  per 1.000 views. Bij Clippen koppel je een run aan een campagne. "Clip hiervoor" bij
  Zoek campagnes zet hem er meteen in.
- **Analytics:** per geposte clip vul je platform, views, likes, reacties, gedeeld, link en
  eventueel de echte uitbetaling in. Analytics toont verdiensten (echte uitbetaling, anders
  views × CPM), views per dag, clips per dag, verdiensten per campagne, welke hookstijl het
  best werkt en alle clips.
  - Views komen niet vanzelf binnen: TikTok en Instagram geven die cijfers alleen via hun
    eigen goedgekeurde API's.
- **TikTok Sans** zit nu in de app zelf (`assets/fonts`, open source, SIL OFL).
- Na een geslaagde run worden de bronvideo's verwijderd (scheelt veel schijfruimte). Bewaren:
  `CLIPNOVA_KEEP_SOURCES=1`.
- Veiliger: geen open CORS meer, runs en clips alleen zichtbaar voor de eigenaar, bestandsnamen
  van uploads worden opgeschoond.

## Starten

```bash
docker build -t clipnova .
docker run -d -p 8000:8000 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e GROQ_API_KEY=... \
  -e APIFY_TOKEN=... \
  -v clipnova-data:/app/backend/storage \
  --restart unless-stopped --name clipnova clipnova
```

Open `http://localhost:8000` en maak meteen je eigen account: de eerste is de beheerder.

**Het volume (`-v clipnova-data:...`) is verplicht**: daar staan de accounts (`clipnova.db`),
de clips, logo's en gezichtenbibliotheken. Zonder volume ben je dat kwijt bij een nieuwe container.

## Instellingen (env)

| Variabele | Waarvoor |
|---|---|
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | AI voor momenten, hooks en bijschriften (klanten gebruiken de sleutels van de server) |
| `DEEPGRAM_API_KEY` | Snelste uitschrijven (of instellen als beheerder in de app) |
| `APIFY_TOKEN` | Campagnes zoeken |
| `MOLLIE_API_KEY`, `CLIPNOVA_PUBLIC_URL` | Online betalen |
| `CLIPNOVA_TRIAL_DAYS`, `CLIPNOVA_TRIAL_CLIPS` | Proefperiode (standaard 7 dagen, 10 clips) |
| `CLIPNOVA_EMOJI_DIR` | Map met eigen emoji-PNG's (naam = hex-code, bijv. `1f62d.png`) |
| `CLIPNOVA_EMOJI_CDN=0` | Geen Apple-emoji van jsDelivr ophalen; dan Noto Color Emoji |
| `CLIPPARTY_WHISPER_MODEL` | `tiny` / `base` / `small` / `medium` voor lokaal uitschrijven |

## Bestanden

- `backend/main.py`: API, runs, accounts-endpoints, analytics-endpoint.
- `backend/clipper.py`: uitschrijven, momenten kiezen, knippen, hooktekst, ondertitels, logo.
- `backend/accounts.py`: gebruikers, proefperiode, abonnementen, merk, campagnes, clipcijfers, Mollie.
- `backend/analytics.py`: berekeningen voor het Analytics-scherm.
- `backend/campaign_rules.py`, `campaign_search.py`, `people.py`: regels, campagnes zoeken, gezichten.
- `frontend/index.html`: de hele interface.
- `assets/fonts`: TikTok Sans.

## Voor je live gaat

- Zet de app achter **https** (bijv. Caddy of een hostingpartij); inlog-cookies worden dan als
  `secure` verstuurd.
- Apple-emoji komen van Apple; voor een betaald product is dat een licentierisico. Met
  `CLIPNOVA_EMOJI_CDN=0` gebruikt de app Noto Color Emoji (vrije licentie).
- Algemene voorwaarden, privacyverklaring (AVG: accounts, gezichtsfoto's) en KvK/btw.
- Wachtwoord vergeten zit er nog niet in (dat vraagt een mailserver); de beheerder kan
  een account niet resetten via de app.
