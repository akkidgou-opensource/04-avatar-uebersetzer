'use strict';
// ---------------------------------------------------------------------------------------------
// dashboard.js – Übersicht („Dashboard“) für Test-Patienten: Termine und Medikamentenplan.
// Nur synthetische Testdaten, nur Node-Bordmittel. Baut auf rag.js, patientendaten.js, gedaechtnis.js auf.
//
// Was es tut (vom Team prüfbar):
//   - Medikamentenplan: Claude liest das NEUESTE Dokument (Datum bis heute) mit einem Medikations-Abschnitt und
//     schreibt die Einträge wörtlich ab (mit Zitat zum Nachprüfen). Nichts wird ergänzt oder bewertet.
//     Zwischenspeicher je Dokument-Prüfsumme in lokal/patienten/<id>/medikamente.json.
//   - Bisherige Termine: aus dem Zeitstrahl (Aufenthalte, Untersuchungen, Eingriffe) mit Quelle.
//   - Eigene Termine: lokal/patienten/<id>/termine.json (0600, atomar). Anlegen, ändern, löschen.
//   - Termine/Medikamente, die die Person mitano. erzählt hat (Gedächtnis), erscheinen als Hinweise.
//   - kontextFuerClaude(): kurzer Text für den Gesprächsweg (nur aus dem Zwischenspeicher, kein KI-Aufruf).
//
// Routen (server.js hängt sie ein; Anmeldung, X-Requested-With und Bremse prüft server.js):
//   GET /api/dashboard · POST /api/termine · PUT /api/termine/:id · DELETE /api/termine/:id
//   (DELETE mit einer Gedächtnis-ID „Du hast mir erzählt“ vergisst diesen Termin im Gedächtnis.)
// Inhalte werden NIE geloggt (nur Status/Anzahlen).
// ---------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rag = require('./rag');
const pd = require('./patientendaten');
const gd = require('./gedaechtnis');

let BASIS = path.join(__dirname, 'lokal', 'patienten');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const MODELL_STANDARD = 'claude-sonnet-5-5';
const OHNE_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];
const TIMEOUT_MS = 90 * 1000;
const MAX_TEXT_ZEICHEN = 60000;
const MAX_MEDIKAMENTE = 30;
const MAX_TERMINE = 200;
const MAX_BISHERIGE = 40;
const MAX_KANDIDATEN = 3;          // so viele Dokumente höchstens prüfen, bis eines einen Plan hat
const MAX_KONTEXT = 1200;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const TERMIN_ID_RE = /^t-[a-f0-9]{8}$/;
const FAKT_ID_RE = /^[a-z0-9-]{4,40}$/i;
const DATUM_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZEIT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// Hinweis auf einen Medikations-Abschnitt (rein technisch: welches Dokument wird gelesen)
const MEDIKATION_RE = /medikation|medikamente|therapieempfehlung|behandlungsvorschlag|weitere therapie|empfohlene therapie|entlass(ungs)?medikation/i;
// Welche Zeitstrahl-Arten zählen als „bisheriger Termin“
const TERMIN_ARTEN = { aufenthalt: 'Aufenthalt', untersuchung: 'Untersuchung', op: 'Eingriff' };

function dFehler(status, meldung) {
  const e = new Error(meldung);
  e.status = status;
  e.meldung = meldung;
  return e;
}

