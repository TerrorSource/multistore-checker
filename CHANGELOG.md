# Changelog

Versiebeheer: elke aanpassing krijgt een nieuwe **minor** versie (major alleen
bij ingrijpende/brekende wijzigingen). De actieve versie staat in de
projectroot als map `<versienummer>/`; oudere versies worden gearchiveerd in
`../_oldversions/<versienummer>/`.

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
