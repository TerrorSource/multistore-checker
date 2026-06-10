# Changelog

Versiebeheer: elke aanpassing krijgt een nieuwe **minor** versie (major alleen
bij ingrijpende/brekende wijzigingen). De actieve versie staat in de
projectroot als map `<versienummer>/`; oudere versies worden gearchiveerd in
`../_oldversions/<versienummer>/`.

## [1.12.0] — 2026-06-10

### Gewijzigd
- **Bot-tokens zijn weer volledig zichtbaar** in het dashboard (op verzoek):
  het token staat gewoon als waarde in het veld, net als de chat-ID. De
  "leeg laten = behouden"/keepIndex-constructie uit 1.7.0–1.11.0 is daarmee
  vervallen; opslaan stuurt simpelweg alle rijen (`{ botId, chatId }`) op.
- Let op: iedereen die het dashboard kan openen kan de tokens nu ook lezen —
  houd de poort LAN-only.

## [1.11.0] — 2026-06-10

### Opgelost
- Na het opslaan van een Telegram-ontvanger oogde het token-veld als "niet
  opgeslagen" (het veld wordt bewust geleegd omdat tokens nooit terug naar de
  browser gaan). Rijen met een opgeslagen token tonen nu duidelijk
  "✓ Opgeslagen: 123456...XYZ — leeg laten = behouden" in groen.
- Bij een mislukte save (validatiefout) werd de ingevulde token/chat-ID-invoer
  gewist; de invoer blijft nu staan zodat niets verloren gaat.
- Een achtergrond-herlading (bv. "Verbinding hersteld") wist niet langer
  ontvanger-velden waar de gebruiker nog in aan het typen is.

## [1.10.0] — 2026-06-10

### Toegevoegd
- **Meerdere Telegram-ontvangers**: in het dashboard kunnen nu meerdere
  bot-token/chat-ID-paren worden ingevuld (rijen toevoegen/verwijderen); elke
  melding en elk testbericht gaat naar álle ontvangers. Config-veld
  `telegramTargets` (lijst van `{ botId, chatId }`); de oude losse
  `botId`/`chatId` worden bij het opstarten automatisch gemigreerd naar de
  eerste ontvanger.
- "Test Telegram" rapporteert per ontvanger of het bericht aankwam en nummert
  de testberichten (`ontvanger 1/2`).

### Beveiliging
- Tokens blijven server-side: per rij wordt alleen een gemaskeerde weergave
  getoond; veld leeg laten = opgeslagen token behouden (zoals sinds 1.7.0).

## [1.9.0] — 2026-06-10

