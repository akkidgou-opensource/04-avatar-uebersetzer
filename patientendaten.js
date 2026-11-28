'use strict';
// ---------------------------------------------------------------------------------------------
// patientendaten.js – Unterlagen, Zeitstrahl, Gesundheitsangaben und Onboarding für Test-Patienten
// (nur synthetische Testdaten, nur Node-Bordmittel). Baut auf rag.js auf (nur per require).
//
// Speicherort je Test-Patient: lokal/patienten/<patientId>/
//   patient.json, index.json, dokumente/<docId>.txt   ← gehören rag.js
//   patientendaten.json   ← Zusatzangaben je Dokument (Typ „foto“, Seitenbilder) + Gesundheitsprofil
//   zeitstrahl.json       ← zwischengespeicherte Ereignisse je Dokument (mit Prüfsumme des Textes)
//   bilder/<docId>-<n>.jpg ← optionale Scan-Seitenbilder
// Dateien 0600, Ordner 0700, atomar geschrieben. Inhalte werden NIE geloggt (nur Status/Anzahl).
// ---------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rag = require('./rag');

let BASIS = path.join(__dirname, 'lokal', 'patienten');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const MODELL_STANDARD = 'claude-sonnet-5-5';
const FALLBACK_MODELLE = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const OHNE_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];
const EXTRAKTION_TIMEOUT_MS = 120 * 1000;
const EXTRAKTION_MAX_TOKENS = 8000;
const MAX_TEXT_ZEICHEN = 60000;      // längere Dokumente werden nicht still gekürzt, sondern abgelehnt
const MAX_EREIGNISSE = 12;
const MAX_ZITAT = 300;

const MAX_BILDER = 20;
const MAX_BILD_BYTES = 8 * 1024 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ISO_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

// Nutzer ↔ Test-Patient (Standard). admin hat schon Unterlagen (p2), demo startet leer (p-demo).
const PATIENT_ADMIN = 'p2';
const PATIENT_DEMO = 'p-demo';
const ZURUECKSETZBAR = new Set([PATIENT_DEMO]);   // p2 wird nie versehentlich geleert

const TYPEN = ['arztbrief', 'scan', 'upload', 'foto'];
const ARTEN = ['diagnose', 'behandlung', 'op', 'untersuchung', 'medikation', 'aufenthalt', 'sonstiges'];
const QUELLEN = ['gespraech', 'scan'];

// <!-- PLATZHALTER: Welche Gesundheitsangaben beim Onboarding gesammelt werden, legt das Team fest.
//      Vorläufig die drei im Auftrag genannten Felder (organisatorisch, keine Bewertung). -->
const PROFIL_FELDER = ['erkrankungen', 'medikamente', 'allergien'];
const PROFIL_PFLICHT = ['erkrankungen', 'medikamente', 'allergien'];
const MAX_PROFIL_EINTRAEGE = 50;
const MAX_PROFIL_WERT = 300;

// ---------- Fehler (gleiche Form wie rag.js/kiFehler: status + meldung) ----------
function pdFehler(status, meldung) {
  const e = new Error(meldung);
  e.status = status;
  e.meldung = meldung;
  return e;
}

