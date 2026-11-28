'use strict';
// Test für gedaechtnis.js (nur synthetische Daten, Inhalte werden nur hier im Terminal gezeigt, nie geloggt).
//
//   node werkzeuge/gedaechtnis-test.js --ohne-ki            # nur Speicher/Abruf/Löschen, kein Claude
//   node --env-file=.env werkzeuge/gedaechtnis-test.js      # + Gespräch simulieren und Fragen stellen (ca. 12 Claude-Aufrufe)
//   node --env-file=.env werkzeuge/gedaechtnis-test.js --p2 # zusätzlich: p2 einmalig aus seinen 15 Briefen befüllen (15 Haiku-Aufrufe)
//
// Der Testpatient liegt in einem Wegwerf-Ordner (nicht in lokal/), damit p2 und p-demo unberührt bleiben.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PROJEKT = path.join(__dirname, '..');
const rag = require(path.join(PROJEKT, 'rag'));
const pd = require(path.join(PROJEKT, 'patientendaten'));
const g = require(path.join(PROJEKT, 'gedaechtnis'));

const OHNE_KI = process.argv.includes('--ohne-ki');
const P2 = process.argv.includes('--p2');
const ergebnisse = [];
function ok(name, bedingung, info = '') {
  ergebnisse.push({ name, ok: !!bedingung, info });
  console.log(`${bedingung ? '✔' : '✘'} ${name}${info ? ' – ' + info : ''}`);
}
function systemprompt() {
  const roh = fs.readFileSync(path.join(PROJEKT, 'prompt', 'gespraech.md'), 'utf8');
  return roh.replace(/<!--[\s\S]*?-->/g, '').trim();
}

async function ohneKi(pid) {
  // Fakten von Hand einspielen (gleiches Format wie lerneAusGespraech) → Abruf/Anzeige/Löschen prüfen.
  const datei = path.join(TMP, pid, 'gedaechtnis.json');
  const zeit = new Date().toISOString();
  fs.mkdirSync(path.dirname(datei), { recursive: true });
  fs.writeFileSync(datei, JSON.stringify({
    zusammenfassung: 'Hausarzt Dr. Sommer, Penicillin-Allergie.',
    fakten: [
      { id: 'g-aaaa1111', art: 'person', text: 'Hausarzt heißt Dr. Sommer', quelle: { typ: 'gespraech', zeit, zitat: 'Mein Hausarzt heißt Dr. Sommer' }, sicher: true, aktualisiert: zeit },
      { id: 'g-bbbb2222', art: 'allergie', text: 'Allergie gegen Penicillin', quelle: { typ: 'gespraech', zeit, zitat: 'Penicillin-Allergie' }, sicher: true, aktualisiert: zeit },
      { id: 'd-cccc3333', art: 'medikament', text: 'Tambocor 100 mg morgens und abends', quelle: { typ: 'dokument', zeit, docId: 'xavier', titel: 'Arztbrief', datum: '2022-02-10', zitat: 'Tambocor 100 mg 1-0-1', start: 1, ende: 20 }, sicher: true, aktualisiert: zeit },
    ],
    verlauf: [], dokumente: {},
  }));
  const k = g.kontextFuerFrage({ patientId: pid, frage: 'Worauf bin ich allergisch?' });
  ok('Kontextblock enthält Allergie und Quelle', /Penicillin/.test(k.text) && /hast du mir vorhin erzählt/.test(k.text));
  ok('Kontextblock: Dokument-Fakt nur wenn passend', !/Tambocor/.test(k.text));
  const k2 = g.kontextFuerFrage({ patientId: pid, frage: 'Welche Medikamente nehme ich?' });
  ok('Medikamenten-Frage findet Dokument-Fakt', /Tambocor/.test(k2.text) && /Arztbrief vom 10.2.2022/.test(k2.text));
  ok('Weiche: Gedächtnisfragen erkannt', g.istGedaechtnisFrage('Wie heißt mein Hausarzt?') && g.istGedaechtnisFrage('Was hab ich dir vorhin erzählt?') && g.istGedaechtnisFrage('Wie war das mit Dr. Sommer?', pid));
  ok('Weiche: Sachfrage nicht als Gedächtnisfrage', !g.istGedaechtnisFrage('Was ist ein Betablocker?', pid));
  const q = g.quellenAusAntwort({ fakten: k.fakten, antwort: 'Du hast mir erzählt, dass du eine Allergie gegen Penicillin hast.' });
  ok('Quellen aus Antwort', q.length === 1 && q[0].quelleText.startsWith('Du hast mir am'));
  const t0 = Date.now();
  const p = g.lerneAusGespraech({ patientId: pid, nutzerText: 'Danke!', avatarText: 'Gern!' });
  ok('lerneAusGespraech blockiert nicht', Date.now() - t0 < 50, `${Date.now() - t0} ms`);
  const r = await p;
  ok('Floskel ohne KI übersprungen', r.uebersprungen === true);
  ok('Archiv speichert Verlauf', g.verlauf(pid, 10).length === 2);
  const ex = g.loescheFakt(pid, 'g-aaaa1111');
  ok('Einzelnen Fakt löschen', ex.fakten.length === 2 && !ex.fakten.some((f) => f.id === 'g-aaaa1111'));
  ok('Export-Format', ex.anzahl.gespraech === 1 && ex.anzahl.dokument === 1 && ex.fakten[0].quelleText);
  const mode = fs.statSync(datei).mode & 0o777;
  ok('Datei 0600', mode === 0o600, mode.toString(8));
  try { g.loescheFakt(pid, '../x'); ok('Ungültige ID abgelehnt', false); } catch (e) { ok('Ungültige ID abgelehnt', e.status === 400); }
  g.vergiss(pid);
  ok('vergiss löscht alles', !fs.existsSync(datei) && g.exportiere(pid).fakten.length === 0);
}

