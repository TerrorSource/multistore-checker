// Veilige JSON-opslag voor alle databestanden (config, watchlist, notified,
// seen, state).
//
// - writeJsonAtomic: schrijft naar een .tmp-bestand en hernoemt dat daarna.
//   rename() is atomair, dus een crash of stroomuitval tijdens het schrijven
//   laat nooit een half bestand achter — hooguit het oude, complete bestand.
// - readJson: geeft de fallback terug als het bestand ontbreekt. Is het
//   bestand wél aanwezig maar onleesbaar (kapotte JSON), dan wordt het eerst
//   bewaard als <bestand>.corrupt, zodat de volgende save de data niet
//   stilzwijgend met een lege versie overschrijft en er iets te herstellen
//   valt.

const fs = require('fs');

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Geeft { data, corrupt } terug: data is de inhoud (of de fallback), corrupt
// is true als er een kapot bestand opzij gezet is.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return { data: fallback, corrupt: false };
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), corrupt: false };
  } catch (err) {
    const backup = `${file}.corrupt`;
    try {
      fs.copyFileSync(file, backup);
      console.error(`${file} is onleesbaar (${err.message}); bewaard als ${backup}.`);
    } catch (copyErr) {
      console.error(`${file} is onleesbaar (${err.message}) en kon niet als backup bewaard worden: ${copyErr.message}`);
    }
    return { data: fallback, corrupt: true };
  }
}

module.exports = { writeJsonAtomic, readJson };