// ---------- Dateien ----------
function setzeBasis(ordner) { BASIS = ordner; }
function ordner(patientId) {
  if (!ID_RE.test(String(patientId || ''))) throw dFehler(400, 'Ungültige Patienten-ID.');
  return path.join(BASIS, patientId);
}
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
function saeubere(t, max) { return String(t ?? '').replace(/\s+/g, ' ').replace(/[<>`]/g, '').trim().slice(0, max); }

// Heutiges Datum (Ortszeit des Servers) als JJJJ-MM-TT
function heute(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function datumDeutsch(iso) {
  const m = String(iso || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return '';
  if (m[3]) return `${Number(m[3])}.${Number(m[2])}.${m[1]}`;
  if (m[2]) return `${Number(m[2])}/${m[1]}`;
  return m[1];
}
function wochentag(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? '' : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()];
}
function patientOderNull(patientId) {
  try { return rag.ladePatient(patientId); } catch (e) { if (e.status === 404) return null; throw e; }
}

// =============================================================================================
// 1. Eigene Termine (termine.json)
// =============================================================================================
function ladeTermine(patientId) {
  const t = leseJson(path.join(ordner(patientId), 'termine.json'), null) || {};
  if (!Array.isArray(t.termine)) t.termine = [];
  if (!Array.isArray(t.uebernommeneFakten)) t.uebernommeneFakten = [];
  return t;
}
function speichereTermine(patientId, t) {
  t.version = 1; t.synthetisch = true; t.geaendertAm = new Date().toISOString();
  schreibeAtomar(path.join(ordner(patientId), 'termine.json'), JSON.stringify(t, null, 1));
}
function pruefeDatum(datum) {
  const m = String(datum || '').match(DATUM_RE);
  if (!m) throw dFehler(400, 'Bitte ein Datum wählen.');
  const d = new Date(`${datum}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) || Number(m[1]) < 1990 || Number(m[1]) > 2100) throw dFehler(400, 'Dieses Datum gibt es nicht.');
  return datum;
}
function terminAusEingabe(b, alt = {}) {
  const titel = saeubere(b.titel !== undefined ? b.titel : alt.titel, 120);
  if (!titel) throw dFehler(400, 'Bitte kurz eintragen, was für ein Termin das ist.');
  const datum = pruefeDatum(b.datum !== undefined ? b.datum : alt.datum);
  let uhrzeit = b.uhrzeit !== undefined ? b.uhrzeit : alt.uhrzeit;
  uhrzeit = uhrzeit ? String(uhrzeit).trim() : null;
  if (uhrzeit && !ZEIT_RE.test(uhrzeit)) throw dFehler(400, 'Uhrzeit bitte als SS:MM, z. B. 09:30.');
  const ort = saeubere(b.ort !== undefined ? b.ort : alt.ort, 120) || null;
  return { titel, datum, uhrzeit: uhrzeit || null, ort };
}
function sortiereTermine(liste) {
  return liste.sort((a, b) => a.datum.localeCompare(b.datum) || String(a.uhrzeit || '99').localeCompare(String(b.uhrzeit || '99')));
}
function terminAnlegen(patientId, b = {}) {
  const t = ladeTermine(patientId);
  if (t.termine.length >= MAX_TERMINE) throw dFehler(413, `Höchstens ${MAX_TERMINE} Termine.`);
  const werte = terminAusEingabe(b);
  let ausFakt = null;
  if (b.ausFakt !== undefined && b.ausFakt !== null && b.ausFakt !== '') {
    if (!FAKT_ID_RE.test(String(b.ausFakt))) throw dFehler(400, 'Ungültige ID.');
    ausFakt = String(b.ausFakt);
    if (!t.uebernommeneFakten.includes(ausFakt)) t.uebernommeneFakten.push(ausFakt);
  }
  const jetzt = new Date().toISOString();
  const termin = { id: `t-${crypto.randomBytes(4).toString('hex')}`, ...werte, ausFakt, erstelltAm: jetzt, geaendertAm: jetzt };
  t.termine.push(termin);
  sortiereTermine(t.termine);
  speichereTermine(patientId, t);
  return termin;
}
function terminAendern(patientId, id, b = {}) {
  if (!TERMIN_ID_RE.test(String(id || ''))) throw dFehler(400, 'Ungültige Termin-ID.');
  const t = ladeTermine(patientId);
  const x = t.termine.find((e) => e.id === id);
  if (!x) throw dFehler(404, 'Diesen Termin gibt es nicht (mehr).');
  Object.assign(x, terminAusEingabe(b, x), { geaendertAm: new Date().toISOString() });
  sortiereTermine(t.termine);
  speichereTermine(patientId, t);
  return x;
}
// Eigener Termin (t-…) → löschen. Gedächtnis-Termin („Du hast mir erzählt“) → im Gedächtnis vergessen.
function terminLoeschen(patientId, id) {
  const sid = String(id || '');
  if (TERMIN_ID_RE.test(sid)) {
    const t = ladeTermine(patientId);
    const i = t.termine.findIndex((e) => e.id === sid);
    if (i < 0) throw dFehler(404, 'Diesen Termin gibt es nicht (mehr).');
    t.termine.splice(i, 1);
    speichereTermine(patientId, t);
    return { geloescht: sid, art: 'termin' };
  }
  if (!FAKT_ID_RE.test(sid)) throw dFehler(400, 'Ungültige Termin-ID.');
  const f = (gd.exportiere(patientId).fakten || []).find((x) => x.id === sid);
  if (!f || f.art !== 'termin' || f.quelleTyp !== 'gespraech') throw dFehler(404, 'Diesen Termin gibt es nicht (mehr).');
  gd.loescheFakt(patientId, sid);
  return { geloescht: sid, art: 'gedaechtnis' };
}