// ---------- Dateien ----------
function setzeBasis(ordner) { BASIS = ordner; rag.setzeBasis(ordner); }
function pruefeId(patientId) {
  if (!ID_RE.test(String(patientId || ''))) throw pdFehler(400, 'Ungültige Patienten-ID (nur Buchstaben, Ziffern, - und _).');
  return patientId;
}
function pruefeDocId(docId) {
  if (!DOC_ID_RE.test(String(docId || ''))) throw pdFehler(400, 'Ungültige Dokument-ID.');
  return docId;
}
function ordner(patientId) { return path.join(BASIS, pruefeId(patientId)); }
function schreibeAtomar(datei, inhalt) {
  fs.mkdirSync(path.dirname(datei), { recursive: true, mode: 0o700 });
  const tmp = `${datei}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, inhalt, { mode: 0o600 });
  fs.renameSync(tmp, datei);
}
function leseJson(datei, ersatz) {
  try { return JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { return ersatz; }
}
function pruefsumme(text) { return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16); }

function ladeZusatz(patientId) {
  const z = leseJson(path.join(ordner(patientId), 'patientendaten.json'), null) || {};
  if (!z.dokumente || typeof z.dokumente !== 'object') z.dokumente = {};
  if (!z.profil || typeof z.profil !== 'object') z.profil = {};
  for (const f of PROFIL_FELDER) if (!Array.isArray(z.profil[f])) z.profil[f] = [];
  return z;
}
function speichereZusatz(patientId, z) {
  z.geaendertAm = new Date().toISOString();
  schreibeAtomar(path.join(ordner(patientId), 'patientendaten.json'), JSON.stringify(z, null, 2));
}
function ladeZeitstrahlCache(patientId) {
  const c = leseJson(path.join(ordner(patientId), 'zeitstrahl.json'), null) || {};
  if (!c.dokumente || typeof c.dokumente !== 'object') c.dokumente = {};
  return c;
}
function speichereZeitstrahlCache(patientId, c) {
  c.version = 1;
  c.geaendertAm = new Date().toISOString();
  schreibeAtomar(path.join(ordner(patientId), 'zeitstrahl.json'), JSON.stringify(c));
}
// patient.json gehört rag.js; für das Umbenennen schreiben wir es im gleichen Format (atomar) zurück.
function schreibePatientJson(p) {
  p.dokumente.sort((a, b) => String(a.datum || '9999').localeCompare(String(b.datum || '9999')));
  schreibeAtomar(path.join(ordner(p.id), 'patient.json'), JSON.stringify(p, null, 2));
}
function patientOderNull(patientId) {
  try { return rag.ladePatient(patientId); } catch (e) { if (e.status === 404) return null; throw e; }
}

// =============================================================================================
// 1. Nutzer ↔ Patient
// =============================================================================================
function nutzerName(n) { return String(n || '').toLowerCase().trim(); }
// Standard-Zuordnung aus .env: ADMIN_USER → p2 (hat Unterlagen), DEMO_USER → p-demo (leer).
function standardZuordnung() {
  const z = {};
  if (process.env.ADMIN_USER) z[nutzerName(process.env.ADMIN_USER)] = PATIENT_ADMIN;
  if (process.env.DEMO_USER) z[nutzerName(process.env.DEMO_USER)] = PATIENT_DEMO;
  return z;
}
function patientFuerNutzer(username) {
  return standardZuordnung()[nutzerName(username)] || null;
}
// Legt fehlende Test-Patienten an: p-demo leer; p2 mit 15 GraSCCo-Briefen (nur wenn er ganz fehlt).
function richteTestpatientenEin({ p2Importieren = true } = {}) {
  const ergebnis = { [PATIENT_ADMIN]: 'vorhanden', [PATIENT_DEMO]: 'vorhanden' };
  if (!patientOderNull(PATIENT_DEMO)) {
    legeLeerenDemoPatientAn();
    ergebnis[PATIENT_DEMO] = 'angelegt';
  }
  if (!patientOderNull(PATIENT_ADMIN) && p2Importieren) {
    rag.importiereAusOrdner({ patientId: PATIENT_ADMIN, name: 'Testpatient Max Mustermann', dateien: rag.waehleBeispielbriefe({ anzahl: 15 }) });
    ergebnis[PATIENT_ADMIN] = 'angelegt';
  }
  return ergebnis;
}
function legeLeerenDemoPatientAn() {
  return rag.legePatientAn({
    patientId: PATIENT_DEMO,
    name: 'Demo-Testperson',
    hinweis: 'Synthetischer Demo-Patient. Startet ohne Unterlagen; hier nur Testdaten scannen.',
  });
}
// Für die Demo: Patient komplett leeren (Unterlagen, Bilder, Zeitstrahl, Profil) und leer neu anlegen.
// Nur für zurücksetzbare Patienten (p-demo), außer erzwingen:true.
function zuruecksetzen(patientId, { erzwingen = false } = {}) {
  pruefeId(patientId);
  if (!ZURUECKSETZBAR.has(patientId) && !erzwingen) throw pdFehler(403, 'Dieser Test-Patient kann nicht zurückgesetzt werden.');
  rag.loeschePatient(patientId);
  const p = patientId === PATIENT_DEMO ? legeLeerenDemoPatientAn() : rag.legePatientAn({ patientId });
  rag.baueIndex(patientId);
  return { patientId, dokumente: p.dokumente.length };
}

// =============================================================================================
// 2. Dokumente
// =============================================================================================
function bildDateien(patientId, docId) {
  const o = path.join(ordner(patientId), 'bilder');
  let namen = [];
  try { namen = fs.readdirSync(o); } catch { return []; }
  const re = new RegExp(`^${docId.replace(/[-]/g, '\\-')}-(\\d+)\\.jpg$`);
  return namen.map((n) => ({ n, m: n.match(re) })).filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1])).map((x) => path.join(o, x.n));
}
function metaAusgabe(d, zusatz, cache) {
  const extra = zusatz.dokumente[d.docId] || {};
  const zs = cache && cache.dokumente[d.docId];
  return {
    docId: d.docId,
    titel: d.titel,
    datum: d.datum || null,
    typ: extra.typ || d.typ,
    quelle: d.quelle || null,
    zeichen: d.zeichen,
    erstelltAm: d.hinzugefuegtAm || null,
    seiten: extra.seiten || 0,
    ereignisse: zs ? zs.ereignisse.length : null,   // null = Zeitstrahl für dieses Dokument noch nicht berechnet
  };
}
// Liste der Unterlagen (nach Datum sortiert, ohne Datum am Ende).
function liste(patientId) {
  const p = rag.ladePatient(patientId);
  const zusatz = ladeZusatz(patientId);
  const cache = ladeZeitstrahlCache(patientId);
  return p.dokumente.map((d) => metaAusgabe(d, zusatz, cache));
}
// Ein Dokument mit Volltext (+ Adressen der Seitenbilder, falls vorhanden).
function dokument(patientId, docId) {
  pruefeDocId(docId);
  const d = rag.ladeDokument(patientId, docId);
  const meta = metaAusgabe(d, ladeZusatz(patientId), ladeZeitstrahlCache(patientId));
  return { ...meta, text: d.text, bilder: Array.from({ length: meta.seiten }, (_, i) => i + 1) };
}
// Seitenbild (1-basiert) als Buffer – die Route liefert es mit Content-Type image/jpeg aus.
function bild(patientId, docId, seite) {
  pruefeDocId(docId);
  rag.ladeDokument(patientId, docId);   // 404, wenn es das Dokument nicht gibt
  const n = Number(seite);
  const dateien = bildDateien(patientId, docId);
  if (!Number.isInteger(n) || n < 1 || n > dateien.length) throw pdFehler(404, 'Diese Seite gibt es nicht.');
  return { mime: 'image/jpeg', daten: fs.readFileSync(dateien[n - 1]) };
}
function umbenennen(patientId, docId, { titel, datum } = {}) {
  pruefeDocId(docId);
  const p = rag.ladePatient(patientId);
  const d = p.dokumente.find((x) => x.docId === docId);
  if (!d) throw pdFehler(404, 'Dokument nicht gefunden.');
  if (titel !== undefined) {
    const t = String(titel || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!t) throw pdFehler(400, 'Der Titel darf nicht leer sein.');
    d.titel = t;
  }
  if (datum !== undefined) {
    if (datum === null || datum === '') d.datum = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(datum)) && !Number.isNaN(Date.parse(datum))) d.datum = String(datum);
    else throw pdFehler(400, 'Datum bitte als JJJJ-MM-TT.');
  }
  schreibePatientJson(p);
  rag.baueIndex(patientId);   // Titel/Datum stehen auch in den Suchabschnitten
  return metaAusgabe(d, ladeZusatz(patientId), ladeZeitstrahlCache(patientId));
}
function loeschen(patientId, docId) {
  pruefeDocId(docId);
  rag.entferneDokument(patientId, docId);   // entfernt Text + baut den Suchindex neu
  for (const f of bildDateien(patientId, docId)) fs.rmSync(f, { force: true });
  const z = ladeZusatz(patientId);
  if (z.dokumente[docId]) { delete z.dokumente[docId]; speichereZusatz(patientId, z); }
  const c = ladeZeitstrahlCache(patientId);
  if (c.dokumente[docId]) { delete c.dokumente[docId]; speichereZeitstrahlCache(patientId, c); }
  return { geloescht: docId };
}
// bilder: [Buffer | base64-String | data:image/jpeg;base64,…] – nur JPEG.
function jpegAus(b) {
  let buf;
  if (Buffer.isBuffer(b)) buf = b;
  else if (typeof b === 'string') {
    const b64 = b.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw pdFehler(400, 'Ein Seitenbild ist kein gültiges Base64.');
    buf = Buffer.from(b64, 'base64');
  } else throw pdFehler(400, 'Ein Seitenbild hat ein unbekanntes Format.');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw pdFehler(400, 'Seitenbilder bitte als JPEG.');
  if (buf.length > MAX_BILD_BYTES) throw pdFehler(413, 'Ein Seitenbild ist zu groß (max. 8 MB).');
  return buf;
}
// Neues Dokument: Text (Abschrift/Upload) + optional Seitenbilder. Legt es in den Suchindex.
// Rückgabe: { doppelt, dokument }
function neu(patientId, { titel, text, typ = 'upload', bilder = [], datum, quelle = null } = {}) {
  if (!TYPEN.includes(typ)) throw pdFehler(400, 'Unbekannter Dokumenttyp.');
  if (!Array.isArray(bilder)) throw pdFehler(400, 'bilder muss eine Liste sein.');
  if (bilder.length > MAX_BILDER) throw pdFehler(413, `Höchstens ${MAX_BILDER} Seiten auf einmal.`);
  const jpegs = bilder.map(jpegAus);   // erst prüfen, dann speichern
  const ragTyp = typ === 'foto' ? 'scan' : typ;   // rag.js kennt „foto“ nicht; der Typ steht in patientendaten.json
  const t = String(titel || '').trim() || rag.erkenneTitel(String(text || ''));   // Titel ergibt auch die docId
  const r = rag.fuegeDokumentHinzu({ patientId, titel: t, text, typ: ragTyp, quelle, datum });
  if (r.doppelt) return { doppelt: true, dokument: metaAusgabe(r.dokument, ladeZusatz(patientId), ladeZeitstrahlCache(patientId)) };
  const docId = r.dokument.docId;
  const bo = path.join(ordner(patientId), 'bilder');
  jpegs.forEach((buf, i) => schreibeAtomar(path.join(bo, `${docId}-${i + 1}.jpg`), buf));
  const z = ladeZusatz(patientId);
  z.dokumente[docId] = { typ, seiten: jpegs.length };
  speichereZusatz(patientId, z);
  return { doppelt: false, dokument: metaAusgabe(r.dokument, z, ladeZeitstrahlCache(patientId)) };
}

// =============================================================================================
// 3. Zeitstrahl (Ereignisse per Claude, strukturierte JSON-Ausgabe)
// =============================================================================================
// Rein technische Extraktions-Anweisung: nur übernehmen, was im Text steht; nichts bewerten oder ergänzen.
const EXTRAKTION_ANWEISUNG = [
  'Du liest ein deutsches medizinisches Dokument (synthetische Testdaten) und listest die darin beschriebenen Ereignisse für einen Zeitstrahl auf.',
  'Regeln:',
  '- Nimm nur auf, was ausdrücklich im Text steht. Nichts ergänzen, nichts vermuten, nichts bewerten, keine Empfehlungen.',
  '- datum: ISO-Format, so genau wie im Text angegeben: JJJJ-MM-TT, JJJJ-MM oder JJJJ. Relative Angaben („vor 3 Jahren“) nur umrechnen, wenn das Bezugsdatum im Text steht. Sonst leerer Text.',
  `- art: eine von ${ARTEN.join(', ')}.`,
  '- titel: höchstens 6 Wörter, in Alltagssprache verständlich (Fachwort darf in Klammern dahinter stehen).',
  '- beschreibung: ein kurzer Satz in einfacher Sprache, nur mit Inhalten aus dem Text.',
  `- zitat: eine wörtlich und zeichengenau kopierte, zusammenhängende Stelle aus dem Text (höchstens ${MAX_ZITAT - 100} Zeichen), die das Ereignis belegt.`,
  `- Höchstens ${MAX_EREIGNISSE} Ereignisse, die wichtigsten zuerst. Gleiche Ereignisse nur einmal.`,
  '- Steht kein Ereignis im Text, gib eine leere Liste zurück.',
].join('\n');
const EREIGNIS_SCHEMA = {
  type: 'object',
  properties: {
    ereignisse: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          datum: { type: 'string' },
          art: { type: 'string', enum: ARTEN },
          titel: { type: 'string' },
          beschreibung: { type: 'string' },
          zitat: { type: 'string' },
        },
        required: ['datum', 'art', 'titel', 'beschreibung', 'zitat'],
        additionalProperties: false,
      },
    },
  },
  required: ['ereignisse'],
  additionalProperties: false,
};

function apiSchluessel(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw pdFehler(503, 'Der API-Schlüssel fehlt noch (ANTHROPIC_API_KEY in .env).');
  return key;
}
function zeitstrahlModell(model) {
  return model || (process.env.ANTHROPIC_MODEL_ZEITSTRAHL || '').trim() || (process.env.ANTHROPIC_MODEL || '').trim() || MODELL_STANDARD;
}
function meldungZuStatus(status) {
  if (status === 401 || status === 403) return 'Der API-Schlüssel wurde abgelehnt.';
  if (status === 404) return 'Das KI-Modell ist unbekannt.';
  if (status === 429 || status === 529) return 'Der KI-Dienst ist gerade ausgelastet. Bitte kurz warten.';
  if (status >= 500) return 'Der KI-Dienst ist gerade nicht erreichbar.';
  return 'Der KI-Dienst hat die Anfrage nicht angenommen.';
}
function normDatum(d) {
  const m = String(d || '').trim().match(ISO_RE);
  if (!m) return { datum: null, genauigkeit: null };
  const [, j, mo, t] = m;
  if (mo && (Number(mo) < 1 || Number(mo) > 12)) return { datum: j, genauigkeit: 'jahr' };
  if (t && (Number(t) < 1 || Number(t) > 31)) return { datum: `${j}-${mo}`, genauigkeit: 'monat' };
  return { datum: m[0], genauigkeit: t ? 'tag' : mo ? 'monat' : 'jahr' };
}
// Zitat im Volltext suchen (exakt, sonst mit zusammengefassten Leerzeichen) → start/ende für die Markierung.
function findeZitat(text, zitat) {
  const z = String(zitat || '').trim();
  if (!z) return null;
  let i = text.indexOf(z);
  if (i >= 0) return { start: i, ende: i + z.length };
  const teile = z.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!teile.length) return null;
  const m = new RegExp(teile.join('\\s+')).exec(text);
  return m ? { start: m.index, ende: m.index + m[0].length } : null;
}
function saeubere(t, max) { return String(t || '').replace(/\s+/g, ' ').replace(/[*#`|]/g, '').trim().slice(0, max); }

