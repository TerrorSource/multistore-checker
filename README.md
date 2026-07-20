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
  verborgen)
- **Actie-categorieën**: elke aanbieding wordt ingedeeld in een categorie
  (1+1 / X+Y gratis, 2e halve prijs, % korting, afgeprijsd, overig) waarop je
  in de zoekresultaten kunt filteren. "Gratis verzending" telt niet als
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
  meldt die via Telegram, met eigen interval en filters
- **Scheduler**: automatisch checken op instelbaar interval, plus handmatige check
- Alle data blijft bewaard in het `/data`-volume

## Techniek

**Kruidvat NL/BE en ICI PARIS XL** draaien op het SAP Spartacus-platform. De losse
product-API zit achter Akamai Bot Manager, maar de zoekpagina rendert alle
productdata server-side als JSON in `<script id="spartacus-app-state">`. De
app haalt per gevolgd product `https://www.kruidvat.nl/search/<productcode>`
op (de zoekterm moet in het URL-pad staan; de querystring-variant wordt door
de edge-cache genegeerd) en leest daar prijs, voorraad en `topPromotion` uit.
`promoCode` is uniek per actieperiode en wordt gebruikt om te onthouden wat
al gemeld is (`/data/notified.json`).

**ICI PARIS XL** wijkt binnen Spartacus op drie punten af (afgevangen in
`stores.js`): productcodes hebben een `BP_`-prefix, er is geen
`purchasable`-veld (voorraad komt uit `stock.stockLevelStatus`), en
`topPromotion` staat op vrijwel álle producten zonder tekst — alleen een
`reward` met `formattedRewardValue` ("35%") telt als echte actie. Levert de
feed `value: 0` ("Kortingsprijs: Gratis" op de site), dan wordt de normale
prijs uit `oldValue` getoond.

**Trekpleister** draait nog op het oude platform: productdata staat in
data-attributen van `<e2-impression-tracker>` in de HTML-tegels
(naam, prijs, oude prijs, voorraad, actie-ID). De actietekst staat niet op de
tegel en wordt per unieke actie opgehaald via het
`PromotionBoxComponentController`-AJAX-endpoint.

Voor alle verzoeken is de volledige browser-headerset vereist (inclusief
`sec-ch-ua` en `Sec-Fetch-*`), anders blokkeert Akamai met een 403.

## Starten

```bash
docker compose up -d --build
```

Dashboard: http://localhost:9070

### Zelf bouwen/draaien zonder compose

```bash
docker build -t multistore-checker .
docker run -d --name multistore-checker \
  -p 9070:8000 \
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

Telegram kan ook volledig via het dashboard geconfigureerd worden.

> **Let op:** het dashboard heeft geen authenticatie en toont de
> bot-tokens. Zet de poort niet open naar internet.

## Bestanden in /data

- `config.json` — instellingen (Telegram, intervallen, gratis-checker)
- `watchlist.json` — gevolgde producten (incl. laatste status per product)
- `notified.json` — welke actie per product al gemeld is
- `seen.json` — geziene producten van de gratis-checker
