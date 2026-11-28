'use strict';
// Prüft, dass in den Unterlagen und im Zeitstrahl eines Test-Patienten kein Jahr nach 2027 vorkommt.
//   node werkzeuge/daten-pruefen.js            # p2
//   node werkzeuge/daten-pruefen.js --id p2 --alle   # zusätzlich jede Jahreszahl je Dokument auflisten
// Zeigt nur Jahreszahlen, keine Briefinhalte. Exit-Code 1, wenn das Maximum über 2027 liegt oder ein Zitat fehlt.
const rag = require('../rag');
const pd = require('../patientendaten');
const { findeJahre } = require('./daten-datieren');

const MAX = 2027;
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const id = arg('id') || 'p2';
const alle = process.argv.includes('--alle');

// Rohe Suche: jede vierstellige Zahl 1900–2099 (auch Nicht-Daten wie Dosen) + erkannte Daten mit zweistelligem Jahr
function jahreIn(text) {
  const roh = [...String(text || '').matchAll(/(?<!\d)(19|20)\d\d(?!\d)/g)].map((m) => Number(m[0]));
  const erkannt = findeJahre(String(text || '')).map((t) => t.jahr);
  return [...roh, ...erkannt];
}
const zusammen = (l) => [...new Set(l)].sort((a, b) => a - b);

let maxGesamt = 0, fehler = 0;
const p = rag.ladePatient(id);
console.log(`Test-Patient ${id}: ${p.dokumente.length} Dokumente`);
console.log('Dokument'.padEnd(18), 'Briefdatum'.padEnd(11), 'min', ' max', alle ? ' Jahre' : '');
for (const d of p.dokumente) {
  const text = rag.ladeDokument(id, d.docId).text;
  const j = zusammen([...jahreIn(text), ...jahreIn(d.titel), ...(d.datum ? [Number(d.datum.slice(0, 4))] : [])]);
  const max = Math.max(...j);
  maxGesamt = Math.max(maxGesamt, max);
  console.log(d.docId.padEnd(18), String(d.datum).padEnd(11), j[0], max, alle ? ' ' + j.join(' ') : '', max > MAX ? '  ⚠' : '');
}

const z = pd.zeitstrahl(id);
const zj = [];
let ohneBeleg = 0;
for (const e of z.ereignisse) {
  zj.push(...jahreIn(e.datum), ...jahreIn(e.sortDatum), ...jahreIn(e.titel), ...jahreIn(e.beschreibung), ...jahreIn(e.zitat));
  const text = rag.ladeDokument(id, e.docId).text;
  if (!e.belegt || text.slice(e.start, e.ende).replace(/\s+/g, ' ').trim() !== e.zitat) ohneBeleg++;
}
const zjs = zusammen(zj);
const zmax = zjs.length ? zjs[zjs.length - 1] : 0;
maxGesamt = Math.max(maxGesamt, zmax);
console.log(`\nZeitstrahl: ${z.ereignisse.length} Ereignisse, Zeitraum ${z.zeitraum?.von} – ${z.zeitraum?.bis}, offen ${z.dokumente.offen.length}`);
console.log(`Jahre im Zeitstrahl: ${zjs.join(' ')}`);
console.log(`Zitate nicht exakt an ihrer Stelle im Text: ${ohneBeleg}`);
if (ohneBeleg) fehler++;
if (z.dokumente.offen.length) { console.log('⚠ Zeitstrahl nicht vollständig berechnet'); fehler++; }
console.log(`\nMaximum aller Jahreszahlen: ${maxGesamt} → ${maxGesamt <= MAX ? `OK (≤ ${MAX})` : `FEHLER (> ${MAX})`}`);
if (maxGesamt > MAX) fehler++;
process.exit(fehler ? 1 : 0);