async function mitKi(pid) {
  // 1. Unterlagen lernen (2 Briefe → 2 Haiku-Aufrufe)
  let t = Date.now();
  const d = await g.lerneAlleDokumente(pid, { parallel: 2 });
  ok('Unterlagen gelernt', d.gelernt === 2 && d.fehler.length === 0, `${d.neu} Angaben, ${Date.now() - t} ms`);
  const exD = g.exportiere(pid);
  const belegt = exD.fakten.filter((f) => f.quelleTyp === 'dokument' && f.start !== null).length;
  ok('Dokument-Fakten mit belegtem Zitat', belegt >= Math.ceil(exD.anzahl.dokument * 0.8), `${belegt}/${exD.anzahl.dokument}`);
  const d2 = await g.lerneAlleDokumente(pid);
  ok('Unveränderte Unterlagen: kein neuer KI-Aufruf', d2.ausCache === 2 && d2.gelernt === 0);

  // 2. Gespräch simulieren (5 Haiku-Aufrufe; „Danke“ wird ohne KI übersprungen)
  const runden = [
    ['Mein Hausarzt heißt übrigens Dr. Sommer.', 'Gut zu wissen! Seit wann bist du bei Dr. Sommer?'],
    ['Ich habe eine Penicillin-Allergie.', 'Danke, das merke ich mir. Hattest du schon mal eine starke Reaktion?'],
    ['Mir ist seit gestern schwindelig.', 'Oh, das ist unangenehm. Wird es beim Aufstehen schlimmer?'],
    ['Ich nehme morgens Ramipril 5 mg.', 'Okay, Ramipril ist ein Blutdruckmittel. Verträgst du es gut?'],
    ['Dr. Sommer hat das Ramipril erhöht, ich nehme jetzt 10 mg statt 5 mg.', 'Alles klar, dann nimmst du jetzt 10 mg.'],
    ['Danke!', 'Gern!'],
  ];
  for (const [nutzerText, avatarText] of runden) {
    t = Date.now();
    const r = await g.lerneAusGespraech({ patientId: pid, nutzerText, avatarText, sprache: 'de' });
    console.log(`   Runde „${nutzerText.slice(0, 40)}…“ → ${JSON.stringify(r)} (${Date.now() - t} ms)`);
  }
  const ex = g.exportiere(pid);
  const gespr = ex.fakten.filter((f) => f.quelleTyp === 'gespraech');
  console.log('   Gesprächs-Fakten:', gespr.map((f) => `[${f.art}] ${f.text}`).join(' | '));
  console.log('   Zusammenfassung:', ex.zusammenfassung);
  ok('Hausarzt gemerkt', gespr.some((f) => /Sommer/.test(f.text)));
  ok('Allergie gemerkt', gespr.some((f) => f.art === 'allergie' && /Penicillin/i.test(f.text)));
  ok('Schwindel mit Datum gemerkt', gespr.some((f) => /schwindel/i.test(f.text) && /\d{1,2}\.\d{1,2}\.|\d{4}-\d{2}-\d{2}/.test(f.text)));
  const rami = gespr.filter((f) => /Ramipril/i.test(f.text));
  ok('Dosis ersetzt statt verdoppelt', rami.length === 1 && /10/.test(rami[0].text) && !/\b5 mg/.test(rami[0].text), rami.map((f) => f.text).join(' / '));
  ok('Zusammenfassung ≤ 600 Zeichen', ex.zusammenfassung.length > 0 && ex.zusammenfassung.length <= 600);

  // 3. Fragen (5 Claude-Sonnet-Aufrufe über denselben Weg wie server.js: rag.antworteMitQuellen + Gedächtnis im Systemkontext)
  const fragen = [
    ['Wie heißt mein Hausarzt?', /Sommer/],
    ['Worauf bin ich allergisch?', /Penicillin/i],
    ['Seit wann ist mir schwindelig?', /gestern|\d{1,2}\.\s*(11|November)/i],
    ['Welches Medikament gegen Herzrhythmusstörungen steht in meinem Arztbrief?', /Tambocor|Flecainid/i],
    ['Wie viel Ramipril nehme ich jetzt, und welches Herzrhythmus-Medikament steht in meinen Unterlagen?', /10.*(Tambocor|Flecainid)|(Tambocor|Flecainid).*10/is],
  ];
  const basis = systemprompt();
  for (const [frage, erwartet] of fragen) {
    t = Date.now();
    const k = g.kontextFuerFrage({ patientId: pid, frage });
    const r = await rag.antworteMitQuellen({ patientId: pid, frage, systemprompt: basis + '\n\n' + k.text, erweitern: false });
    const gq = g.quellenAusAntwort({ fakten: k.fakten, antwort: r.text });
    console.log(`   F: ${frage}\n   A: ${r.text}\n   Quellen: Unterlagen ${r.quellen.length}, Gedächtnis ${gq.map((f) => f.quelleText + ': ' + f.text).join(' | ') || '-'} (${Date.now() - t} ms, Block ${k.text.length} Zeichen)`);
    ok(`Antwort exakt: ${frage}`, erwartet.test(r.text));
  }
}