// Datum/Uhrzeit aus einer erzählten Notiz herauslesen (nur als Vorschlag zum Übernehmen)
function vorschlagAusText(text) {
  const s = String(text || '');
  let datum = null, uhrzeit = null;
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) datum = m[0];
  else if ((m = s.match(/\b(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})(?!\d))?/))) {
    let j = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (j < 100) j += 2000;
    datum = `${j}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!m[3] && datum < heute()) datum = `${j + 1}${datum.slice(4)}`;   // ohne Jahr: nächstes Vorkommen
    try { pruefeDatum(datum); } catch { datum = null; }
  }
  // Uhrzeit erst suchen, nachdem Datumsangaben entfernt sind (sonst wird „3.12.“ zu 03:12)
  const ohneDatum = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}\.\s?\d{1,2}\.(\s?\d{2,4})?/g, ' ');
  if ((m = ohneDatum.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)) || (m = ohneDatum.match(/\b([01]?\d|2[0-3])\.([0-5]\d)\s*uhr\b/i))) uhrzeit = `${m[1].padStart(2, '0')}:${m[2]}`;
  else if ((m = ohneDatum.match(/\b([01]?\d|2[0-3])\s*uhr\b/i))) uhrzeit = `${m[1].padStart(2, '0')}:00`;
  return { datum, uhrzeit };
}

// =============================================================================================
// 2. Medikamentenplan per Claude (wörtlich aus dem Dokument)
// =============================================================================================
// Rein technische Anweisung: nur abschreiben, was im Text steht. Keine medizinischen Regeln, keine Bewertung.
const MEDIKATION_ANWEISUNG = [
  'Du liest ein deutsches medizinisches Dokument (synthetische Testdaten) und schreibst den darin stehenden Medikamentenplan für eine Übersicht ab.',
  'Regeln:',
  '- Nimm nur auf, was ausdrücklich im Text steht. Nichts ergänzen, nichts vermuten, nichts bewerten, keine Empfehlungen, keine Umrechnungen.',
  '- Stehen mehrere Medikamentenlisten im Text (z. B. Medikation bei Aufnahme und Medikation bei Entlassung bzw. weitere Therapie / Behandlungsvorschlag / Therapieempfehlung), nimm NUR die zeitlich letzte Liste (die für die Zeit nach dem Dokument gilt).',
  '- abschnitt: die Überschrift dieser Liste, wörtlich (z. B. „Weitere Therapie und Behandlungsvorschlag:“).',
  '- medikament: Name wie im Text (Handelsname und/oder Wirkstoff, z. B. „Pantoprazol, z. B. Pantozol“). staerke: Stärke mit Einheit wie im Text (z. B. „40 mg“), sonst leer.',
  '- morgens, mittags, abends, nachts: die Menge aus dem Einnahmeschema genau wie im Text (z. B. „1“, „½“, „6 IE“); „0“ übernehmen, wenn dort 0 steht; leer, wenn nichts angegeben. Ein Schema mit drei Zahlen (1-0-1) bedeutet morgens-mittags-abends, mit vier Zahlen morgens-mittags-abends-nachts.',
  '- schema: das Einnahmeschema wörtlich, falls es nicht in die vier Felder passt (z. B. „jeden 2. Tag“, „nach Bedarf“, „1 x 1 s.c.“), sonst leer.',
  '- hinweis: kurzer Zusatz aus dem Text zu genau diesem Medikament (z. B. „s.c.“, „bzw. nach Bedarf“), sonst leer.',
  '- zitat: die Zeile des Eintrags wörtlich und zeichengenau kopiert (höchstens 200 Zeichen).',
  '- hinweise: allgemeine Anweisungen in dieser Liste, die kein einzelnes Medikament sind (z. B. „KEINE ACE-Hemmer!“, Diät), wörtlich als text und zitat.',
  `- Höchstens ${MAX_MEDIKAMENTE} Einträge. Steht kein Medikamentenplan im Text, gefunden = false und leere Listen.`,
].join('\n');
const MEDIKATION_SCHEMA = {
  type: 'object',
  properties: {
    gefunden: { type: 'boolean' },
    abschnitt: { type: 'string' },
    eintraege: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          medikament: { type: 'string' }, staerke: { type: 'string' },
          morgens: { type: 'string' }, mittags: { type: 'string' }, abends: { type: 'string' }, nachts: { type: 'string' },
          schema: { type: 'string' }, hinweis: { type: 'string' }, zitat: { type: 'string' },
        },
        required: ['medikament', 'staerke', 'morgens', 'mittags', 'abends', 'nachts', 'schema', 'hinweis', 'zitat'],
        additionalProperties: false,
      },
    },
    hinweise: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, zitat: { type: 'string' } }, required: ['text', 'zitat'], additionalProperties: false },
    },
  },
  required: ['gefunden', 'abschnitt', 'eintraege', 'hinweise'],
  additionalProperties: false,
};

function apiSchluessel() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw dFehler(503, 'Der API-Schlüssel fehlt noch (ANTHROPIC_API_KEY in .env).');
  return key;
}
function medikationModell() {
  return (process.env.ANTHROPIC_MODEL_MEDIKATION || '').trim() || MODELL_STANDARD;
}
async function claudeMedikation(text) {
  const key = apiSchluessel();
  const m = medikationModell();
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
  const body = {
    model: m,
    max_tokens: 6000,
    system: MEDIKATION_ANWEISUNG,
    messages: [{ role: 'user', content: `<dokument>\n${text}\n</dokument>\n\nSchreib den aktuellsten Medikamentenplan aus diesem Dokument ab.` }],
    output_config: { format: { type: 'json_schema', schema: MEDIKATION_SCHEMA } },
  };
  if (!OHNE_EFFORT.includes(m)) body.output_config.effort = 'low';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    daten = await r.json().catch(() => null);
  } catch (e) {
    throw dFehler(e.name === 'AbortError' ? 504 : 502, 'Der Medikamentenplan lässt sich gerade nicht lesen.');
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    console.log(`Dashboard: Medikamentenplan fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw dFehler(502, 'Der Medikamentenplan lässt sich gerade nicht lesen.');
  }
  if (daten?.stop_reason === 'refusal' || daten?.stop_reason === 'max_tokens') throw dFehler(502, 'Der Medikamentenplan lässt sich gerade nicht lesen.');
  const roh = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return { json: JSON.parse(roh), modell: daten?.model || m }; } catch { throw dFehler(502, 'Der Medikamentenplan lässt sich gerade nicht lesen.'); }
}

