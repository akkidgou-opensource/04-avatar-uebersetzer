'use strict';
// Synthetische Arztbriefe aus daten/grascco-2027 (Kopie mit Datumsangaben bis 2027, siehe werkzeuge/daten-datieren.js)
// einem Test-Patienten zuordnen (lokal/patienten/<id>/). Fehlt die Kopie, wird daten/grascco genutzt.
// Beispiel:  node --env-file=.env werkzeuge/patient-import.js --id p2 --name "Testpatient Max Mustermann" --anzahl 15
// Optionen:  --geburtsjahr 1960   --dateien Albers.txt,Fabry.txt   --neu (vorhandenen Test-Patienten vorher löschen)
// Ausgabe nur Titel/Datum/Größe – keine Briefinhalte.
const rag = require('../rag');

function argumente(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    a[k] = v;
  }
  return a;
}

function main() {
  const a = argumente(process.argv.slice(2));
  const id = a.id || 'p2';
  const anzahl = Math.max(1, Math.min(62, Number(a.anzahl) || 15));
  if (a.neu) { try { rag.loeschePatient(id); } catch {} }
  const dateien = rag.waehleBeispielbriefe({ anzahl, namen: a.dateien ? String(a.dateien).split(',') : null });
  const r = rag.importiereAusOrdner({ patientId: id, name: a.name || 'Testpatient Max Mustermann', geburtsjahr: a.geburtsjahr, dateien });
  console.log(`Quelle: ${dateien[0] ? dateien[0].split('/').slice(0, 2).join('/') : '—'}`);
  console.log(`Test-Patient ${r.patient.id} („${r.patient.name}“): ${r.neu} neu, ${r.doppelt} schon vorhanden, ${r.fehler} Fehler.`);
  console.log(`Suchindex: ${r.chunks} Abschnitte, ${r.woerter} Suchwörter.`);
  for (const d of r.patient.dokumente) console.log(`  ${d.datum || '—'.padEnd(10)}  ${d.titel}  (${d.zeichen} Zeichen)`);
}

try { main(); } catch (e) { console.error('Fehler:', e.meldung || e.message); process.exit(1); }
