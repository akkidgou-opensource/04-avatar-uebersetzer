'use strict';
// Testwerkzeug für patientendaten.js (nur synthetische Testdaten). Gibt bewusst Testinhalte aus.
//
//   node --env-file=.env werkzeuge/patientendaten-test.js            # alles: Demo-Ablauf (2 KI-Aufrufe) + p2-Zeitstrahl (bis 15 Aufrufe, einmalig)
//   node werkzeuge/patientendaten-test.js --ohne-ki                  # nur Ablauf ohne Claude
//   node --env-file=.env werkzeuge/patientendaten-test.js --ohne-p2  # p2-Zeitstrahl auslassen
//
// p-demo wird dabei zurückgesetzt (leer). p2 wird nur gelesen; sein Zeitstrahl wird berechnet und zwischengespeichert.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pd = require('../patientendaten');

const OHNE_KI = process.argv.includes('--ohne-ki');
const OHNE_P2 = process.argv.includes('--ohne-p2');
const DEMO = pd.PATIENT_DEMO;
let kiAufrufe = 0;
const verbrauch = { eingabe: 0, ausgabe: 0 };

function schritt(t) { console.log(`\n=== ${t}`); }
function ok(t) { console.log(`  ✓ ${t}`); }

// Kleinstes gültiges JPEG (1×1 Pixel, grau) als Platzhalter-Seitenbild.
const MINI_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////' +
  'wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function main() {
  schritt('1. Test-Patienten einrichten, Demo zurücksetzen');
  console.log('  ', pd.richteTestpatientenEin());
  pd.zuruecksetzen(DEMO);
  assert.throws(() => pd.zuruecksetzen(pd.PATIENT_ADMIN), (e) => e.status === 403);
  ok('p2 ist vor dem Zurücksetzen geschützt');
  const zu = pd.standardZuordnung();
  console.log('   Zuordnung aus .env:', Object.values(zu).join(', ') || '(ADMIN_USER/DEMO_USER nicht gesetzt)');

  schritt('2. Demo ist leer → Onboarding „scannen“');
  assert.deepStrictEqual(pd.liste(DEMO), []);
  let st = pd.status(DEMO);
  assert.strictEqual(st.naechsterSchritt, 'scannen');
  for (const s of pd.SPRACHEN) console.log(`   [${s}] ${pd.onboardingSatz(st, s)}`);
  ok('status = scannen, Sätze in 5 Sprachen');

  schritt('3. Arztbrief als „Scan“ hinzufügen (GraSCCo Gebauer.txt + 2 Seitenbilder)');
  const text = fs.readFileSync(path.join(__dirname, '..', 'daten', 'grascco-2027', 'Gebauer.txt'), 'utf8');
  const r = pd.neu(DEMO, { text, typ: 'foto', bilder: [MINI_JPEG, 'data:image/jpeg;base64,' + MINI_JPEG.toString('base64')] });
  const docId = r.dokument.docId;
  console.log('  ', r.dokument);
  assert.strictEqual(r.dokument.typ, 'foto');
  assert.strictEqual(r.dokument.seiten, 2);
  assert.throws(() => pd.neu(DEMO, { text: 'x', bilder: ['iVBORw0KGgo='] }), (e) => e.status === 400);
  ok('Nicht-JPEG wird abgelehnt');
  const bildDatei = path.join(__dirname, '..', 'lokal', 'patienten', DEMO, 'bilder', `${docId}-1.jpg`);
  assert.strictEqual(fs.statSync(bildDatei).mode & 0o777, 0o600);
  assert.ok(pd.bild(DEMO, docId, 2).daten.equals(MINI_JPEG));
  ok('Seitenbilder gespeichert (0600) und lesbar');
  const dok = pd.dokument(DEMO, docId);
  assert.strictEqual(dok.text.length, dok.zeichen);
  assert.deepStrictEqual(dok.bilder, [1, 2]);
  ok(`dokument(): Volltext ${dok.zeichen} Zeichen`);

  schritt('4. Umbenennen (Titel + Datum) → Suchindex neu');
  const um = pd.umbenennen(DEMO, docId, { titel: 'Mein Entlassungsbrief Kardiologie', datum: '2028-11-24' });
  assert.strictEqual(um.titel, 'Mein Entlassungsbrief Kardiologie');
  const idx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lokal', 'patienten', DEMO, 'index.json'), 'utf8'));
  assert.ok(idx.chunks.every((c) => c.titel === 'Mein Entlassungsbrief Kardiologie'));
  assert.throws(() => pd.umbenennen(DEMO, docId, { datum: '24.11.2028' }), (e) => e.status === 400);
  ok('Titel im Index aktualisiert, falsches Datumsformat abgelehnt');

  schritt('5. Gesundheitsangaben sammeln → status „fertig“');
  st = pd.status(DEMO);
  assert.strictEqual(st.naechsterSchritt, 'profil');
  console.log(`   [de] ${pd.onboardingSatz(st, 'de')}`);
  pd.speicherProfilAngabe(DEMO, { feld: 'erkrankungen', wert: 'Bluthochdruck', quelle: 'gespraech' });
  const doppelt = pd.speicherProfilAngabe(DEMO, { feld: 'erkrankungen', wert: 'bluthochdruck', quelle: 'gespraech' });
  assert.strictEqual(doppelt.doppelt, true);
  pd.speicherProfilAngabe(DEMO, { feld: 'medikamente', wert: 'Ramipril 5 mg', quelle: 'scan' });
  st = pd.status(DEMO);
  assert.strictEqual(st.naechstesFeld, 'allergien');
  console.log(`   [en] ${pd.onboardingSatz(st, 'en')}`);
  pd.setzeProfilFeld(DEMO, 'allergien', ['keine']);
  st = pd.status(DEMO);
  assert.strictEqual(st.naechsterSchritt, 'fertig');
  assert.throws(() => pd.speicherProfilAngabe(DEMO, { feld: 'blutgruppe', wert: 'A' }), (e) => e.status === 400);
  console.log('  ', JSON.stringify(pd.profil(DEMO).felder));
  console.log(`   [tr] ${pd.onboarding(DEMO, 'tr').satz}`);
  ok('Profil vollständig, unbekanntes Feld abgelehnt');

  if (!OHNE_KI) {
    schritt('6. Zeitstrahl für das Demo-Dokument (1 Claude-Aufruf)');
    const t0 = Date.now();
    const e = await pd.extrahiereEreignisse(DEMO, docId);
    kiAufrufe++;
    verbrauch.eingabe += e.verbrauch.eingabe; verbrauch.ausgabe += e.verbrauch.ausgabe;
    console.log(`   ${e.ereignisse.length} Ereignisse in ${Date.now() - t0} ms (${e.modell}, ${e.verbrauch.eingabe}/${e.verbrauch.ausgabe} Token)`);
    for (const x of e.ereignisse) console.log(`   - ${x.datum || '????'} [${x.art}] ${x.titel} – ${x.beschreibung}${x.belegt ? '' : '  (Zitat NICHT gefunden)'}`);
    assert.ok(e.ereignisse.length > 0);
    const belegt = e.ereignisse.filter((x) => x.belegt);
    for (const x of belegt) assert.ok(pd.dokument(DEMO, docId).text.slice(x.start, x.ende).length > 0);
    ok(`${belegt.length}/${e.ereignisse.length} Zitate wörtlich im Text gefunden`);
    const nochmal = await pd.extrahiereEreignisse(DEMO, docId);
    assert.strictEqual(nochmal.ausCache, true);
    ok('zweiter Aufruf kommt aus dem Zwischenspeicher');
    const zs = pd.zeitstrahl(DEMO);
    console.log('   Zeitraum:', zs.zeitraum, 'Dokumente:', zs.dokumente);
    assert.strictEqual(zs.dokumente.offen.length, 0);
    assert.strictEqual(pd.liste(DEMO)[0].ereignisse, e.ereignisse.length);
  } else {
    const zs = pd.zeitstrahl(DEMO);
    assert.deepStrictEqual(zs.dokumente.offen, [docId]);
    ok('ohne KI: Dokument steht als „offen“ im Zeitstrahl');
  }

  schritt('7. Löschen → aus Index, Bildern und Zeitstrahl entfernt');
  pd.loeschen(DEMO, docId);
  assert.deepStrictEqual(pd.liste(DEMO), []);
  assert.ok(!fs.existsSync(bildDatei));
  assert.strictEqual(pd.zeitstrahl(DEMO).ereignisse.length, 0);
  const idx2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lokal', 'patienten', DEMO, 'index.json'), 'utf8'));
  assert.strictEqual(idx2.N, 0);
  assert.throws(() => pd.dokument(DEMO, docId), (e) => e.status === 404);
  ok('alles entfernt');

  schritt('8. Demo zurücksetzen → wieder leer, Profil leer');
  pd.zuruecksetzen(DEMO);
  st = pd.status(DEMO);
  assert.strictEqual(st.naechsterSchritt, 'scannen');
  assert.strictEqual(pd.profil(DEMO).fehlend.length, 3);
  ok('p-demo ist leer');

  if (!OHNE_KI && !OHNE_P2) {
    schritt('9. p2-Zeitstrahl für alle Briefe (nur fehlende, einmalig)');
    const offen = pd.zeitstrahlOffen(pd.PATIENT_ADMIN);
    console.log(`   ${offen.length} Dokumente offen`);
    const t0 = Date.now();
    const r9 = await pd.aktualisiereZeitstrahl(pd.PATIENT_ADMIN, {
      parallel: 4,
      beiFortschritt: (f) => console.log(`   ${f.ok ? '✓' : '✗'} ${f.docId}${f.ok ? ` (${f.ereignisse})` : ''}`),
    });
    kiAufrufe += r9.berechnet + r9.fehler.length;
    verbrauch.eingabe += r9.verbrauch.eingabe; verbrauch.ausgabe += r9.verbrauch.ausgabe;
    console.log(`   berechnet ${r9.berechnet}, Fehler ${r9.fehler.length} ${JSON.stringify(r9.fehler)}, ${Math.round((Date.now() - t0) / 1000)} s`);
    const zs = pd.zeitstrahl(pd.PATIENT_ADMIN);
    console.log(`   Zeitstrahl p2: ${zs.ereignisse.length} Ereignisse, Zeitraum ${zs.zeitraum?.von} – ${zs.zeitraum?.bis}, offen ${zs.dokumente.offen.length}`);
    const belegt = zs.ereignisse.filter((e) => e.belegt).length;
    console.log(`   Zitate belegt: ${belegt}/${zs.ereignisse.length}`);
    for (const e of zs.ereignisse.slice(0, 12)) console.log(`   - ${e.sortDatum || '????'}${e.datumQuelle === 'dokument' ? '*' : ' '} [${e.art}] ${e.titel}`);
    console.log('   (* = Datum vom Brief übernommen)');
  }

  schritt('Fertig');
  if (!OHNE_KI) {
    // Sonnet 5.5: 2 $ / 10 $ je Mio. Token
    const kosten = verbrauch.eingabe / 1e6 * 2 + verbrauch.ausgabe / 1e6 * 10;
    console.log(`   Claude-Aufrufe: ${kiAufrufe}, Token ${verbrauch.eingabe} ein / ${verbrauch.ausgabe} aus, ca. ${kosten.toFixed(3)} $`);
  }
  console.log('   Alle Prüfungen bestanden.');
}

main().catch((e) => { console.error('FEHLER:', e.meldung || e.message); if (!e.meldung) console.error(e.stack); process.exit(1); });