function ladeMedCache(patientId) {
  const c = leseJson(path.join(ordner(patientId), 'medikamente.json'), null) || {};
  if (!c.dokumente || typeof c.dokumente !== 'object') c.dokumente = {};
  return c;
}
function speichereMedCache(patientId, c) {
  c.version = 1; c.synthetisch = true; c.geaendertAm = new Date().toISOString();
  schreibeAtomar(path.join(ordner(patientId), 'medikamente.json'), JSON.stringify(c, null, 1));
}
// Kandidaten: Dokumente mit Datum bis heute (neueste zuerst), deren Text einen Medikations-Abschnitt nennt.
function medKandidaten(patientId) {
  const p = patientOderNull(patientId);
  if (!p) return [];
  const h = heute();
  const liste = [];
  for (const d of [...p.dokumente].filter((x) => x.datum && x.datum <= h).sort((a, b) => b.datum.localeCompare(a.datum))) {
    let text;
    try { text = fs.readFileSync(path.join(ordner(patientId), 'dokumente', `${d.docId}.txt`), 'utf8'); } catch { continue; }
    if (!MEDIKATION_RE.test(text)) continue;
    liste.push({ docId: d.docId, titel: d.titel, datum: d.datum, text, summe: pruefsumme(text) });
  }
  return liste;
}
const laufend = new Map();   // patientId:docId → Promise
function medExtrahieren(patientId, k) {
  const schluessel = `${patientId}:${k.docId}`;
  if (laufend.has(schluessel)) return laufend.get(schluessel);
  const p = (async () => {
    if (k.text.length > MAX_TEXT_ZEICHEN) throw dFehler(413, 'Das Dokument ist zu lang.');
    const { json, modell } = await claudeMedikation(k.text);
    const belege = (zitat) => pd.findeZitat(k.text, zitat);
    const eintraege = (Array.isArray(json?.eintraege) ? json.eintraege : []).slice(0, MAX_MEDIKAMENTE).map((e, i) => {
      const stelle = belege(e.zitat);
      return {
        id: `${k.docId}~m${i + 1}`,
        medikament: saeubere(e.medikament, 120), staerke: saeubere(e.staerke, 40),
        morgens: saeubere(e.morgens, 20), mittags: saeubere(e.mittags, 20), abends: saeubere(e.abends, 20), nachts: saeubere(e.nachts, 20),
        schema: saeubere(e.schema, 80), hinweis: saeubere(e.hinweis, 160), zitat: saeubere(e.zitat, 200),
        belegt: !!stelle, start: stelle ? stelle.start : null, ende: stelle ? stelle.ende : null,
      };
    }).filter((e) => e.medikament);
    const hinweise = (Array.isArray(json?.hinweise) ? json.hinweise : []).slice(0, 10).map((h) => {
      const stelle = belege(h.zitat);
      return { text: saeubere(h.text, 200), zitat: saeubere(h.zitat, 200), belegt: !!stelle, start: stelle ? stelle.start : null, ende: stelle ? stelle.ende : null };
    }).filter((h) => h.text);
    const abschnitt = saeubere(json?.abschnitt, 120);
    const astelle = abschnitt ? pd.findeZitat(k.text, abschnitt) : null;
    // Nach dem await frisch lesen und sofort schreiben (synchron → keine Überschneidung im selben Prozess).
    const c = ladeMedCache(patientId);
    if (patientOderNull(patientId)?.dokumente.some((x) => x.docId === k.docId)) {
      c.dokumente[k.docId] = { pruefsumme: k.summe, modell, berechnetAm: new Date().toISOString(),
        abschnitt, abschnittStart: astelle ? astelle.start : null, eintraege, hinweise };
      speichereMedCache(patientId, c);
    }
    console.log(`Dashboard: Medikamentenplan gelesen (${eintraege.length} Einträge).`);
  })().finally(() => laufend.delete(schluessel));
  p.catch(() => {});
  laufend.set(schluessel, p);
  return p;
}
const fehlerMerker = new Map();   // patientId:docId:summe → Zeit des letzten Fehlschlags (nicht dauernd neu versuchen)
// Plan aus dem Zwischenspeicher; startet bei Bedarf die Auswertung im Hintergrund.
// status: 'fertig' | 'laeuft' | 'keiner' | 'fehler'
function medikamentenplan(patientId, { starten = true } = {}) {
  const kandidaten = medKandidaten(patientId).slice(0, MAX_KANDIDATEN);
  if (!kandidaten.length) return { status: 'keiner', eintraege: [], hinweise: [] };
  const c = ladeMedCache(patientId);
  for (const k of kandidaten) {
    const e = c.dokumente[k.docId];
    if (e && e.pruefsumme === k.summe) {
      if (!e.eintraege.length) continue;   // dieses Dokument hat keinen Plan → nächstälteres
      return {
        status: 'fertig',
        quelle: { docId: k.docId, titel: k.titel, datum: k.datum, abschnitt: e.abschnitt || '', start: e.abschnittStart ?? null },
        eintraege: e.eintraege, hinweise: e.hinweise || [],
      };
    }
    const fk = `${patientId}:${k.docId}:${k.summe}`;
    if (laufend.has(`${patientId}:${k.docId}`)) return { status: 'laeuft', eintraege: [], hinweise: [] };
    if (fehlerMerker.has(fk) && Date.now() - fehlerMerker.get(fk) < 5 * 60 * 1000) return { status: 'fehler', eintraege: [], hinweise: [] };
    if (!starten) return { status: 'laeuft', eintraege: [], hinweise: [] };
    medExtrahieren(patientId, k).catch(() => fehlerMerker.set(fk, Date.now()));
    return { status: 'laeuft', eintraege: [], hinweise: [] };
  }
  return { status: 'keiner', eintraege: [], hinweise: [] };
}

