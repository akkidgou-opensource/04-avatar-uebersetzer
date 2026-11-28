'use strict';
// ---------------------------------------------------------------------------------------------
// daten-datieren.js – erzeugt aus daten/grascco/*.txt die Kopie daten/grascco-2027/ mit verschobenen Datumsangaben.
// Die Originale bleiben unverändert.
//
// Regeln:
//  - Pro Brief EIN konstanter Jahres-Versatz (alle Jahre inkl. Geburtsjahr → Alter und Abstände bleiben gleich).
//  - Kein Datum nach 2027 (Versatz = min(0, 2027 − spätestes Jahr im Brief)).
//  - Die 15 Briefe des Test-Patienten p2 werden in ihrer bisherigen Reihenfolge über 2019–2027 verteilt.
//  - Erkannt werden: TT.MM.JJJJ, TT.MM.JJ, TT/MM/JJ(JJ), JJJJ-MM-TT, MM/JJJJ, MM/JJ und Jahreszahlen 1900–2099
//    im Datumskontext (nicht: Dosen wie „2000mg“, Klassifikationen wie „UICC 2009“, „NB2004“).
//  - 29.02. in einem Nicht-Schaltjahr wird zum 28.02.
//
//   node werkzeuge/daten-datieren.js            # schreibt daten/grascco-2027/ und zeigt die Tabelle
//   node werkzeuge/daten-datieren.js --trocken  # nur Tabelle, nichts schreiben
// ---------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const rag = require('../rag');

const PROJEKT = path.join(__dirname, '..');
const QUELLE = path.join(PROJEKT, 'daten', 'grascco');
const ZIEL = path.join(PROJEKT, 'daten', 'grascco-2027');
const MAX_JAHR = 2027;
const P2_VON = 2019, P2_BIS = 2027;
const MIN_GEBURTSJAHR = 1925;