let TMP;
(async () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gedaechtnis-test-'));
  rag.setzeBasis(TMP); pd.setzeBasis(TMP); g.setzeBasis(TMP);
  const pid = 'p-gedtest';
  try {
    rag.importiereAusOrdner({ patientId: pid, name: 'Testpatient Gedächtnis', dateien: rag.waehleBeispielbriefe({ namen: ['Xavier', 'Gebauer'] }) });
    await ohneKi(pid);
    if (!OHNE_KI) await mitKi(pid);
  } catch (e) {
    ok('Ablauf ohne Ausnahme', false, `${e.status || ''} ${e.meldung || e.message}`);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  if (P2 && !OHNE_KI) {
    // p2 einmalig befüllen (echter Ordner lokal/patienten/p2). Bereits gelernte Briefe werden übersprungen.
    const echt = path.join(PROJEKT, 'lokal', 'patienten');
    rag.setzeBasis(echt); pd.setzeBasis(echt); g.setzeBasis(echt);
    const t = Date.now();
    const r = await g.lerneAlleDokumente('p2', { parallel: 4 });
    ok('p2 aus Unterlagen befüllt', r.fehler.length === 0, `${r.gelernt} Briefe neu, ${r.ausCache} schon gelernt, ${r.neu} Angaben, ${Date.now() - t} ms`);
    const ex = g.exportiere('p2');
    console.log('   p2 je Art:', Object.entries(ex.fakten.reduce((a, f) => ({ ...a, [f.art]: (a[f.art] || 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', '));
  }
  const fehl = ergebnisse.filter((e) => !e.ok);
  console.log(`\n${ergebnisse.length - fehl.length}/${ergebnisse.length} bestanden`);
  process.exit(fehl.length ? 1 : 0);
})();