// =============================================================================================
// 3. Bisherige Termine aus dem Zeitstrahl
// =============================================================================================
function bisherigeTermine(patientId) {
  let z;
  try { z = pd.zeitstrahl(patientId); } catch { return { liste: [], gesamt: 0 }; }
  const h = heute();
  const gesehen = new Set();
  const liste = [];
  for (const e of z.ereignisse || []) {
    if (!TERMIN_ARTEN[e.art]) continue;
    const datum = e.datum || null;
    if (!datum || datum.length < 7 || datum > h) continue;   // nur mit Monat/Tag und nicht in der Zukunft
    const k = `${datum}|${String(e.titel).toLowerCase()}`;
    if (gesehen.has(k)) continue;
    gesehen.add(k);
    liste.push({
      id: e.id, datum, art: e.art, artText: TERMIN_ARTEN[e.art], titel: e.titel, beschreibung: e.beschreibung || '',
      docId: e.docId, dokumentTitel: e.dokumentTitel, dokumentDatum: e.dokumentDatum,
      start: e.belegt !== false ? e.start : null, ende: e.belegt !== false ? e.ende : null,
    });
  }
  liste.sort((a, b) => b.datum.localeCompare(a.datum));
  return { liste: liste.slice(0, MAX_BISHERIGE), gesamt: liste.length };
}

