FROM node:26-alpine

# su-exec: na het rechtzetten van de volume-rechten (als root) verder draaien
# als de onbevoorrechte 'node'-gebruiker. Zie entrypoint.sh.
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# /app moet leesbaar zijn voor de 'node'-gebruiker. COPY neemt de modes van
# de bron over, en die kunnen 700 zijn (bv. bestanden uit een OneDrive-map);
# a+rX maakt bestanden leesbaar en mappen doorzoekbaar, zonder exec-bits toe
# te voegen aan gewone bestanden.
RUN mkdir -p /data && chmod -R a+rX /app && chmod +x /app/entrypoint.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:'+(process.env.PORT||8000)+'/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