### Toegevoegd
- Het aantal dagen waarna een afwezig product weer als nieuw wordt gemeld is
  nu instelbaar via het dashboard (veld "Opnieuw melden na afwezigheid van
  (dagen)", config-veld `onlyNewDays`, standaard 7, minimaal 1).

## [1.8.0] — 2026-06-10

### Gewijzigd
- "Alleen nieuwe producten melden": een product wordt na **7 dagen** afwezigheid
  uit de zoekresultaten weer als nieuw gemeld (was 60 dagen).

## [1.7.0] — 2026-06-10

### Opgelost
- **Telegram-limiet**: lange productlijsten worden opgesplitst in meerdere
  berichten (limiet 4096 tekens); de Telegram-API-respons wordt nu
  gecontroleerd en fouten worden gelogd i.p.v. stil genegeerd.
- **Scheduler**: cron-vertaling vervangen door een setTimeout-keten. Elk
  interval in minuten werkt nu exact (90, 35, >24u — voorheen ongeldig of
  misleidend), en de volgende run start pas na afloop van de vorige.
  Dependency `node-cron` verwijderd.
- **Token-lek**: `/api/config` stuurt het bot-token niet meer naar de browser;
  alleen een gemaskeerde weergave. In de UI: veld leeg laten = token behouden.
- **Validatie**: `sitesEnabled` wordt server-side gevalideerd (array + alleen
  bekende sites).
- Verouderd UI-label "Trekpleister altijd" bij het voorraadfilter gecorrigeerd.
- Product-links in Telegram-berichten worden attribuut-ge-escaped (`&`, `"`),
  zodat een afwijkende URL niet het hele bericht laat afkeuren.
- Spartacus: producten zonder `price`-object tellen nu ook als "geen prijs".
- Dashboard: nette foutafhandeling bij onbereikbare server (toast + "Offline"),
  logs/resultaten worden HTML-ge-escaped, knoppen herstellen altijd.
- Docker-healthcheck respecteert de `PORT`-omgevingsvariabele.

### Toegevoegd
- **Alleen nieuwe producten melden** (instelbaar, standaard uit): geplande
  checks melden alleen producten die nog niet eerder gemeld zijn (geheugen in
  `/config/seen.json`, vergeten na 60 dagen afwezigheid). Handmatige checks
  tonen altijd alles, met 🆕-markering bij nieuwe vondsten.
- CI-workflow bouwt nu ook **versie-tags** (`v1.7.0` → image `:1.7.0` en
  `:1.7`) en **multi-arch** (linux/amd64 + linux/arm64).
- `package-lock.json` gecommit en build via `npm ci` → reproduceerbare builds.
- `engines: node >=20` in package.json (global fetch vereist).

### Gewijzigd
- Telegram-berichten zonder grote linkpreview (`disable_web_page_preview`).
- Browser-headers bijgewerkt naar Chrome 136.
- Pauze tussen sites alleen nog tússen sites (bericht wordt direct verstuurd).

## [1.6.0] — 2026-06-09

### Toegevoegd
- Versienummer wordt nu meegestuurd in het Telegram-testbericht
  (`✅ Testbericht vanuit de Multistore Docker Checker! (v1.6.0)`).
- Versienummer wordt onderaan het dashboard getoond (footer), opgehaald via een
  nieuw `version`-veld in de `/api/status`-respons. `server.js` leest de versie
  uit `package.json`.

### Beveiliging
- `.gitignore` en `.dockerignore` negeren nu de volledige `config/`- en `data/`-
  mappen, zodat `config/config.json` (met bot-token) niet in Git of de Docker-
  image terechtkomt.

## [1.5.0] — 2026-06-09

### Gewijzigd
- **Filter omgezet van "bestelbaar" naar "op voorraad".** Een product zonder
  prijs is per definitie niet bestelbaar (Kruidvat geeft zelf `purchasable:
  false`), dus die filter leverde voor gratis producten vrijwel altijd niets
  op. Het zinnige signaal is voorraad. Config-veld `onlyPurchasable` →
  `onlyInStock` (bestaande config wordt automatisch gemigreerd in `server.js`).
- **Trekpleister-voorraad** wordt nu gelezen uit het server-side gerenderde
  `data-item-in-stock`-attribuut in de zoekresultaten (`inStock`/`outOfStock`).
  Dit is consistent met de bestelbaarheid op de zoekpagina (de add-to-cart
  krijgt server-side het `out-of-stock`-attribuut) en dus betrouwbaar om op te
  filteren. (De productpagina zelf rendert de voorraad client-side via JS en is
  daarvoor níet bruikbaar.)
- **Kruidvat-voorraad** wordt bepaald uit `inStockFlag` (de echte online-
  beschikbaarheid), NIET uit `stock.stockLevelStatus`/`stockLevel` — dat laatste
  is magazijndata en kan misleidend "inStock"/>0 zijn terwijl het product op de
  site "Niet op voorraad" is.
- Telegram-bericht toont nu `(voorraad: op voorraad / niet op voorraad /
  onbekend)` i.p.v. een (onbetrouwbaar) voorraadgetal, en zonder de
  (verwijderde) bestelbaar-indicatie.
- Dashboard: label "Alleen bestelbare producten" → "Alleen producten op
  voorraad".

## [1.4.0] — 2026-06-09

### Gewijzigd
- **Kruidvat NL & BE**: aangepast aan het nieuwe Spartacus-platform. De
  productdata wordt nu uit de server-side gerenderde `spartacus-app-state`
  JSON in de zoekpagina gehaald in plaats van uit de oude HTML-tegels.
- **Kruidvat BE**: zoek-URL gebruikt nu de `/nl/` locale-prefix (voorkomt een
  301-redirect).
- **Zoek-URL's** voor Kruidvat aangepast naar het nieuwe formaat
  (`/search/:price-asc?query=...&sortCode=price-asc`).
- Voorraad en bestelbaarheid komen nu rechtstreeks uit de zoekpagina; de losse
  per-product OCC API-calls zijn verwijderd (die zitten achter Akamai Bot
  Manager en gaven `403`). Dit maakt een check ook flink sneller — geen 500 ms
  pauze per product meer.

### Hersteld / opgeruimd
- `server.js` ontbrak lokaal en is opgehaald uit de GitHub-repo
  (`TerrorSource/multistore-checker`, branch `main`). Compatibel met de huidige
  `scraper.js`. De map is daarmee weer compleet en lokaal bouwbaar.
- Mappenstructuur opgeschoond: de actieve versie staat nu in de root als map
  `1.4.0/`; de oude snapshots (`v1`, `v2`, `v3`) en `1.3.0` staan in
  `../_oldversions/`.
- Dockerfile-healthcheck gesynct met de repo: gebruikt nu `node -e fetch`
  i.p.v. busybox-`wget` (geen externe afhankelijkheid, start-period 10s).
- `docker-compose.local.yml` toegevoegd voor lokaal bouwen/testen (bouwt de
  lokale Dockerfile i.p.v. de GHCR-image te pullen, en gebruikt `./config`).
  De bestaande `docker-compose.yml` blijft de productie/NAS-config.

### Ongewijzigd
- **Trekpleister** draait nog op het oude platform en wordt nog steeds met
  Cheerio uit de HTML geparset (`.product__list-col` / "Geen prijs aanwezig"),
  nu met voorraadstatus uit de `e2-impression-tracker` data-attributen.
- Config-structuur en Telegram-uitvoer zijn compatibel gebleven.

## [1.3.0]

Laatste versie vóór de platformwijziging van Kruidvat. Gearchiveerd in
`_oldversions/1.3.0/`. Gebruikte HTML-scraping van `.product__list-col` voor
alle drie de sites plus een per-product API-call (`/api/v2/...`) voor voorraad
en bestelbaarheid.