// =============================================================================================
// 4. Gesamtübersicht
// =============================================================================================
// Vorname aus dem Gedächtnis („heiße Anna“), sonst nichts (keine Namen aus den Briefen).
function vornameAusGedaechtnis(fakten) {
  for (const f of fakten) {
    if (f.quelleTyp !== 'gespraech') continue;
    if (/arzt|ärztin|dr\.|doktor|mann|frau|sohn|tochter|partner|mutter|vater|hund|katze/i.test(f.text)) continue;
    const m = f.text.match(/(?:ich heiße|heiße|heißt|mein name ist|name:?)\s+([A-ZÄÖÜ][a-zäöüß-]{1,30})/);
    if (m) return m[1];
  }
  return null;
}
function uebersicht(patientId) {
  const leer = { patientId: patientId || null, heute: heute(), name: null, unterlagen: 0,
    termine: { naechste: [], vergangeneEigene: [], erzaehlt: [], bisherige: [], bisherigeGesamt: 0 },
    medikamente: { status: 'keiner', eintraege: [], hinweise: [] }, medikamentHinweise: [] };
  if (!patientId) return leer;
  const p = patientOderNull(patientId);
  if (!p) return leer;
  const h = heute();
  const t = ladeTermine(patientId);
  let fakten = [];
  try { fakten = gd.exportiere(patientId).fakten || []; } catch {}
  const eigene = sortiereTermine([...t.termine]);
  const erzaehlt = fakten.filter((f) => f.art === 'termin' && f.quelleTyp === 'gespraech' && !t.uebernommeneFakten.includes(f.id))
    .map((f) => ({ id: f.id, text: f.text, quelleText: f.quelleText, sicher: f.sicher, aktualisiert: f.aktualisiert, vorschlag: vorschlagAusText(f.text) }));
  const medikamentHinweise = fakten.filter((f) => f.art === 'medikament' && f.quelleTyp === 'gespraech')
    .map((f) => ({ id: f.id, text: f.text, quelleText: f.quelleText, sicher: f.sicher, widerspruch: f.widerspruch }));
  const b = bisherigeTermine(patientId);
  return {
    patientId, heute: h, name: vornameAusGedaechtnis(fakten), unterlagen: p.dokumente.length,
    termine: {
      naechste: eigene.filter((x) => x.datum >= h),
      vergangeneEigene: eigene.filter((x) => x.datum < h).reverse().slice(0, 20),
      erzaehlt, bisherige: b.liste, bisherigeGesamt: b.gesamt,
    },
    medikamente: medikamentenplan(patientId),
    medikamentHinweise,
  };
}