async function claudeEreignisse(text, { model, apiKey } = {}) {
  const key = apiSchluessel(apiKey);
  const m = zeitstrahlModell(model);
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
  const body = {
    model: m,
    max_tokens: EXTRAKTION_MAX_TOKENS,
    system: EXTRAKTION_ANWEISUNG,
    messages: [{ role: 'user', content: `<dokument>\n${text}\n</dokument>\n\nListe die Ereignisse für den Zeitstrahl auf.` }],
    output_config: { format: { type: 'json_schema', schema: EREIGNIS_SCHEMA } },
  };
  if (!OHNE_EFFORT.includes(m)) body.output_config.effort = 'low';
  if (FALLBACK_MODELLE.includes(m)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EXTRAKTION_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    daten = await r.json().catch(() => null);
  } catch (e) {
    throw pdFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die Zeitstrahl-Auswertung hat zu lange gedauert.' : 'Keine Verbindung zum KI-Dienst.');
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    console.log(`Zeitstrahl: Auswertung fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw pdFehler(502, meldungZuStatus(r.status));
  }
  if (daten?.stop_reason === 'refusal') throw pdFehler(502, 'Die KI hat die Auswertung abgelehnt.');
  if (daten?.stop_reason === 'max_tokens') throw pdFehler(502, 'Die Auswertung war zu lang. Bitte erneut versuchen.');
  const roh = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json;
  try { json = JSON.parse(roh); } catch { throw pdFehler(502, 'Die KI-Antwort war kein gültiges JSON.'); }
  return {
    ereignisse: Array.isArray(json?.ereignisse) ? json.ereignisse : [],
    modell: daten?.model || m,
    verbrauch: { eingabe: daten?.usage?.input_tokens || 0, ausgabe: daten?.usage?.output_tokens || 0 },
  };
}

// Ereignisse eines Dokuments berechnen (oder aus dem Zwischenspeicher holen).
// Rückgabe: { docId, ereignisse:[…], ausCache, modell?, verbrauch? }
async function extrahiereEreignisse(patientId, docId, { model, apiKey, erzwingen = false } = {}) {
  pruefeDocId(docId);
  const d = rag.ladeDokument(patientId, docId);
  const summe = pruefsumme(d.text);
  const vorher = ladeZeitstrahlCache(patientId).dokumente[docId];
  if (vorher && vorher.pruefsumme === summe && !erzwingen) return { docId, ereignisse: vorher.ereignisse, ausCache: true };
  if (d.text.length > MAX_TEXT_ZEICHEN) throw pdFehler(413, 'Das Dokument ist zu lang für den Zeitstrahl.');
  const ki = await claudeEreignisse(d.text, { model, apiKey });
  const ereignisse = ki.ereignisse.slice(0, MAX_EREIGNISSE).map((e, i) => {
    const { datum, genauigkeit } = normDatum(e.datum);
    const zitat = saeubere(e.zitat, MAX_ZITAT);
    const stelle = findeZitat(d.text, e.zitat);
    return {
      id: `${docId}~${i + 1}`,
      datum, datumGenauigkeit: genauigkeit,
      art: ARTEN.includes(e.art) ? e.art : 'sonstiges',
      titel: saeubere(e.titel, 80) || 'Ereignis',
      beschreibung: saeubere(e.beschreibung, 300),
      docId,
      zitat,
      belegt: !!stelle,                      // false = Zitat nicht wörtlich im Text gefunden
      start: stelle ? stelle.start : null,
      ende: stelle ? stelle.ende : null,
    };
  });
  // Nach dem await frisch lesen und sofort schreiben (synchron → keine Überschneidung im selben Prozess).
  const c = ladeZeitstrahlCache(patientId);
  const nochDa = patientOderNull(patientId)?.dokumente.some((x) => x.docId === docId);
  if (nochDa) {
    c.dokumente[docId] = { pruefsumme: summe, modell: ki.modell, berechnetAm: new Date().toISOString(), ereignisse };
    speichereZeitstrahlCache(patientId, c);
  }
  return { docId, ereignisse, ausCache: false, modell: ki.modell, verbrauch: ki.verbrauch };
}

// Fehlende/veraltete Dokumente nachberechnen (gelöschte fallen beim Lesen automatisch heraus).
// parallel: gleichzeitige Claude-Aufrufe; max: höchstens so viele Dokumente in diesem Durchlauf.
async function aktualisiereZeitstrahl(patientId, { parallel = 3, max = Infinity, model, apiKey, beiFortschritt } = {}) {
  const offen = zeitstrahlOffen(patientId).slice(0, max);
  const ergebnis = { berechnet: 0, fehler: [], verbrauch: { eingabe: 0, ausgabe: 0 } };
  let i = 0;
  const arbeiter = async () => {
    while (i < offen.length) {
      const docId = offen[i++];
      try {
        const r = await extrahiereEreignisse(patientId, docId, { model, apiKey });
        ergebnis.berechnet++;
        if (r.verbrauch) { ergebnis.verbrauch.eingabe += r.verbrauch.eingabe; ergebnis.verbrauch.ausgabe += r.verbrauch.ausgabe; }
        if (beiFortschritt) beiFortschritt({ docId, ok: true, ereignisse: r.ereignisse.length });
      } catch (e) {
        ergebnis.fehler.push({ docId, status: e.status || 500, meldung: e.meldung || 'Unbekannter Fehler.' });
        if (beiFortschritt) beiFortschritt({ docId, ok: false });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, offen.length)) }, arbeiter));
  return { ...ergebnis, offen: zeitstrahlOffen(patientId) };
}
// docIds, deren Ereignisse fehlen oder veraltet sind.
function zeitstrahlOffen(patientId) {
  const p = rag.ladePatient(patientId);
  const c = ladeZeitstrahlCache(patientId);
  return p.dokumente.filter((d) => {
    const e = c.dokumente[d.docId];
    if (!e) return true;
    let text;
    try { text = fs.readFileSync(path.join(ordner(patientId), 'dokumente', `${d.docId}.txt`), 'utf8'); } catch { return false; }
    return e.pruefsumme !== pruefsumme(text);
  }).map((d) => d.docId);
}
// Sortierter Zeitstrahl aus dem Zwischenspeicher (ohne KI-Aufruf).
// Ereignisse ohne eigenes Datum werden beim Briefdatum einsortiert (datumQuelle:'dokument') bzw. ans Ende.
function zeitstrahl(patientId) {
  const p = rag.ladePatient(patientId);
  const c = ladeZeitstrahlCache(patientId);
  const offen = new Set(zeitstrahlOffen(patientId));
  const ereignisse = [];
  // Je Dokument: Typ (inkl. „foto“ aus patientendaten.json) und eine Farbnummer 0–7 nach Datums-Reihenfolge,
  // damit benachbarte Briefe im Zeitstrahl unterscheidbar sind (Runde 2, Gruppierung je Dokument).
  const typen = new Map(liste(patientId).map((u) => [u.docId, u.typ]));
  const farbe = new Map(p.dokumente.map((d, i) => [d.docId, i % 8]));
  const zaehler = new Map();
  for (const d of p.dokumente) {
    const e = c.dokumente[d.docId];
    if (!e || offen.has(d.docId)) continue;
    for (const x of e.ereignisse) {
      zaehler.set(d.docId, (zaehler.get(d.docId) || 0) + 1);
      ereignisse.push({
        ...x,
        datumQuelle: x.datum ? 'text' : d.datum ? 'dokument' : null,
        sortDatum: x.datum || d.datum || null,
        dokumentTitel: d.titel,
        dokumentDatum: d.datum || null,
        dokumentTyp: typen.get(d.docId) || d.typ || 'upload',
        farbe: farbe.get(d.docId),
      });
    }
  }
  const dokumentListe = p.dokumente.map((d) => ({ docId: d.docId, titel: d.titel, datum: d.datum || null,
    typ: typen.get(d.docId) || d.typ || 'upload', farbe: farbe.get(d.docId), ereignisse: zaehler.get(d.docId) || 0 }));
  ereignisse.sort((a, b) => String(a.sortDatum || '9999').localeCompare(String(b.sortDatum || '9999')) || a.id.localeCompare(b.id, 'de', { numeric: true }));
  const daten = ereignisse.map((e) => e.sortDatum).filter(Boolean);
  return {
    patientId,
    ereignisse,
    zeitraum: daten.length ? { von: daten[0], bis: daten[daten.length - 1] } : null,
    dokumente: { gesamt: p.dokumente.length, ausgewertet: p.dokumente.length - offen.size, offen: [...offen] },
    dokumentListe,
  };
}

// =============================================================================================
// 4. Gesundheitsangaben (Onboarding) – nur was die Person selbst sagt oder scannt
// =============================================================================================
function profil(patientId) {
  rag.ladePatient(patientId);
  const z = ladeZusatz(patientId);
  const felder = {};
  for (const f of PROFIL_FELDER) felder[f] = z.profil[f];
  return { patientId, felder, fehlend: PROFIL_PFLICHT.filter((f) => !z.profil[f].length), geaendertAm: z.geaendertAm || null };
}
function pruefeFeld(feld) {
  if (!PROFIL_FELDER.includes(feld)) throw pdFehler(400, `Unbekanntes Feld. Erlaubt: ${PROFIL_FELDER.join(', ')}.`);
}
function eintrag(wert, quelle) {
  const w = String(wert || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROFIL_WERT);
  if (!w) throw pdFehler(400, 'Die Angabe ist leer.');
  if (!QUELLEN.includes(quelle)) throw pdFehler(400, 'quelle muss gespraech oder scan sein.');
  return { id: crypto.randomBytes(4).toString('hex'), wert: w, quelle, am: new Date().toISOString() };
}
// Eine Angabe ergänzen. Auch „keine“ ist eine gültige Angabe (dann gilt das Feld als beantwortet).
function speicherProfilAngabe(patientId, { feld, wert, quelle = 'gespraech' } = {}) {
  pruefeFeld(feld);
  rag.ladePatient(patientId);
  const z = ladeZusatz(patientId);
  const e = eintrag(wert, quelle);
  const doppelt = z.profil[feld].find((x) => x.wert.toLowerCase() === e.wert.toLowerCase());
  if (doppelt) return { ...profil(patientId), eintrag: doppelt, doppelt: true };
  if (z.profil[feld].length >= MAX_PROFIL_EINTRAEGE) throw pdFehler(413, 'Zu viele Einträge in diesem Feld.');
  z.profil[feld].push(e);
  speichereZusatz(patientId, z);
  return { ...profil(patientId), eintrag: e, doppelt: false };
}
// Ein Feld komplett ersetzen (Bearbeiten in der Oberfläche). werte: [string] oder [{wert, quelle}]
function setzeProfilFeld(patientId, feld, werte) {
  pruefeFeld(feld);
  if (!Array.isArray(werte) || werte.length > MAX_PROFIL_EINTRAEGE) throw pdFehler(400, 'werte muss eine Liste sein.');
  rag.ladePatient(patientId);
  const z = ladeZusatz(patientId);
  const alt = new Map(z.profil[feld].map((x) => [x.wert.toLowerCase(), x]));
  const neuListe = [];
  for (const w of werte) {
    const wert = typeof w === 'string' ? w : w?.wert;
    const quelle = typeof w === 'object' && w?.quelle ? w.quelle : 'gespraech';
    const e = eintrag(wert, quelle);
    if (neuListe.some((x) => x.wert.toLowerCase() === e.wert.toLowerCase())) continue;
    neuListe.push(alt.get(e.wert.toLowerCase()) || e);
  }
  z.profil[feld] = neuListe;
  speichereZusatz(patientId, z);
  return profil(patientId);
}
function loescheProfilAngabe(patientId, feld, id) {
  pruefeFeld(feld);
  const z = ladeZusatz(patientId);
  const vorher = z.profil[feld].length;
  z.profil[feld] = z.profil[feld].filter((x) => x.id !== id);
  if (z.profil[feld].length === vorher) throw pdFehler(404, 'Angabe nicht gefunden.');
  speichereZusatz(patientId, z);
  return profil(patientId);
}
// Was soll die Person als Nächstes tun? scannen → profil → fertig
function status(patientId) {
  const p = rag.ladePatient(patientId);
  const pr = profil(patientId);
  const anzahl = p.dokumente.length;
  const profilVollstaendig = pr.fehlend.length === 0;
  const naechsterSchritt = anzahl === 0 ? 'scannen' : !profilVollstaendig ? 'profil' : 'fertig';
  return {
    patientId,
    anzahlDokumente: anzahl,
    profilVollstaendig,
    fehlendeFelder: pr.fehlend,
    naechstesFeld: naechsterSchritt === 'profil' ? pr.fehlend[0] : null,
    zeitstrahlOffen: anzahl ? zeitstrahlOffen(patientId).length : 0,
    naechsterSchritt,
  };
}

// =============================================================================================
// 5. Onboarding-Sätze für den Avatar (rein organisatorisch, keine medizinischen Inhalte)
// =============================================================================================
// <!-- PLATZHALTER: Wortlaut vom Team gegenlesen lassen (besonders tr und ar). -->
const SPRACHEN = ['de', 'en', 'fr', 'tr', 'ar'];
const SAETZE = {
  de: {
    scannen: 'Du hast noch keine Unterlagen bei mir. Tippe unten auf Unterlagen und scanne deinen letzten Arztbrief, dann kann ich dir helfen.',
    erkrankungen: 'Danke für deine Unterlagen! Magst du mir noch sagen, welche Erkrankungen bei dir bekannt sind? Wenn keine, sag einfach „keine“.',
    medikamente: 'Super. Welche Medikamente nimmst du gerade? Wenn keine, sag einfach „keine“.',
    allergien: 'Fast geschafft. Hast du Allergien, die ich mir merken soll? Wenn keine, sag einfach „keine“.',
    fertig: 'Alles da, danke! Unter Unterlagen findest du deine Dokumente und den Zeitstrahl. Frag mich gern, was du wissen möchtest.',
  },
  en: {
    scannen: "I don't have any of your documents yet. Tap Documents below and scan your latest doctor's letter, then I can help you.",
    erkrankungen: 'Thanks for your documents! Could you tell me which illnesses you already know about? If none, just say "none".',
    medikamente: 'Great. Which medicines are you taking right now? If none, just say "none".',
    allergien: 'Almost done. Do you have any allergies I should remember? If none, just say "none".',
    fertig: "All set, thank you! Under Documents you'll find your papers and the timeline. Feel free to ask me anything.",
  },
  fr: {
    scannen: "Je n'ai encore aucun de tes documents. Touche Documents en bas et scanne ta dernière lettre médicale, ensuite je pourrai t'aider.",
    erkrankungen: 'Merci pour tes documents ! Peux-tu me dire quelles maladies tu as déjà ? Si aucune, dis simplement « aucune ».',
    medikamente: 'Super. Quels médicaments prends-tu en ce moment ? Si aucun, dis simplement « aucun ».',
    allergien: 'Presque fini. As-tu des allergies dont je dois me souvenir ? Si aucune, dis simplement « aucune ».',
    fertig: "C'est complet, merci ! Dans Documents, tu trouves tes papiers et la frise chronologique. Pose-moi tes questions quand tu veux.",
  },
  tr: {
    scannen: 'Henüz bende hiç belgen yok. Aşağıdaki Belgeler düğmesine dokun ve son doktor mektubunu tara, sonra sana yardım edebilirim.',
    erkrankungen: 'Belgelerin için teşekkürler! Bilinen hastalıklarını bana söyler misin? Yoksa sadece „yok“ de.',
    medikamente: 'Harika. Şu anda hangi ilaçları kullanıyorsun? Yoksa sadece „yok“ de.',
    allergien: 'Neredeyse bitti. Hatırlamam gereken alerjilerin var mı? Yoksa sadece „yok“ de.',
    fertig: 'Her şey tamam, teşekkürler! Belgeler bölümünde dokümanlarını ve zaman çizelgeni bulabilirsin. İstediğini bana sorabilirsin.',
  },
  ar: {
    scannen: 'لا توجد لديّ أي مستندات لك بعد. اضغط على «المستندات» في الأسفل وامسح آخر رسالة من الطبيب، وبعدها أستطيع مساعدتك.',
    erkrankungen: 'شكرًا على مستنداتك! هل يمكنك أن تخبرني بالأمراض المعروفة لديك؟ إذا لم يكن هناك شيء، قل فقط «لا شيء».',
    medikamente: 'رائع. ما الأدوية التي تتناولها حاليًا؟ إذا لم يكن هناك شيء، قل فقط «لا شيء».',
    allergien: 'اقتربنا من النهاية. هل لديك حساسية يجب أن أتذكرها؟ إذا لم يكن هناك شيء، قل فقط «لا شيء».',
    fertig: 'كل شيء جاهز، شكرًا! في قسم «المستندات» تجد وثائقك والخط الزمني. اسألني عن أي شيء تريد معرفته.',
  },
};
// status: Ergebnis von status() (oder nur {naechsterSchritt, naechstesFeld}); sprache: de|en|fr|tr|ar (sonst de)
function onboardingSatz(st, sprache = 'de') {
  const s = SAETZE[SPRACHEN.includes(sprache) ? sprache : 'de'];
  const schritt = st?.naechsterSchritt;
  if (schritt === 'scannen') return s.scannen;
  if (schritt === 'profil') return s[st.naechstesFeld] || s[PROFIL_PFLICHT[0]];
  return s.fertig;
}
// Alles für GET /api/onboarding in einem Aufruf.
function onboarding(patientId, sprache = 'de') {
  const st = status(patientId);
  return { ...st, sprache: SPRACHEN.includes(sprache) ? sprache : 'de', satz: onboardingSatz(st, sprache) };
}

module.exports = {
  // 1. Nutzer ↔ Patient
  PATIENT_ADMIN, PATIENT_DEMO, standardZuordnung, patientFuerNutzer, richteTestpatientenEin, zuruecksetzen,
  // 2. Dokumente
  liste, dokument, bild, umbenennen, loeschen, neu,
  // 3. Zeitstrahl
  extrahiereEreignisse, aktualisiereZeitstrahl, zeitstrahlOffen, zeitstrahl,
  // 4. Gesundheitsangaben
  PROFIL_FELDER, profil, speicherProfilAngabe, setzeProfilFeld, loescheProfilAngabe, status,
  // 5. Onboarding
  SPRACHEN, onboardingSatz, onboarding,
  // Tests
  setzeBasis, findeZitat, normDatum, EXTRAKTION_ANWEISUNG,
};
