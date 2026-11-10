# Multistore Checker

Docker-container die producten van de A.S. Watson-drogisterijen — **Kruidvat
NL**, **Kruidvat BE**, **Trekpleister** en **ICI PARIS XL** — volgt en een
Telegram-bericht stuurt zodra een gevolgd product in de aanbieding is (1+1
gratis, 2e halve prijs, X% korting of een afgeprijsde prijs).

## Upgraden vanaf v1.x

De upgrade is volledig automatisch — gebruikers hoeven niets opnieuw in te
stellen:

- Een bestaande `config.json` van v1.x wordt bij de eerste start herkend en
  gemigreerd: de Telegram-ontvangers (ook het oude losse botId/chatId-veld),
  het interval, de actief-status, de sites en alle filters verhuizen naar de
  **gratis-producten-checker** (dat was immers de hele functie van v1). De
  nieuwe aanbiedingen-watcher begint uitgeschakeld.
- `seen.json` (geziene gratis producten) wordt ongewijzigd overgenomen.
- Een volume dat nog op `/config` gemount staat (zoals in alle
  v1.x-compose-files) wordt automatisch herkend; de compose-file hoeft niet
  aangepast te worden. Nieuwe installaties gebruiken `/data`.

## Functies

- **Zoeken** (hoofdpagina): producten zoeken op naam of productcode, per
  winkel (Kruidvat NL/BE, Trekpleister, ICI PARIS XL), met statusbalk en een
  filter om producten die niet op voorraad zijn ook te tonen (standaard
  verborgen), een prijsfilter (van – tot), filters op merk en op actie van de
  winkel, en sorteren op relevantie of prijs. Al deze filters past de winkel
  zelf toe, dus het aantal gevonden resultaten klopt voor het hele resultaat.
  Per zoekopdracht tot 100 resultaten, met "Meer laden" voor de volgende 100;
  boven de resultaten staat hoeveel er gevonden, geladen en getoond zijn. Het
  laatste zoekresultaat (incl. filters) blijft staan als je naar een andere
  pagina gaat en terugkomt (bewaard per browsertabblad)
- **Actie-categorieën**: elke aanbieding wordt ingedeeld in een categorie
  (1+1 / X+Y gratis, 2e halve prijs, % korting, afgeprijsd, overig) waarop je
  in de geladen zoekresultaten kunt filteren. "Gratis verzending" telt niet als
  actie: producten met alleen dat label worden niet als aanbieding getoond
  of gemeld
- **Gevolgde producten** (eigen pagina): producten markeren om te volgen, met
  actuele prijs, aanbieding en voorraadstatus
- **Instellingen** (eigen pagina): Telegram-ontvangers, scan-instellingen,
  gratis-producten-checker en logs
- **Telegram-notificaties** bij een nieuwe aanbieding (meerdere ontvangers
  mogelijk); dezelfde actie wordt maar één keer gemeld
- **Gratis producten checker** (uit de multistorechecker): zoekt op alle
  drie de winkels naar producten zonder prijs ("Geen prijs aanwezig") en
  meldt die via Telegram, met eigen interval en filters. Per product staat
  erbij of het écht te bestellen is: *op voorraad* (bestelbaar), *niet
  bestelbaar (geen prijs)* (de winkel weigert artikelen zonder prijs
  server-side, ook als er voorraad is) of *niet op voorraad*
- **Status per winkel** op elke pagina: wanneer het laatste verzoek lukte,
  of in rood sinds wanneer er een storing is. Zowel de watchlist als de
  gratis-checker sturen één Telegram-melding per storing per winkel, en
  daarna elke 24 uur een herinnering zolang de storing duurt
- **Scheduler**: automatisch checken op instelbaar interval, plus handmatige check
- Alle data blijft bewaard in het `/data`-volume

## Techniek

**Alle vier de winkels** draaien op het SAP Spartacus-platform (Trekpleister sinds
het najaar van 2026). De losse
product-API zit achter Akamai Bot Manager, maar de zoekpagina rendert alle
productdata server-side als JSON in `<script id="spartacus-app-state">`. De
app haalt per gevolgd product `https://www.kruidvat.nl/search/<productcode>`
op (de zoekterm moet in het URL-pad staan; de querystring-variant wordt door
de edge-cache genegeerd) en leest daar prijs, voorraad en `topPromotion` uit.
`promoCode` is uniek per actieperiode en wordt gebruikt om te onthouden wat
al gemeld is (`/data/notified.json`).

Voor 100 zoekresultaten worden meerdere zoekpagina's (20 per pagina) opgehaald
via `?currentPage=N`; `pageSize` wordt door de sites genegeerd.

**ICI PARIS XL** zet geen productdata meer in de pagina; de app gebruikt daar
de OCC-API (`api.iciparisxl.nl/api/v2/icinl3/products/search`), die server-side
bereikbaar is en 100 resultaten per verzoek levert. Verder wijkt ICI op drie
punten af (afgevangen in `stores.js`): productcodes hebben een `BP_`-prefix, er is geen
`purchasable`-veld (voorraad komt uit `stock.stockLevelStatus`), en
`topPromotion` staat op vrijwel álle producten zonder tekst — alleen een
`reward` met `formattedRewardValue` ("35%") telt als echte actie. Levert de
feed `value: 0` ("Kortingsprijs: Gratis" op de site), dan wordt de normale
prijs uit `oldValue` getoond.

**Trekpleister** geeft in de zoekresultaten alleen een actie-ID; de
actietekst (met einddatum) staat op de productpagina en wordt per unieke
actie opgehaald (maximaal 20 per zoekopdracht, 4 tegelijk).