// Kurzer Systemblock für den Gesprächsweg (nur Zwischenspeicher, kein KI-Aufruf). Leer = nichts anhängen.
async function kontextFuerClaude(patientId, { frage = '' } = {}) {
  try {
    if (!patientId || !patientOderNull(patientId)) return '';
    const h = heute();
    const t = sortiereTermine(ladeTermine(patientId).termine.filter((x) => x.datum >= h));
    const plan = medikamentenplan(patientId, { starten: false });
    const zeilen = [`Technischer Hinweis – Übersicht der App (Dashboard), heute ist ${wochentag(h)}, ${datumDeutsch(h)}. Nur diese Angaben nutzen, nichts ergänzen.`];
    if (t.length) {
      zeilen.push('Nächste Termine (von der Person selbst in der App gespeichert):');
      for (const x of t.slice(0, 6)) zeilen.push(`- ${wochentag(x.datum)}, ${datumDeutsch(x.datum)}${x.uhrzeit ? `, ${x.uhrzeit} Uhr` : ''}: ${x.titel}${x.ort ? ` (${x.ort})` : ''}`);
    } else zeilen.push('Nächste Termine: in der App ist kein zukünftiger Termin gespeichert.');
    if (plan.status === 'fertig') {
      zeilen.push(`Medikamentenplan laut ${plan.quelle.titel} vom ${datumDeutsch(plan.quelle.datum)} (Quelle so nennen):`);
      for (const e of plan.eintraege.slice(0, 15)) {
        const teile = e.nachts ? [e.morgens, e.mittags, e.abends, e.nachts] : [e.morgens, e.mittags, e.abends];
        const s = teile.some(Boolean) ? teile.map((x) => x || '0').join('-') : '';   // wie im Brief (3- oder 4-teilig)
        zeilen.push(`- ${e.medikament}${e.staerke ? ` ${e.staerke}` : ''}${s ? ` ${s}` : ''}${e.schema ? ` ${e.schema}` : ''}${e.hinweis ? ` (${e.hinweis})` : ''}`);
      }
      for (const x of plan.hinweise.slice(0, 3)) zeilen.push(`- Hinweis im Brief: ${x.text}`);
    }
    let text = zeilen.join('\n');
    if (text.length > MAX_KONTEXT) text = text.slice(0, MAX_KONTEXT - 1) + '…';
    return text;
  } catch { return ''; }
}