const MONATE = /(januar|jan|februar|feb|märz|maerz|mär|april|apr|mai|juni|jun|juli|jul|august|aug|september|sept|sep|oktober|okt|november|nov|dezember|dez)\.?\s*$/i;
const EINHEIT_DANACH = /^\s?(mg|ml|µg|ug|mm|cm|kg|ie|i\.e\.|e\/|u\/|%|\/\s?m2|mmhg|hg)/i;
const KLASSIFIKATION_DAVOR = /(uicc|ajcc|who|icd|tnm|figo|nb)[\s-]*$/i;
const ZAEHLER_DAVOR = /(pN[-\w]*\s*\(?|BSG\s*|ypT\w*\(?)$/;

// Alle Jahres-Stellen eines Textes finden: [{start, ende, jahr (4-stellig), stellen: 2|4, tag?, monat?, tagStart?}]
function findeJahre(text) {
  const treffer = [];
  const belegt = (s, e) => treffer.some((t) => s < t.ende && e > t.start);
  // Bezugsjahr für zweistellige Jahre: spätestes vierstelliges Jahr im Brief
  const vier = [...text.matchAll(/(?<!\d)(19|20)\d\d(?!\d)/g)].map((m) => Number(m[0]));
  const bezug = vier.length ? Math.max(...vier) : 2025;
  const jahr2 = (yy) => (2000 + yy <= bezug + 2 ? 2000 + yy : 1900 + yy);

  // 1. ISO JJJJ-MM-TT
  for (const m of text.matchAll(/(?<!\d)((?:19|20)\d\d)-(\d\d)-(\d\d)(?!\d)/g)) {
    treffer.push({ start: m.index, ende: m.index + 4, jahr: Number(m[1]), stellen: 4, monat: Number(m[2]), tag: Number(m[3]), tagStart: m.index + 8, tagLaenge: 2 });
  }
  // 2. TT.MM.JJ(JJ) und TT/MM/JJ(JJ) (Leerzeichen um die Trenner erlaubt)
  for (const m of text.matchAll(/(?<![\d,/])(\d{1,2})[ ]?([./])[ ]?(\d{1,2})[ ]?\2[ ]?(\d{4}|\d{2})(?!\d)/g)) {
    const tag = Number(m[1]), monat = Number(m[3]);
    if (tag < 1 || tag > 31 || monat < 1 || monat > 12) continue;
    const y = m[4];
    if (y.length === 4 && !/^(19|20)/.test(y)) continue;
    const start = m.index + m[0].length - y.length;
    if (belegt(start, start + y.length)) continue;
    treffer.push({ start, ende: start + y.length, jahr: y.length === 4 ? Number(y) : jahr2(Number(y)), stellen: y.length, monat, tag, tagStart: m.index, tagLaenge: m[1].length });
  }
  // 3. MM/JJ(JJ)
  for (const m of text.matchAll(/(?<![\d.,/\w])(\d{1,2})[ ]?\/[ ]?(\d{4}|\d{2})(?![\d/.,])/g)) {
    const monat = Number(m[1]);
    if (monat < 1 || monat > 12) continue;
    const y = m[2];
    if (y.length === 4 && !/^(19|20)/.test(y)) continue;
    const nach = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    const vor = text.slice(Math.max(0, m.index - 12), m.index);
    if (EINHEIT_DANACH.test(nach) || ZAEHLER_DAVOR.test(vor)) continue;
    const start = m.index + m[0].length - y.length;
    if (belegt(start, start + y.length)) continue;
    treffer.push({ start, ende: start + y.length, jahr: y.length === 4 ? Number(y) : jahr2(Number(y)), stellen: y.length });
  }
  // 4. Vierstellige Jahreszahlen im Datumskontext
  for (const m of text.matchAll(/(?<![\d,])(19|20)\d\d(?!\d)/g)) {
    const s = m.index, e = s + 4;
    if (belegt(s, e)) continue;
    const vor = text.slice(Math.max(0, s - 15), s);
    const nach = text.slice(e, e + 8);
    if (/[A-Za-zÄÖÜäöüß]$/.test(vor) && !MONATE.test(vor)) continue;   // NB2004 (aber „März2063“ ist ein Datum)
    if (KLASSIFIKATION_DAVOR.test(vor)) continue;                     // UICC 2009, AJCC 2009
    if (EINHEIT_DANACH.test(nach)) continue;                          // 2000mg
    treffer.push({ start: s, ende: e, jahr: Number(m[0]), stellen: 4 });
  }
  return treffer.sort((a, b) => a.start - b.start);
}

const schaltjahr = (j) => (j % 4 === 0 && j % 100 !== 0) || j % 400 === 0;

function verschiebe(text, versatz) {
  if (!versatz) return text;
  const treffer = findeJahre(text);
  let aus = '', pos = 0;
  for (const t of treffer) {
    const neu = t.jahr + versatz;
    // 29.02. in einem Nicht-Schaltjahr → 28.02.
    if (t.tag === 29 && t.monat === 2 && !schaltjahr(neu) && t.tagStart != null && t.tagStart >= pos) {
      aus += text.slice(pos, t.tagStart) + (t.tagLaenge === 2 ? '28' : '28');
      pos = t.tagStart + t.tagLaenge;
    }
    aus += text.slice(pos, t.start) + (t.stellen === 4 ? String(neu) : String(neu % 100).padStart(2, '0'));
    pos = t.ende;
  }
  return aus + text.slice(pos);
}

function plusJahre(iso, n) { return iso ? String(Number(iso.slice(0, 4)) + n) + iso.slice(4) : null; }

function main() {
  const trocken = process.argv.includes('--trocken');
  const dateien = fs.readdirSync(QUELLE).filter((f) => f.endsWith('.txt') && !f.startsWith('_')).sort();
  const briefe = dateien.map((name) => {
    const text = fs.readFileSync(path.join(QUELLE, name), 'utf8');
    const jahre = findeJahre(text).map((t) => t.jahr);
    return { name, text, min: Math.min(...jahre), max: Math.max(...jahre), datum: rag.erkenneDatum(text), versatz: 0 };
  });
  const nachName = new Map(briefe.map((b) => [b.name, b]));

  // Standard: alle Briefe höchstens bis 2027
  for (const b of briefe) b.versatz = Math.min(0, MAX_JAHR - b.max);

  // p2 (die 15 bevorzugten Beispielbriefe): bisherige Reihenfolge, gleichmäßig über 2019–2027 verteilt
  const p2Namen = rag.waehleBeispielbriefe({ anzahl: 15 }).map((p) => path.basename(p));
  const p2 = p2Namen.map((n) => nachName.get(n)).filter(Boolean)
    .sort((a, b) => String(a.datum || '9999').localeCompare(String(b.datum || '9999')) || a.name.localeCompare(b.name));
  p2.forEach((b, i) => {
    const briefJahr = Number((b.datum || String(b.max)).slice(0, 4));
    const zielJahr = P2_VON + Math.round(i * (P2_BIS - P2_VON) / Math.max(1, p2.length - 1));
    b.grenze = MAX_JAHR - b.max;
    b.versatz = Math.min(zielJahr - briefJahr, b.grenze);
    b.p2 = true;
  });
  // Reihenfolge erhalten: rückwärts – kein Brief nach seinem Nachfolger; dann vorwärts – keiner vor seinem Vorgänger
  const neuDatum = (b) => plusJahre(b.datum, b.versatz) || '9999';
  for (let i = p2.length - 2; i >= 0; i--) while (neuDatum(p2[i]) > neuDatum(p2[i + 1])) p2[i].versatz--;
  for (let i = 1; i < p2.length; i++) {
    while (neuDatum(p2[i]) < neuDatum(p2[i - 1]) && p2[i].versatz < p2[i].grenze) p2[i].versatz++;
    if (neuDatum(p2[i]) < neuDatum(p2[i - 1])) console.log(`⚠ Reihenfolge bei ${p2[i].name} nicht haltbar`);
  }

  // Schreiben + prüfen
  if (!trocken) fs.mkdirSync(ZIEL, { recursive: true });
  const zeilen = [];
  let fehler = 0;
  for (const b of briefe) {
    const neu = verschiebe(b.text, b.versatz);
    const jahreNeu = findeJahre(neu).map((t) => t.jahr);
    const neuMin = Math.min(...jahreNeu), neuMax = Math.max(...jahreNeu);
    const datumNeu = rag.erkenneDatum(neu);
    const warn = [];
    if (neuMax > MAX_JAHR) { warn.push(`> ${MAX_JAHR}`); fehler++; }
    if (neuMin < MIN_GEBURTSJAHR) warn.push(`frühestes Jahr ${neuMin}`);
    if (neuMin !== b.min + b.versatz || neuMax !== b.max + b.versatz) { warn.push('Versatz uneinheitlich'); fehler++; }
    zeilen.push({ ...b, neuMin, neuMax, datumNeu, warn });
    if (!trocken) fs.writeFileSync(path.join(ZIEL, b.name), neu);
  }
  if (!trocken) {
    fs.copyFileSync(path.join(QUELLE, '_QUELLE.txt'), path.join(ZIEL, '_QUELLE.txt'));
    fs.writeFileSync(path.join(ZIEL, 'README.md'), [
      '# GraSCCo – Datumsangaben verschoben (bis 2027)',
      '',
      'Kopie von `daten/grascco/` für die Demo. **Datumsangaben verschoben:** pro Brief wurden alle Jahreszahlen',
      'um einen festen Wert verschoben (Geburtsjahre mit), damit kein Datum nach 2027 liegt. Alter und Abstände bleiben gleich.',
      'Die 15 Briefe des Test-Patienten p2 sind in ihrer bisherigen Reihenfolge über 2019–2027 verteilt.',
      'Erzeugt mit `node werkzeuge/daten-datieren.js`; die Originale in `daten/grascco/` sind unverändert.',
      '',
      '- Quelle: GraSCCo – Graz Synthetic Clinical text Corpus, https://doi.org/10.5281/zenodo.6539131',
      '- Lizenz: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Änderung: Datumsangaben verschoben.',
      '- Alle Namen und Daten sind frei erfunden. Medizinische Plausibilität ist nicht garantiert.',
      '',
    ].join('\n'));
  }

  const z = (x) => String(x ?? '—');
  console.log('Brief'.padEnd(22), 'p2', 'Versatz', 'alt'.padEnd(11), 'neu'.padEnd(11), 'Briefdatum alt → neu');
  for (const r of zeilen.sort((a, b) => (b.p2 ? 1 : 0) - (a.p2 ? 1 : 0) || String(a.datumNeu || '9').localeCompare(String(b.datumNeu || '9')))) {
    console.log(r.name.padEnd(22), r.p2 ? '✓ ' : '  ', String(r.versatz).padStart(7), `${r.min}–${r.max}`.padEnd(11), `${r.neuMin}–${r.neuMax}`.padEnd(11),
      `${z(r.datum)} → ${z(r.datumNeu)}`, r.warn.length ? '  ⚠ ' + r.warn.join(', ') : '');
  }
  console.log(`\n${zeilen.length} Briefe, ${fehler} Fehler.${trocken ? ' (trocken, nichts geschrieben)' : ` Geschrieben nach ${path.relative(PROJEKT, ZIEL)}/`}`);
  if (fehler) process.exit(1);
}

if (require.main === module) main();
module.exports = { findeJahre, verschiebe };