Voor alle verzoeken is de volledige browser-headerset vereist (inclusief
`sec-ch-ua` en `Sec-Fetch-*`), anders blokkeert Akamai met een 403. Akamai
weigert bovendien te oude Chrome-versies (in november 2026: alles onder 143).
De app haalt daarom dagelijks de actuele stabiele Chrome-versie op uit
Google's openbare versielijst (`versionhistory.googleapis.com`) en rekent
hem uit de datum uit als Google niet bereikbaar is (sinds augustus 2026 een
nieuwe versie per 2 weken). Vastzetten kan met `CHROME_VERSION`, het ophalen
uitschakelen met `CHROME_VERSION_CHECK=false`. De gebruikte versie staat in
de voettekst van het dashboard.

**Zoekfilters** gaan als Spartacus-query naar de winkel:
`<term>:<sortering>:<facet>:<waarde>…`, bij Kruidvat en Trekpleister in het
URL-pad, bij ICI in de API-query. Facetten: `salePriceRange` (ICI: `price`),
`stockLevel:inStock` (ICI: `stockLevelStatus:INSTOCK` + `LOWSTOCK`),
`masterBrandName` en `promotionCategory` (ICI: `offers`). De keuzelijsten
voor merk en actie komen uit de facetten die de winkel bij de zoekopdracht
meestuurt.

### Robuustheid

- Elke externe request heeft een timeout van 20 s en krijgt bij een
  tijdelijke fout één herkansing (10 s later). Een check-run duurt nooit
  langer dan 45 minuten.
- Alles wat naar de winkels gaat (geplande checks, zoeken, een nieuw product
  volgen) loopt door één gedeeld scrape-slot, dus nooit parallel.
- Is een winkel als geheel onbereikbaar, dan komt er één storingsmelding per
  winkel, en zolang de storing duurt elke 24 uur een herinnering;
  de gevolgde producten van die winkel behouden hun laatste bekende status.
  Een product dat 3 checks op rij écht niet gevonden wordt, wordt éénmalig
  gemeld als "mogelijk verdwenen".
- Bij een (her)start draait de eerste geplande check al na ~1 minuut, zodat
  een NAS-herstart geen volledig interval overslaat.
- De laatste check-resultaten en logregels staan in `/data/state.json` en
  overleven een herstart.
- Alle databestanden worden atomair geschreven (tmp + rename); een onleesbaar
  bestand wordt als `.corrupt` bewaard in plaats van overschreven.
- Telegram-fouten verschijnen in het log en als waarschuwing bovenaan het
  dashboard.
- Zoeken stopt vanzelf als een winkel de paginering negeert (een pagina met
  alleen al bekende producten), in plaats van vijf keer dezelfde pagina op te
  halen.
- De container start als root om de rechten op het datavolume recht te
  zetten en draait daarna als de onbevoorrechte gebruiker `node`
  (zie `entrypoint.sh`). Lukt dat niet, dan valt hij terug op root met een
  waarschuwing in het log.
- `GET /healthz` is een lichte health-check (`{ ok, version }`) voor Docker
  en monitoring; `/api/status` bevat daarnaast de volledige status en logs.

## Starten

```bash
docker compose up -d --build
```

Dashboard: http://localhost:9060

### Zelf bouwen/draaien zonder compose

```bash
docker build -t multistore-checker .
docker run -d --name multistore-checker \
  -p 9060:8000 \
  -v $(pwd)/data:/data \
  -e TZ=Europe/Amsterdam \
  multistore-checker
```

### Omgevingsvariabelen (optioneel)

| Variabele | Uitleg | Standaard |
|---|---|---|
| `PORT` | Poort in de container | `8000` |
| `CONFIG_DIR` | Map voor config/state | `/data` |
| `TELEGRAM_BOT_TOKEN` | Eerste Telegram-bot (alleen bij eerste start) | – |
| `TELEGRAM_CHAT_ID` | Bijbehorende chat-ID | – |
| `CHECK_INTERVAL` | Standaard interval in minuten | `360` |
| `CHROME_VERSION` | Zet de Chrome-versie in de browserheaders vast (standaard: actuele versie volgens Google) | – |
| `CHROME_VERSION_CHECK` | `false` schakelt het dagelijks ophalen van de Chrome-versie bij Google uit (dan geldt de berekende versie) | `true` |
| `UPDATE_CHECK` | `false` schakelt de dagelijkse versie-check op GitHub uit | `true` |
| `UPDATE_REPO` | Repo waarvan de versie-tags gelezen worden | `TerrorSource/multistore-checker` |

## Ontwikkelen en testen

```bash
npm ci
npm test        # unit- en API-tests (Node's ingebouwde test runner)
npm start       # lokaal draaien; CONFIG_DIR=./data PORT=8000 zijn handig
```

De tests raken nooit het internet: alle sitedata en Telegram-verkeer worden
nagebootst (`test/helpers.js`). De CI draait `npm test` vóór de image-build.

Telegram kan ook volledig via het dashboard geconfigureerd worden.

> **Let op:** het dashboard heeft geen authenticatie en toont de
> bot-tokens. Zet de poort niet open naar internet.

## Bestanden in /data

- `config.json` — instellingen (Telegram, intervallen, gratis-checker)
- `watchlist.json` — gevolgde producten (incl. laatste status per product)
- `notified.json` — welke actie per product al gemeld is
- `seen.json` — geziene producten van de gratis-checker
- `gratis-outages.json` — lopende storingen van de gratis-checker
- `state.json` — laatste check-resultaten, logregels en status per winkel
