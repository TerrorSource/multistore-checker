# Multistore Checker

Lightweight Docker container that monitors **Kruidvat NL**, **Kruidvat BE** and **Trekpleister NL** for products listed without a price and sends notifications via **Telegram**.

![Docker](https://img.shields.io/badge/Docker-ready-blue?logo=docker)
![Node](https://img.shields.io/badge/Node-20--alpine-green?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## Features

- Monitors three A.S. Watson stores for free / no-price products
- Telegram notifications with product name, direct link, stock level and order status
- Web dashboard for all configuration and manual checks
- Configurable check interval (minutes)
- Filter to only show orderable products (`purchasable`)
- Optional notification when 0 products are found
- Built-in request delays between sites and API calls to avoid rate limiting
- Tiny footprint: ~50 MB image, ~30 MB RAM — no headless browser needed

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed
- A Telegram bot token and chat ID (see [Telegram setup](#telegram-setup))

---

## Quick start

### 1. Create a docker-compose.yml

```yaml
services:
  multistore-checker:
    image: ghcr.io/terrorsource/multistore-checker:latest
    container_name: multistore-checker
    restart: unless-stopped
    network_mode: bridge
    environment:
      - TZ=Europe/Amsterdam
      - PUID=1000
      - PGID=1000
    ports:
      - "9060:8000"
    volumes:
      - /path/to/your/config:/config
```

### 2. Start the container

```bash
docker compose up -d
```

### 3. Open the dashboard

Go to `http://<your-ip>:9060` in your browser. Fill in your Telegram Bot Token and Chat ID, select the sites you want to monitor and click **Opslaan**.

### 4. Verify

Click **Test Telegram** to confirm your bot is working, then click **Controleer nu** to run your first scan.

---

## Docker Compose

### Parameters

| Parameter | Description |
|---|---|
| `image` | `ghcr.io/terrorsource/multistore-checker:latest` |
| `container_name` | Name of the container |
| `restart` | Restart policy (`unless-stopped`) |
| `network_mode` | Network mode (`bridge`) |
| `TZ` | Timezone (e.g. `Europe/Amsterdam`) |
| `PUID` / `PGID` | User/group ID for file permissions |
| `9060:8000` | Maps host port `9060` to container port `8000` |
| `/config` | Persistent volume for settings (`config.json`) |

### Customizing

**Change the port** — map to a different host port:

```yaml
    ports:
      - "3000:8000"
```

**NAS volume path** — example for QNAP:

```yaml
    volumes:
      - /share/CACHEDEV1_DATA/Docker/multistore-checker:/config
```

### Building from source

If you want to build the image yourself instead of pulling from GHCR:

```bash
git clone https://github.com/TerrorSource/multistore-checker.git
cd multistore-checker
docker compose up -d --build
```

Replace the `image` line in your docker-compose.yml with:

```yaml
    build: .
```

---

## Dashboard

The web dashboard runs on the configured port (default `8000` internal, mapped to your chosen host port) and provides:

### Status bar
Shows whether the scheduler is active, the time of the last check, and whether a check is currently running.

### Telegram settings

| Field | Description |
|---|---|
| **Bot Token** | Your Telegram bot token from @BotFather |
| **Chat ID** | The chat or group ID to send notifications to |

### Scan settings

| Setting | Description | Default |
|---|---|---|
| **Automatisch checken** | Enable/disable the automatic scheduler | Off |
| **Check-interval** | Minutes between automatic checks | `360` (6 hours) |
| **Alleen bestelbaar** | Only report products that can actually be ordered | Yes |
| **Bericht bij 0 producten** | Send a message even when no products are found | No |
| **Sites** | Which stores to monitor | All three |

### Buttons

| Button | Action |
|---|---|
| **Opslaan** | Save all settings and restart the scheduler |
| **Controleer nu** | Run an immediate manual check for all selected sites |
| **Test Telegram** | Send a test message to verify your bot token and chat ID |

### Logs
The bottom of the dashboard shows a live log of recent activity (checks, results, errors).

---

## Telegram setup

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create a new bot
3. Copy the **bot token** (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. To get your **chat ID**:
   - For personal messages: message [@userinfobot](https://t.me/userinfobot) and it will reply with your ID
   - For a group: add your bot to the group, send a message, then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and look for `"chat":{"id":-100...}`
5. Enter both in the dashboard and click **Test Telegram** to verify

---

## Portainer deployment

1. Go to **Stacks > Add stack**
2. Select **Repository**
3. Enter the repository URL: `https://github.com/TerrorSource/multistore-checker`
4. Set **Compose path** to `docker-compose.yml`
5. Click **Deploy the stack**

Or use **Web editor** and paste the docker-compose.yml contents above.

---

## How it works

1. For each enabled store, the checker fetches the search results page filtered on products priced between 0 and 0.48 EUR (up to 100 results)
2. The HTML is parsed with **Cheerio** (no headless browser needed) to find products marked "Geen prijs aanwezig"
3. For each product found, the store's product API is called to retrieve stock level and order availability (with 500 ms delay between calls)
4. If the `purchasable` filter is on, only products that can actually be ordered are kept
5. Results are sent to Telegram with product names as clickable links
6. A 2-second delay between sites keeps requests friendly

---

## Project structure

```
multistore-checker/
├── Dockerfile           # Node 20 Alpine image
├── docker-compose.yml   # Container orchestration
├── package.json         # Dependencies (cheerio, express, node-cron)
├── server.js            # Express server, scheduler, API endpoints
├── scraper.js           # HTML scraping & Telegram notification logic
├── public/
│   └── index.html       # Web dashboard
├── .gitignore
├── .dockerignore
├── LICENSE              # MIT
└── README.md
```

Persistent data is stored in the `/config` volume mount:

```
/config/
└── config.json          # All settings (bot token, chat ID, sites, etc.)
```

---

## Tech stack

| Component | Purpose |
|---|---|
| **Node.js 20 Alpine** | Runtime (~50 MB image) |
| **Express** | Web dashboard & REST API |
| **Cheerio** | Fast HTML parsing without a browser |
| **node-cron** | Cron-based scheduling |
| **Telegram Bot API** | Push notifications |

---

## License

This project is licensed under the [MIT License](LICENSE).

---

Made by **Makooy**
