const fs = require('fs');

// Datamap-resolutie, gedeeld door alle modules.
//
// Volgorde:
// 1. Expliciete CONFIG_DIR-omgevingsvariabele.
// 2. /config, als daar al een config.json staat — dan draait deze container
//    op het volume van een multistorechecker v1.x-installatie en nemen we
//    die data (config, seen.json) naadloos over.
// 3. Anders /data (standaard voor nieuwe installaties).
let dir = process.env.CONFIG_DIR;
if (!dir) {
  dir = fs.existsSync('/config/config.json') ? '/config' : '/data';
}

module.exports = { DATA_DIR: dir };
