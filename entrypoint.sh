#!/bin/sh
# Start de app als de onbevoorrechte 'node'-gebruiker i.p.v. root.
#
# Het datavolume wordt door Docker meestal als root aangemaakt (en bestaande
# installaties draaiden tot 2.2.0 als root), dus eerst de rechten rechtzetten.
# Lukt dat niet (bv. een netwerkshare zonder chown-ondersteuning) en is de map
# voor 'node' niet schrijfbaar, dan vallen we terug op root met een duidelijke
# waarschuwing — liever dat dan een app die z'n config niet kan opslaan.
set -e

# Zelfde datamap-resolutie als datadir.js.
DATA="${CONFIG_DIR:-}"
if [ -z "$DATA" ]; then
  if [ -f /config/config.json ]; then DATA=/config; else DATA=/data; fi
fi
mkdir -p "$DATA" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA" 2>/dev/null || true
  if su-exec node sh -c "test -w '$DATA'"; then
    exec su-exec node node /app/server.js
  fi
  echo "WAARSCHUWING: $DATA is niet schrijfbaar voor gebruiker 'node'; de app draait als root." >&2
fi

exec node /app/server.js