// =============================================================================================
// 5. Routen
// =============================================================================================
/**
 * @param ctx { pid, username, sendJson, readJson }
 * @returns {Promise<boolean>} true, wenn die Anfrage beantwortet wurde
 */
async function route(req, res, url, { pid, sendJson, readJson } = {}) {
  const p = url.pathname;
  if (p !== '/api/dashboard' && p !== '/api/termine' && !p.startsWith('/api/termine/')) return false;
  const m = req.method;
  if (p === '/api/dashboard') {
    if (m !== 'GET') { sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' }); return true; }
    sendJson(res, 200, uebersicht(pid));
    return true;
  }
  if (!pid) { sendJson(res, 404, { fehler: 'Kein Test-Patient zugeordnet.' }); return true; }
  if (p === '/api/termine') {
    if (m === 'GET') { sendJson(res, 200, { termine: sortiereTermine(ladeTermine(pid).termine) }); return true; }
    if (m === 'POST') {
      const termin = terminAnlegen(pid, (await readJson(req)) || {});
      console.log('Dashboard: Termin angelegt.');
      sendJson(res, 201, { termin, dashboard: uebersicht(pid) });
      return true;
    }
    sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
    return true;
  }
  let id;
  try { id = decodeURIComponent(p.slice('/api/termine/'.length)); } catch { id = ''; }
  if (m === 'PUT') {
    const termin = terminAendern(pid, id, (await readJson(req)) || {});
    console.log('Dashboard: Termin geändert.');
    sendJson(res, 200, { termin, dashboard: uebersicht(pid) });
    return true;
  }
  if (m === 'DELETE') {
    const r = terminLoeschen(pid, id);
    console.log(r.art === 'gedaechtnis' ? 'Dashboard: erzählten Termin vergessen.' : 'Dashboard: Termin gelöscht.');
    sendJson(res, 200, { ...r, dashboard: uebersicht(pid) });
    return true;
  }
  sendJson(res, 405, { fehler: 'Methode nicht erlaubt.' });
  return true;
}

// =============================================================================================
// 6. Löschen (Konsistenz): Dokument gelöscht → abgeleitete Daten weg; Patient zurückgesetzt → alles weg
// =============================================================================================
// Medikamentenplan-Zwischenspeicher dieses Dokuments verwerfen. Der Plan kommt beim nächsten Abruf aus dem nun
// neuesten passenden Dokument (oder bleibt leer). „Bisherige Termine“ kommen aus dem Zeitstrahl und verschwinden mit
// pd.loeschen() von selbst. Eigene Termine der Person bleiben. Wirft nie.
function vergissDokument(patientId, docId) {
  try {
    const c = ladeMedCache(patientId);
    let geaendert = false;
    if (c.dokumente[docId]) { delete c.dokumente[docId]; geaendert = true; }
    if (geaendert) speichereMedCache(patientId, c);
    for (const k of [...fehlerMerker.keys()]) if (k.startsWith(`${patientId}:${docId}:`)) fehlerMerker.delete(k);
    return { ok: true, medikamente: geaendert };
  } catch { return { ok: false }; }
}
// Dashboard-Dateien eines Test-Patienten löschen (z. B. Demo zurücksetzen). Wirft nie.
function vergissPatient(patientId) {
  try {
    const o = ordner(patientId);
    for (const f of ['termine.json', 'medikamente.json']) fs.rmSync(path.join(o, f), { force: true });
    for (const k of [...fehlerMerker.keys()]) if (k.startsWith(`${patientId}:`)) fehlerMerker.delete(k);
    return { ok: true };
  } catch { return { ok: false }; }
}

module.exports = {
  route, behandle: route, kontextFuerClaude, uebersicht, vergissDokument, vergissPatient,
  // Einzelteile / Tests
  medikamentenplan, bisherigeTermine, terminAnlegen, terminAendern, terminLoeschen, vorschlagAusText,
  setzeBasis, MEDIKATION_ANWEISUNG,
};
