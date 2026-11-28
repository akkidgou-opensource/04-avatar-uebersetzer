'use strict';
// Test des Wissensspeichers: baut Test-Patient p2 aus daten/grascco auf und stellt 5 Beispielfragen an Claude.
// Aufruf:  node --env-file=.env werkzeuge/rag-test.js        (max. 10 API-Aufrufe: je Frage 1x Suche + 1x Antwort)
// Optionen: --ohne-ki (nur Suche, keine API-Aufrufe)   --ohne-aufbau (p2 nicht neu aufbauen)
// Nur synthetische Testdaten; die Ausgabe erscheint nur hier im Terminal (der Server loggt keine Inhalte).
const fs = require('fs');
const path = require('path');
const rag = require('../rag');

const FRAGEN = [
  { frage: 'Welche Medikamente nehme ich?' },
  { frage: 'Was war beim Herz los?', streaming: true },
  { frage: 'Wann war ich zuletzt im Krankenhaus?' },
  { frage: 'Habe ich Allergien?' },
  { frage: 'Und was wurde da gegen den Krebs gemacht?', verlauf: [
    { rolle: 'nutzer', text: 'Hatte ich mal eine Krebserkrankung?' },
    { rolle: 'avatar', text: 'Ja, in deinen Unterlagen ist ein Rektumkarzinom beschrieben.' },
  ], streaming: true },
];

const kurz = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const ein = (t) => String(t).replace(/\s+/g, ' ').trim();

async function main() {
  const ohneKi = process.argv.includes('--ohne-ki');
  if (!process.argv.includes('--ohne-aufbau')) {
    const dateien = require('fs').readdirSync(path.join(__dirname, '..', 'daten', 'grascco')).length && null;
    void dateien;
    const { execFileSync } = require('child_process');
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, 'patient-import.js'), '--id', 'p2', '--anzahl', '15', '--neu']).toString().split('\n').slice(0, 2).join('\n') + '\n');
  }
  let systemprompt = '';
  try { systemprompt = fs.readFileSync(path.join(__dirname, '..', 'prompt', 'gespraech.md'), 'utf8'); } catch {}
  if (systemprompt.includes('<!-- PLATZHALTER')) systemprompt = '';

  for (const f of FRAGEN) {
    console.log(`\n=== ${f.frage}${f.streaming ? '  (Streaming)' : ''}`);
    if (ohneKi) {
      for (const t of rag.suche('p2', { frage: f.frage, k: 6 })) console.log(`  ${t.score.toFixed(2)}  ${t.chunkId}  ${t.titel} ${t.datum || ''} · ${t.abschnitt}`);
      continue;
    }
    const saetze = [];
    const t0 = Date.now();
    let ersterSatzMs = null;
    try {
      const r = await rag.antworteMitQuellen({
        patientId: 'p2', frage: f.frage, verlauf: f.verlauf || [], systemprompt, streaming: !!f.streaming,
        beiSatz: f.streaming ? (s) => { if (ersterSatzMs === null) ersterSatzMs = Date.now() - t0; saetze.push(s); } : undefined,
      });
      console.log(`Suchbegriffe: ${r.suchbegriffe.join(', ') || '(keine)'}`);
      console.log(`Treffer: ${r.treffer.map((t) => t.chunkId).join(', ')}`);
      console.log(`Antwort: ${kurz(r.text, 400)}`);
      console.log(`Mit Markern: ${kurz(r.textMitMarkern, 400)}`);
      if (f.streaming) console.log(`Sätze gestreamt: ${saetze.length}, erster Satz nach ${ersterSatzMs} ms`);
      console.log(`Quellen (${r.quellen.length}):`);
      for (const q of r.quellen) console.log(`  [${q.nr}] ${q.titel} · ${q.datum || 'ohne Datum'} · ${q.abschnitt} · Stelle ${q.start}-${q.ende}\n       „${kurz(ein(q.zitat), 140)}“`);
      // Stelle prüfen: das Zitat muss genau an start/ende im gespeicherten Dokument stehen.
      const falsch = r.quellen.filter((q) => ein(rag.ladeDokument('p2', q.docId).text.slice(q.start, q.ende)) !== ein(q.zitat)).length;
      console.log(`Zitatstellen geprüft: ${r.quellen.length - falsch} ok, ${falsch} abweichend`);
      console.log(`Zeiten: gesamt ${r.dauerMs} ms (Erweiterung ${r.zeiten.erweiterungMs} ms, Suche ${r.zeiten.sucheMs} ms, erster Text ${r.zeiten.ersteTextMs ?? '–'} ms) · Modell ${r.modell} · Stopp ${r.stopGrund}`);
    } catch (e) {
      console.log(`Fehler: ${e.meldung || e.message}`);
    }
  }
}
main();
