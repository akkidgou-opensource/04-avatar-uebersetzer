'use strict';
// ---------------------------------------------------------------------------------------------
// gedaechtnis.js – Patienten-Gedächtnis für mitano. (nur synthetische Test-Patienten, nur Node-Bordmittel)
//
// Was es tut (vom Team prüfbar):
//   - Nach jeder Gesprächsrunde liest Claude Haiku im Hintergrund, was die Person gesagt hat, und
//     merkt sich neue oder geänderte Angaben als kurze „Fakten“ (z. B. „Hausarzt heißt Dr. Sommer“).
//   - Aus Unterlagen (Arztbriefe, Scans) übernimmt es die wichtigsten Angaben mit wörtlichem Zitat.
//   - Vor einer Antwort liefert kontextFuerFrage() einen kurzen Block (Zusammenfassung + passende Fakten),
//     der zusätzlich in den Systemkontext von Claude kommt.
//   - Alles ist einsehbar (export) und einzeln oder ganz löschbar (loescheFakt, vergiss).
//
// Speicher: lokal/patienten/<patientId>/gedaechtnis.json (0600, atomar). Laut CLAUDE.md erlaubt, weil nur
// Test-Patienten mit synthetischen Daten. Inhalte werden NIE geloggt (nur Status-Codes und Anzahlen).
// ---------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rag = require('./rag');
const pd = require('./patientendaten');

let BASIS = path.join(__dirname, 'lokal', 'patienten');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const MODELL_STANDARD = 'claude-haiku-5-5';
const OHNE_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];
const TIMEOUT_MS = 30 * 1000;

const ARTEN = ['person', 'beschwerde', 'diagnose', 'medikament', 'allergie', 'termin', 'vorliebe', 'lebensumstand', 'sonstiges'];
const DOK_ARTEN = ['diagnose', 'medikament', 'allergie', 'termin', 'person'];
const MAX_FAKTEN = 400;
const MAX_FAKT_TEXT = 200;
const MAX_ZITAT = 300;
const MAX_ZUSAMMENFASSUNG = 600;
const MAX_VERLAUF = 60;          // Archiv: letzte Nachrichten
const MAX_VERLAUF_TEXT = 2000;
const MAX_DOK_FAKTEN = 10;       // je Dokument
const MAX_DOK_ZEICHEN = 60000;
const KONTEXT_GESPRAECH_MAX = 30;
const KONTEXT_DOKUMENT_MAX = 8;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const FAKT_ID_RE = /^[a-z0-9-]{4,40}$/i;

// ---------- Fehler (gleiche Form wie rag.js/patientendaten.js) ----------
function gFehler(status, meldung) {
  const e = new Error(meldung);
  e.status = status;
  e.meldung = meldung;
  return e;
}

// ---------- Datei ----------
function setzeBasis(ordner) { BASIS = ordner; }
function datei(patientId) {
  if (!ID_RE.test(String(patientId || ''))) throw gFehler(400, 'Ungültige Patienten-ID.');
  return path.join(BASIS, patientId, 'gedaechtnis.json');
}
function leer() {
  return { version: 1, synthetisch: true, zusammenfassung: '', steckbrief: {}, fakten: [], verlauf: [], dokumente: {}, aktualisiert: null };
}
function lade(patientId) {
  try {
    const g = JSON.parse(fs.readFileSync(datei(patientId), 'utf8'));
    return { ...leer(), ...g };
  } catch (e) {
    if (e.status) throw e;
    return leer();
  }
}
function speichere(patientId, g) {
  const d = datei(patientId);
  fs.mkdirSync(path.dirname(d), { recursive: true, mode: 0o700 });
  g.aktualisiert = new Date().toISOString();
  if (g.fakten.length > MAX_FAKTEN) g.fakten = g.fakten.slice(-MAX_FAKTEN);
  const tmp = `${d}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, d);
}

// Je Patient eine Warteschlange: Lernvorgänge laufen nacheinander, damit keiner den anderen überschreibt.
const schlangen = new Map();
// Generation je Patient: vergiss() erhöht sie, laufende Lernvorgänge verwerfen danach ihr Ergebnis.
const generation = new Map();
function inSchlange(patientId, fn) {
  const vorher = schlangen.get(patientId) || Promise.resolve();
  const jetzt = vorher.catch(() => {}).then(fn);
  schlangen.set(patientId, jetzt.catch(() => {}));
  return jetzt;
}
// Für Tests/Server: wartet, bis alle Lernvorgänge eines Patienten fertig sind.
function warteAufLernen(patientId) { return schlangen.get(patientId) || Promise.resolve(); }

// ---------- Hilfen ----------
function neueId(praefix) { return `${praefix}-${crypto.randomBytes(4).toString('hex')}`; }
function saeubere(t, max) { return String(t || '').replace(/\s+/g, ' ').replace(/[*#`|<>]/g, '').trim().slice(0, max); }
function norm(t) { return rag.woerter(t).join(' '); }
function datumIso(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
function datumKurz(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}
function datumDeutsch(iso) {
  if (!iso) return 'ohne Datum';
  const [j, m, t] = String(iso).split('-');
  return t ? `${Number(t)}.${Number(m)}.${j}` : m ? `${Number(m)}/${j}` : j;
}
function modell(model) {
  return model || (process.env.ANTHROPIC_MODEL_GEDAECHTNIS || '').trim() || (process.env.ANTHROPIC_MODEL_SUCHE || '').trim() || MODELL_STANDARD;
}
function apiSchluessel(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw gFehler(503, 'Der API-Schlüssel fehlt noch (ANTHROPIC_API_KEY in .env).');
  return key;
}

// Ein Claude-Aufruf mit strukturierter JSON-Ausgabe. Wirft gFehler; loggt nur Status.
async function claudeJson({ system, inhalt, schema, maxTokens = 2000, model, apiKey, zweck }) {
  const key = apiSchluessel(apiKey);
  const m = modell(model);
  const body = {
    model: m,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: inhalt }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  if (!OHNE_EFFORT.includes(m)) body.output_config.effort = 'low';
  if (/^claude-haiku-5/.test(m)) body.thinking = { type: 'disabled' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    daten = await r.json().catch(() => null);
  } catch (e) {
    console.log(`Gedächtnis: ${zweck} ohne Ergebnis (${e.name === 'AbortError' ? 'Zeitlimit' : 'Verbindung'})`);
    throw gFehler(e.name === 'AbortError' ? 504 : 502, 'Der KI-Dienst hat nicht rechtzeitig geantwortet.');
  } finally { clearTimeout(timer); }
  if (!r.ok) {
    console.log(`Gedächtnis: ${zweck} fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw gFehler(502, 'Der KI-Dienst hat die Anfrage nicht angenommen.');
  }
  if (daten?.stop_reason === 'refusal') throw gFehler(502, 'Die KI hat die Auswertung abgelehnt.');
  if (daten?.stop_reason === 'max_tokens') throw gFehler(502, 'Die Auswertung war zu lang.');
  const roh = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(roh); } catch { throw gFehler(502, 'Die KI-Antwort war kein gültiges JSON.'); }
}

// Ähnlichkeit zweier Texte (Anteil gemeinsamer Wortstämme) – für Doppelte und Suche.
function aehnlich(a, b) {
  const A = new Set(rag.woerter(a)), B = new Set(rag.woerter(b));
  if (!A.size || !B.size) return 0;
  let g = 0;
  for (const w of A) if (B.has(w)) g++;
  return g / Math.min(A.size, B.size);
}
function istDoppelt(g, art, text) {
  const n = norm(text);
  return g.fakten.find((f) => f.art === art && (norm(f.text) === n || aehnlich(f.text, text) >= 0.9));
}

// =============================================================================================
// 1. Aus dem Gespräch lernen
// =============================================================================================
// Rein technische Extraktions-Anweisung (keine medizinischen Regeln, nichts bewerten, nichts erfinden).
const GESPRAECH_ANWEISUNG = [
  'Du führst ein Notizbuch über eine Person, die mit einem digitalen Begleiter spricht (Demo-App, nur erfundene Testdaten).',
  'Du bekommst die bisherigen Notizen, die bisherige Kurz-Zusammenfassung und die neue Gesprächsrunde.',
  'Aufgabe: Erkenne, welche Angaben über sich selbst die Person in ihrer NEUEN Aussage gemacht hat, und gib nur Änderungen am Notizbuch zurück.',
  'Regeln:',
  '- Nur was die Person selbst gesagt hat. Die Antwort des Begleiters dient nur zum Verständnis (z. B. worauf sich „ja“ bezieht); übernimm nichts, was nur der Begleiter gesagt hat.',
  '- Nichts erfinden, nichts vermuten, nichts bewerten, keine Ratschläge. Fragen der Person sind keine Angaben.',
  '- text: kurze Notiz aus Sicht der Person, höchstens 15 Wörter, in der Sprache des Gesprächs, z. B. „Hausarzt heißt Dr. Sommer“, „Allergie gegen Penicillin“, „seit 27.11.2026 schwindelig“.',
  '- Relative Zeitangaben („gestern“, „seit drei Tagen“, „nächsten Dienstag“) mit dem heutigen Datum in ein Datum umrechnen.',
  `- art: eine von ${ARTEN.join(', ')}. person = Menschen im Umfeld (Ärztin, Partner, Kinder) mit Name/Rolle.`,
  '- aktion „neu“: neue Angabe. aktion „ersetzen“: die Person korrigiert oder aktualisiert eine vorhandene Notiz (z. B. „jetzt 10 mg statt 5 mg“, „nehme ich nicht mehr“); id = id der alten Notiz, text = neuer Stand.',
  '- aktion „widerspruch“: die neue Aussage passt nicht zu einer vorhandenen Notiz, ohne dass klar ist, was stimmt; id = id der vorhandenen Notiz, text = die neue Aussage.',
  '- Schon vorhandene, unveränderte Angaben nicht noch einmal melden. Bei „neu“ ist id ein leerer Text.',
  '- sicher: false, wenn die Person unsicher klang („glaube ich“, „vielleicht“).',
  '- zitat: die Stelle der neuen Aussage, wörtlich kopiert (höchstens 150 Zeichen).',
  `- zusammenfassung: Kurz-Zusammenfassung dessen, was die Person im Gespräch über sich erzählt hat (nicht die Unterlagen), aktualisiert, höchstens ${MAX_ZUSAMMENFASSUNG} Zeichen, neutral formuliert ohne Geschlecht anzunehmen (z. B. „Hausarzt: Dr. Sommer. Allergie gegen Penicillin.“). Hat sich nichts geändert, gib die bisherige zurück.`,
  '- steckbrief: Eckdaten, die die Person in der NEUEN Aussage über sich nennt oder ändert – name (nur der Name, mit dem sie angesprochen werden möchte, ohne Zusatz, z. B. „Maxi“ bei „nenn mich Maxi“), alter, geburtsdatum (JJJJ-MM-TT, falls genannt), wohnort, beruf, familie (Bezugspersonen mit Namen/Rolle), hausarzt (Name der Hausärztin bzw. des Hausarztes). Nur neue oder geänderte Werte, sonst leerer Text. Personen, Beschwerden, Medikamente usw. zusätzlich wie gewohnt als Notiz.',
  '- Enthält die Aussage keine Angaben über die Person, gib eine leere Liste zurück.',
].join('\n');
const STECKBRIEF_FELDER = ['name', 'alter', 'geburtsdatum', 'wohnort', 'beruf', 'familie', 'hausarzt'];
const GESPRAECH_SCHEMA = {
  type: 'object',
  properties: {
    aenderungen: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          aktion: { type: 'string', enum: ['neu', 'ersetzen', 'widerspruch'] },
          id: { type: 'string' },
          art: { type: 'string', enum: ARTEN },
          text: { type: 'string' },
          sicher: { type: 'boolean' },
          zitat: { type: 'string' },
        },
        required: ['aktion', 'id', 'art', 'text', 'sicher', 'zitat'],
        additionalProperties: false,
      },
    },
    zusammenfassung: { type: 'string' },
    steckbrief: {
      type: 'object',
      properties: Object.fromEntries(['name', 'alter', 'geburtsdatum', 'wohnort', 'beruf', 'familie', 'hausarzt'].map((k) => [k, { type: 'string' }])),
      required: ['name', 'alter', 'geburtsdatum', 'wohnort', 'beruf', 'familie', 'hausarzt'],
      additionalProperties: false,
    },
  },
  required: ['aenderungen', 'zusammenfassung', 'steckbrief'],
  additionalProperties: false,
};
// Name sofort (ohne KI) erkennen, damit schon die nächste Antwort ihn kennt. Eindeutige Formulierungen in 5 Sprachen.
const NAME_RE = [
  /(?:^|[\s,.!?])(?:[Ii]ch hei(?:ß|ss)e|[Mm]ein [Nn]ame ist|[Nn]enn(?:e|t)? mich|[Ss]ag(?:t)? (?:einfach )?zu mir)(?:\s+(?:einfach|doch|bitte|gern|gerne))?\s+([A-ZÄÖÜ][\p{L}'-]{1,30}(?:\s+[A-ZÄÖÜ][\p{L}'-]{1,30})?)/u,
  /\b(?:my name is|call me|i'm called|i am called)\s+([A-Z][\p{L}'-]{1,30}(?:\s+[A-Z][\p{L}'-]{1,30})?)/iu,
  /\b(?:je m'appelle|je m’appelle|appelle-moi|mon nom est|mon prénom est)\s+([A-ZÀ-Ý][\p{L}'-]{1,30}(?:\s+[A-ZÀ-Ý][\p{L}'-]{1,30})?)/iu,
  /\b(?:benim adım|adım|bana)\s+([A-ZÇĞİÖŞÜ][\p{L}'-]{1,30})(?:\s+de)?/u,
  /(?:اسمي|نادني)\s+([\p{L}]{2,30}(?:\s+[\p{L}]{2,30})?)/u,
];
const KEIN_NAME = /^(müde|krank|traurig|froh|hier|da|gut|sad|tired|fine|here|fatigué|malade|ici|yorgun|hasta)$/i;
// Gewünschte Anrede („nenn mich …“, „call me …“) hat Vorrang vor dem vollen Namen.
const RUFNAME_RE = /(?:[Nn]enn(?:e|t)? mich|[Cc]all me|[Aa]ppelle-moi|نادني)\s+(?:(?:einfach|doch|bitte|gern|gerne)\s+)?([\p{Lu}\p{Lo}][\p{L}'-]{1,30})/u;
function nameAus(text) {
  const ruf = RUFNAME_RE.exec(String(text || ''));
  if (ruf && !KEIN_NAME.test(ruf[1])) return ruf[1];
  for (const re of NAME_RE) {
    const m = re.exec(String(text || ''));
    if (m && !KEIN_NAME.test(m[1].trim())) return m[1].trim().replace(/[.,!?]+$/, '');
  }
  return null;
}
function setzeSteckbrief(g, feld, wert, zeit, quelle = 'gespraech') {
  let w = saeubere(wert, 120);
  if (feld === 'name') {
    const anrede = /Anrede:?\s*([\p{L}'-]{2,30})/u.exec(w);
    w = (anrede ? anrede[1] : w.replace(/\s*\(.*$/, '')).trim();   // nur Name bzw. gewünschte Anrede, ohne Zusatz
  }
  if (!w || !STECKBRIEF_FELDER.includes(feld)) return false;
  g.steckbrief = g.steckbrief || {};
  const alt = g.steckbrief[feld];
  if (alt && alt.wert === w) return false;
  g.steckbrief[feld] = { wert: w, zeit, quelle, ...(alt && alt.wert !== w ? { vorher: alt.wert } : {}) };
  return true;
}

// Kurze Floskeln lohnen keinen KI-Aufruf.
const FLOSKEL_RE = /^(hallo|hi|hey|servus|moin|guten (morgen|tag|abend)|danke( schön| dir)?|vielen dank|tschüss|bye|ok(ay)?|alles klar|super|gut|prima|hello|thanks|thank you|merci|bonjour|merhaba|teşekkürler|مرحبا|شكرا)[\s!.?,]*$/i;

function archiviere(g, rolle, text, zeit) {
  const t = String(text || '').trim();
  if (!t) return;
  g.verlauf.push({ rolle, text: t.slice(0, MAX_VERLAUF_TEXT), zeit });
  if (g.verlauf.length > MAX_VERLAUF) g.verlauf = g.verlauf.slice(-MAX_VERLAUF);
}

/**
 * Nach jeder Antwort aufrufen, OHNE zu warten (blockiert die Antwort nie, wirft nie).
 * @returns {Promise<{ok, neu, ersetzt, widersprueche, uebersprungen?, fehler?}>}
 */
function lerneAusGespraech({ patientId, nutzerText, avatarText = '', sprache = 'de', model, apiKey } = {}) {
  const zeit = new Date().toISOString();
  // Archiv sofort (ohne KI), damit der Verlauf auch nach einem Neustart da ist.
  try {
    const g = lade(patientId);
    archiviere(g, 'nutzer', nutzerText, zeit);
    archiviere(g, 'avatar', avatarText, zeit);
    const n = nameAus(nutzerText);
    if (n) setzeSteckbrief(g, 'name', n, zeit);
    speichere(patientId, g);
  } catch (e) {
    return Promise.resolve({ ok: false, fehler: e.meldung || 'Speichern fehlgeschlagen' });
  }
  const aussage = String(nutzerText || '').trim();
  if (aussage.length < 3 || FLOSKEL_RE.test(aussage)) return Promise.resolve({ ok: true, neu: 0, ersetzt: 0, widersprueche: 0, uebersprungen: true });

  const gen = generation.get(patientId) || 0;
  return inSchlange(patientId, async () => {
    try {
      const g0 = lade(patientId);
      // Claude sieht alle Gesprächs-Notizen und die zur Aussage passenden Notizen aus Unterlagen.
      const gespraech = g0.fakten.filter((f) => f.quelle.typ === 'gespraech').slice(-60);
      const dok = g0.fakten.filter((f) => f.quelle.typ === 'dokument')
        .map((f) => ({ f, s: aehnlich(f.text, aussage) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.f);
      const notizen = [...gespraech, ...dok].map((f) => `${f.id} | ${f.art} | ${f.text}${f.quelle.typ === 'dokument' ? ' (aus Unterlagen)' : ''}`).join('\n') || '(noch keine)';
      const heute = new Date();
      const inhalt = [
        `Heute ist ${WOCHENTAGE[heute.getDay()]}, ${datumIso(heute)}. Sprache des Gesprächs: ${sprache}.`,
        `<notizen>\n${notizen}\n</notizen>`,
        `<zusammenfassung>${g0.zusammenfassung || '(leer)'}</zusammenfassung>`,
        `<steckbrief>${steckbriefText(g0) || '(leer)'}</steckbrief>`,
        `<antwort_begleiter_davor>${String(avatarText || '').slice(0, 1500)}</antwort_begleiter_davor>`,
        `<neue_aussage_person>${aussage.slice(0, 2000)}</neue_aussage_person>`,
      ].join('\n');
      // Hinweis: avatarText ist die Antwort AUF die Aussage; für „ja/nein“-Bezüge reicht das meist.
      const json = await claudeJson({ system: GESPRAECH_ANWEISUNG, inhalt, schema: GESPRAECH_SCHEMA, model, apiKey, zweck: 'Gesprächsauswertung' });
      if ((generation.get(patientId) || 0) !== gen) return { ok: false, fehler: 'verworfen (Gedächtnis gelöscht)' };

      const g = lade(patientId);   // frisch lesen (Archiv kann sich geändert haben)
      let neu = 0, ersetzt = 0, widersprueche = 0;
      for (const a of Array.isArray(json.aenderungen) ? json.aenderungen : []) {
        const text = saeubere(a.text, MAX_FAKT_TEXT);
        if (!text || !ARTEN.includes(a.art)) continue;
        const zitatRoh = saeubere(a.zitat, MAX_ZITAT);
        const zitat = zitatRoh && aussage.includes(zitatRoh) ? zitatRoh : '';
        const quelle = { typ: 'gespraech', zeit, zitat: zitat || saeubere(aussage, 150) };
        const alt = a.id ? g.fakten.find((f) => f.id === a.id) : null;
        if (a.aktion === 'ersetzen' && alt) {
          alt.vorher = [...(alt.vorher || []), { text: alt.text, quelle: alt.quelle }].slice(-5);
          Object.assign(alt, { art: a.art, text, quelle, sicher: !!a.sicher, aktualisiert: zeit });
          delete alt.widerspruch;
          ersetzt++;
        } else if (a.aktion === 'widerspruch' && alt) {
          alt.widerspruch = { text, quelle };
          widersprueche++;
        } else {
          const doppelt = istDoppelt(g, a.art, text);
          if (doppelt) { doppelt.aktualisiert = zeit; continue; }
          g.fakten.push({ id: neueId('g'), art: a.art, text, quelle, sicher: !!a.sicher, aktualisiert: zeit });
          neu++;
        }
      }
      const zf = saeubere(json.zusammenfassung, MAX_ZUSAMMENFASSUNG);
      if (zf) g.zusammenfassung = zf;
      // Steckbrief: jüngste Angabe gilt (alter Wert bleibt als „vorher“ sichtbar).
      for (const k of STECKBRIEF_FELDER) if (json.steckbrief && json.steckbrief[k]) setzeSteckbrief(g, k, json.steckbrief[k], zeit);
      speichere(patientId, g);
      console.log(`Gedächtnis: Gespräch ausgewertet (neu ${neu}, ersetzt ${ersetzt}, Widersprüche ${widersprueche})`);
      return { ok: true, neu, ersetzt, widersprueche };
    } catch (e) {
      return { ok: false, fehler: e.meldung || 'Fehler' };
    }
  });
}

// =============================================================================================
// 2. Aus Unterlagen lernen
// =============================================================================================
const DOKUMENT_ANWEISUNG = [
  'Du liest ein deutsches medizinisches Dokument (synthetische Testdaten) und notierst die wichtigsten Angaben über die Patientin bzw. den Patienten für ein Notizbuch.',
  'Regeln:',
  '- Nur was ausdrücklich im Text steht. Nichts ergänzen, nichts vermuten, nichts bewerten, keine Empfehlungen.',
  `- art: eine von ${DOK_ARTEN.join(', ')}. diagnose = festgestellte Erkrankungen; medikament = Medikamente mit Dosis, wenn angegeben; allergie = Allergien/Unverträglichkeiten; termin = vereinbarte Kontrollen oder Termine; person = behandelnde Ärztinnen/Ärzte oder Hausarzt mit Namen.`,
  '- text: kurze Notiz, höchstens 15 Wörter, Alltagssprache (Fachwort darf in Klammern dahinter stehen).',
  `- zitat: eine wörtlich und zeichengenau kopierte, zusammenhängende Stelle aus dem Text (höchstens ${MAX_ZITAT - 100} Zeichen), die die Angabe belegt.`,
  `- Höchstens ${MAX_DOK_FAKTEN} Angaben, die wichtigsten zuerst. Gleiche Angaben nur einmal.`,
  '- Steht nichts davon im Text, gib eine leere Liste zurück.',
].join('\n');
const DOKUMENT_SCHEMA = {
  type: 'object',
  properties: {
    fakten: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          art: { type: 'string', enum: DOK_ARTEN },
          text: { type: 'string' },
          zitat: { type: 'string' },
        },
        required: ['art', 'text', 'zitat'],
        additionalProperties: false,
      },
    },
  },
  required: ['fakten'],
  additionalProperties: false,
};
function pruefsumme(t) { return crypto.createHash('sha256').update(t).digest('hex').slice(0, 16); }

/**
 * Wichtigste Angaben eines Dokuments übernehmen (mit Zitat). Unverändertes Dokument → kein KI-Aufruf.
 * Für neue Uploads/Scans im Hintergrund aufrufen: g.lerneAusDokument({patientId, docId}).catch(() => {}).
 * @returns {Promise<{docId, neu, ausCache}>}  wirft gFehler
 */
function lerneAusDokument({ patientId, docId, model, apiKey, erzwingen = false } = {}) {
  const gen = generation.get(patientId) || 0;
  let dok;
  try { dok = rag.ladeDokument(patientId, docId); } catch (e) { return Promise.reject(e); }   // 404, wenn es das Dokument nicht gibt
  const text = String(dok.text || '');
  if (text.length > MAX_DOK_ZEICHEN) return Promise.reject(gFehler(413, 'Das Dokument ist zu lang für das Gedächtnis.'));
  const summe = pruefsumme(text);
  if (!erzwingen && lade(patientId).dokumente[docId] === summe) return Promise.resolve({ docId, neu: 0, ausCache: true });

  // Der KI-Aufruf läuft parallel; nur das Einsortieren läuft in der Warteschlange.
  const anfrage = claudeJson({
    system: DOKUMENT_ANWEISUNG,
    inhalt: `<dokument titel="${saeubere(dok.titel, 80)}" datum="${dok.datum || ''}">\n${text}\n</dokument>\n\nNotiere die wichtigsten Angaben.`,
    schema: DOKUMENT_SCHEMA, maxTokens: 3000, model, apiKey, zweck: 'Dokumentauswertung',
  });
  anfrage.catch(() => {});   // Fehler wird unten in der Warteschlange ausgewertet (kein „unhandled rejection“)
  return inSchlange(patientId, async () => {
    const json = await anfrage;
    if ((generation.get(patientId) || 0) !== gen) return { docId, neu: 0, verworfen: true };
    // Inzwischen gelöscht? Dann nichts mehr eintragen (Konsistenz).
    let nochDa = false;
    try { nochDa = rag.ladePatient(patientId).dokumente.some((d) => d.docId === docId); } catch {}
    if (!nochDa) return { docId, neu: 0, verworfen: true };
    const g = lade(patientId);
    g.fakten = g.fakten.filter((f) => !(f.quelle.typ === 'dokument' && f.quelle.docId === docId));   // Neuberechnung ersetzt alte
    const zeit = new Date().toISOString();
    let neu = 0;
    for (const f of (Array.isArray(json.fakten) ? json.fakten : []).slice(0, MAX_DOK_FAKTEN)) {
      const t = saeubere(f.text, MAX_FAKT_TEXT);
      if (!t || !DOK_ARTEN.includes(f.art)) continue;
      const stelle = pd.findeZitat(text, f.zitat);
      const quelle = {
        typ: 'dokument', zeit, docId, titel: dok.titel, datum: dok.datum || null,
        zitat: stelle ? text.slice(stelle.start, stelle.ende).slice(0, MAX_ZITAT) : saeubere(f.zitat, MAX_ZITAT),
        start: stelle ? stelle.start : null, ende: stelle ? stelle.ende : null, belegt: !!stelle,
      };
      const doppelt = istDoppelt(g, f.art, t);
      if (doppelt && doppelt.quelle.typ === 'dokument') {
        doppelt.weitereQuellen = [...(doppelt.weitereQuellen || []), { docId, datum: quelle.datum }].slice(-5);
        continue;
      }
      g.fakten.push({ id: neueId('d'), art: f.art, text: t, quelle, sicher: !!stelle, aktualisiert: zeit });
      neu++;
    }
    g.dokumente[docId] = summe;
    speichere(patientId, g);
    console.log(`Gedächtnis: Dokument ausgewertet (${neu} Angaben)`);
    return { docId, neu, ausCache: false };
  });
}

// Alle noch nicht gelernten Dokumente (z. B. einmalig für p2). Rückgabe {gelernt, neu, fehler:[{docId,status}]}
async function lerneAlleDokumente(patientId, { parallel = 4, model, apiKey } = {}) {
  const p = rag.ladePatient(patientId);
  const ids = p.dokumente.map((d) => d.docId);
  const ergebnis = { gelernt: 0, neu: 0, ausCache: 0, fehler: [] };
  let i = 0;
  async function arbeiter() {
    while (i < ids.length) {
      const docId = ids[i++];
      try {
        const r = await lerneAusDokument({ patientId, docId, model, apiKey });
        if (r.ausCache) ergebnis.ausCache++; else { ergebnis.gelernt++; ergebnis.neu += r.neu; }
      } catch (e) { ergebnis.fehler.push({ docId, status: e.status || 500 }); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, arbeiter));
  return ergebnis;
}

// Dokument gelöscht → seine Angaben vergessen (ohne KI).
function vergissDokument(patientId, docId) {
  const g = lade(patientId);
  const vorher = g.fakten.length;
  g.fakten = g.fakten.filter((f) => !(f.quelle.typ === 'dokument' && f.quelle.docId === docId));
  delete g.dokumente[docId];
  speichere(patientId, g);
  return { entfernt: vorher - g.fakten.length };
}

// =============================================================================================
// 3. Abruf für eine Frage
// =============================================================================================
// „Du hast mir am 28.11.2026 erzählt …“ bzw. „Arztbrief vom 10.2.2022“
function quellenText(f) {
  if (f.quelle.typ === 'gespraech') return `Du hast mir am ${datumKurz(f.quelle.zeit)} erzählt`;
  return `${f.quelle.titel || 'Unterlage'} vom ${datumDeutsch(f.quelle.datum)}`;
}
// Zum Vorlesen: „vorhin“, „gestern“, „am 25.11.“ statt eines vollen Datums.
function wannGesprochen(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const tage = Math.round((new Date(datumIso()) - new Date(datumIso(d))) / 86400000);
  if (tage <= 0) return 'vorhin';
  if (tage === 1) return 'gestern';
  return `am ${d.getDate()}.${d.getMonth() + 1}.`;
}
function quellenKurz(f) {
  if (f.quelle.typ === 'gespraech') return `hast du mir ${wannGesprochen(f.quelle.zeit)} erzählt`;
  return `${f.quelle.titel || 'Unterlage'} vom ${datumDeutsch(f.quelle.datum)}`;
}
function faktFuerAnzeige(f) {
  return {
    id: f.id, art: f.art, text: f.text, sicher: f.sicher !== false, aktualisiert: f.aktualisiert,
    quelleTyp: f.quelle.typ, quelleText: quellenText(f), zitat: f.quelle.zitat || '',
    docId: f.quelle.docId || null, start: f.quelle.start ?? null, ende: f.quelle.ende ?? null,
    widerspruch: f.widerspruch ? { text: f.widerspruch.text, quelleText: `Du hast mir am ${datumKurz(f.widerspruch.quelle.zeit)} erzählt` } : null,
  };
}

// Passende Fakten zu einer Frage: alle aus dem Gespräch (wenige, persönlich) + die passendsten aus Unterlagen.
const VORLIEBE_JEDE = 5;
const vorliebeZaehler = new Map();
function abrufFakten({ patientId, frage = '', maxGespraech = KONTEXT_GESPRAECH_MAX, maxDokument = KONTEXT_DOKUMENT_MAX } = {}) {
  const g = lade(patientId);
  const q = String(frage || '');
  const bewerte = (f) => aehnlich(`${f.art} ${f.text}`, q) + (ART_HINWEISE[f.art]?.test(q) ? 0.5 : 0);
  // Relevanzschwelle (28.11.2026): Gesprächs-Fakten nur, wenn sie zur Frage passen – sonst lenkt mitano. z. B. beim
  // Smalltalk ungefragt auf Medikamente. Vorlieben (z. B. „geht gern wandern“) dürfen immer mit. Bei ausdrücklichen
  // Gedächtnisfragen („Was weißt du über mich?“) alle.
  const alleGespraech = GEDAECHTNIS_FRAGE_RE.test(q) && !/wie heißt|wie heisst|wer ist|worauf|welche|was nehme|seit wann/i.test(q);
  // Vorlieben ohne Bezug zur Frage nur gelegentlich (jede VORLIEBE_JEDE-te Frage), sonst wirkt mitano. aufdringlich.
  const zaehler = (vorliebeZaehler.get(patientId) || 0) + 1;
  vorliebeZaehler.set(patientId, zaehler);
  const vorliebeDran = zaehler % VORLIEBE_JEDE === 0;
  const gespraech = g.fakten.filter((f) => f.quelle.typ === 'gespraech')
    .map((f) => ({ f, s: bewerte(f) }))
    .filter((x) => alleGespraech || x.s > 0 || (x.f.art === 'vorliebe' && vorliebeDran))
    .sort((a, b) => b.s - a.s || String(b.f.aktualisiert).localeCompare(String(a.f.aktualisiert)))
    .slice(0, maxGespraech).map((x) => x.f);
  const relevant = alleGespraech || gespraech.some((f) => f.art !== 'vorliebe');
  const dokument = g.fakten.filter((f) => f.quelle.typ === 'dokument')
    .map((f) => ({ f, s: bewerte(f) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s).slice(0, maxDokument).map((x) => x.f);
  // Die Kurz-Zusammenfassung enthält alles Erzählte → nur, wenn etwas davon zur Frage passt.
  return { zusammenfassung: relevant ? g.zusammenfassung : '', gespraech, dokument };
}
// Grobe Zuordnung Frage → Art (macht „Welche Medikamente nehme ich?“ auch ohne gleiche Wörter treffsicher).
const ART_HINWEISE = {
  medikament: /medikament|tablette|pille|nehme ich|dosis|mg\b|medication|médicament|ilaç|دواء|أدوية/i,
  allergie: /allerg|unverträglich|vertrage|alerj|حساسية/i,
  person: /arzt|ärztin|hausarzt|doktor|dr\.|frau|mann|sohn|tochter|heißt|name|doctor|médecin|doktor|طبيب/i,
  termin: /termin|kontrolle|wann muss|appointment|rendez|randevu|موعد/i,
  beschwerde: /beschwerd|schmerz|schwindel|weh|übel|symptom|fühl|douleur|ağrı|ألم/i,
  diagnose: /diagnose|krankheit|erkrank|habe ich|disease|maladie|hastalık|مرض/i,
};

/**
 * Kompakter Block für den Systemkontext von Claude (an den Systemprompt anhängen).
 * @returns {{text: string, fakten: object[], leer: boolean}}  fakten = für die Quellen-Anzeige (faktFuerAnzeige)
 */
// Steckbrief als eine Zeile: Eckdaten + (aus Gesprächen) Allergien, Hauptdiagnosen, Medikamente.
const STECKBRIEF_NAMEN = { name: 'Name/Anrede', alter: 'Alter', geburtsdatum: 'Geburtsdatum', wohnort: 'Wohnort', beruf: 'Beruf', familie: 'Familie/Bezugspersonen', hausarzt: 'Hausarzt/Hausärztin' };
function steckbriefText(g) {
  const sb = g.steckbrief || {};
  const teile = STECKBRIEF_FELDER.filter((k) => sb[k]?.wert).map((k) => `${STECKBRIEF_NAMEN[k]}: ${sb[k].wert}`);
  const ausGespraech = (art, n) => g.fakten.filter((f) => f.art === art && f.quelle.typ === 'gespraech').slice(-n).map((f) => f.text);
  const all = ausGespraech('allergie', 3), dia = ausGespraech('diagnose', 3), med = ausGespraech('medikament', 4);
  if (all.length) teile.push(`Allergien: ${all.join(', ')}`);
  if (dia.length) teile.push(`Hauptdiagnosen: ${dia.join(', ')}`);
  if (med.length) teile.push(`Medikamente: ${med.join(', ')}`);
  return teile.join('; ');
}
function steckbrief(patientId) {
  const g = lade(patientId);
  const sb = g.steckbrief || {};
  return { ...Object.fromEntries(STECKBRIEF_FELDER.map((k) => [k, sb[k]?.wert || null])), text: steckbriefText(g) };
}
function kontextFuerFrage({ patientId, frage = '' } = {}) {
  let a;
  try { a = abrufFakten({ patientId, frage }); } catch { return { text: '', fakten: [], leer: true }; }
  let sbText = '';
  try { sbText = steckbriefText(lade(patientId)); } catch {}
  const alle = [...a.gespraech, ...a.dokument];
  if (!alle.length && !a.zusammenfassung && !sbText) return { text: '', fakten: [], leer: true };
  const zeile = (f) => {
    let z = `- [${f.art}] ${f.text} (${quellenKurz(f)}${f.sicher === false ? ', unsicher' : ''})`;
    if (f.widerspruch) z += ` – später anders gesagt: „${f.widerspruch.text}“ (${wannGesprochen(f.widerspruch.quelle.zeit)}), nachfragen`;
    return z;
  };
  const teile = ['Technischer Hinweis – Gedächtnis zur Person (aus früheren Gesprächen und den Unterlagen gesammelt; jüngere Angaben gelten vor älteren). Nutze es, wenn es zur Frage passt, und nenne die Herkunft knapp (z. B. „hast du mir vorhin erzählt“). Kommt die Antwort aus dem Gedächtnis, musst du nicht erwähnen, was in den Unterlagen fehlt.'];
  if (sbText) teile.push(`Steckbrief der Person (gilt immer, jüngste Angabe zählt; den Namen gern für die Anrede nutzen, Medizinisches nur erwähnen, wenn es zur Frage passt): ${sbText}`);
  if (a.zusammenfassung) teile.push(`Kurz-Zusammenfassung: ${a.zusammenfassung}`);
  if (a.gespraech.length) teile.push('Aus Gesprächen:\n' + a.gespraech.map(zeile).join('\n'));
  if (a.dokument.length) teile.push('Aus den Unterlagen (passend zur Frage):\n' + a.dokument.map(zeile).join('\n'));
  return { text: teile.join('\n'), fakten: alle.map(faktFuerAnzeige), leer: false };
}

// Welche Gedächtnis-Fakten hat die Antwort tatsächlich benutzt? → für den Quellen-Knopf.
// Ein Fakt zählt, wenn ein „markantes“ Wort (Name, Wirkstoff, Beschwerde; nicht Tageszeit/Dosis-Floskel) in der Antwort vorkommt.
const ALLGEMEIN = new Set(rag.woerter('morgens abends mittags nachts taeglich täglich dosis laut seit heisst heißt nehme nimmt erhoeht erhöht ' +
  'allergie allergisch gegen hausarzt arzt aerztin ärztin behandelnd tabletten medikament einmal zweimal dreimal unterlagen arztbrief'));
function markant(text) { return rag.woerter(text).filter((w) => w.length >= 4 && !ALLGEMEIN.has(w) && !/^\d/.test(w)); }
function quellenAusAntwort({ fakten = [], antwort = '' } = {}) {
  const aw = new Set(rag.woerter(antwort));
  return fakten.filter((f) => markant(f.text).some((w) => aw.has(w)));
}

// Bezieht sich die Frage auf früher Gesagtes oder persönliche Fakten? (für die Weiche nativ/claude)
const GEDAECHTNIS_FRAGE_RE = new RegExp([
  'vorhin', 'eben gesagt', 'hab(e)? ich (dir )?(schon )?(erzählt|gesagt)', 'erinnerst du', 'weißt du noch', 'weisst du noch',
  'was weißt du über mich', 'was weisst du über mich', 'wie heißt mein', 'wie heisst mein', 'wer ist mein', 'mein(e|en)? (haus)?(arzt|ärztin)',
  'worauf bin ich allergisch', 'meine allergie', 'welche medikamente nehme ich', 'was nehme ich', 'seit wann', 'mein(e)? termin',
  'earlier', 'i told you', 'do you remember', 'what do you know about me', 'my doctor',
  'tout à l\'heure', 'je t\'ai dit', 'tu te souviens', 'mon médecin',
  'demin', 'sana söyledim', 'hatırlıyor musun', 'doktorum',
  'قبل قليل', 'أخبرتك', 'هل تتذكر', 'طبيبي',
].join('|'), 'i');
function istGedaechtnisFrage(text, patientId) {
  const t = String(text || '');
  if (GEDAECHTNIS_FRAGE_RE.test(t)) return true;
  if (!patientId) return false;
  try {
    // Frage trifft eine persönliche Gesprächs-Notiz deutlich (z. B. „Wie war das mit Dr. Sommer?“)
    return lade(patientId).fakten.some((f) => f.quelle.typ === 'gespraech' && aehnlich(f.text, t) >= 0.5);
  } catch { return false; }
}

// Gesprächsverlauf aus dem Archiv (z. B. als Startverlauf nach einem Neustart) → [{rolle, text}]
function verlauf(patientId, n = 10) {
  return lade(patientId).verlauf.slice(-Math.max(0, n)).map(({ rolle, text }) => ({ rolle, text }));
}

// =============================================================================================
// 4. Anzeige und Löschen
// =============================================================================================
// Für „Was mitano. über dich weiß“ (GET /api/gedaechtnis)
function exportiere(patientId) {
  const g = lade(patientId);
  const reihenfolge = (f) => ARTEN.indexOf(f.art);
  const sortiert = [...g.fakten].sort((a, b) =>
    (a.quelle.typ === b.quelle.typ ? 0 : a.quelle.typ === 'gespraech' ? -1 : 1) ||
    reihenfolge(a) - reihenfolge(b) || String(b.aktualisiert).localeCompare(String(a.aktualisiert)));
  return {
    patientId,
    synthetisch: true,
    zusammenfassung: g.zusammenfassung,
    steckbrief: Object.fromEntries(STECKBRIEF_FELDER.filter((k) => g.steckbrief?.[k]?.wert).map((k) => [k, g.steckbrief[k].wert])),
    anzahl: { gesamt: g.fakten.length, gespraech: g.fakten.filter((f) => f.quelle.typ === 'gespraech').length, dokument: g.fakten.filter((f) => f.quelle.typ === 'dokument').length, verlauf: g.verlauf.length },
    fakten: sortiert.map(faktFuerAnzeige),
    aktualisiert: g.aktualisiert,
  };
}
function ohneFakt(zusammenfassung, text) {
  const w = new Set(markant(text));
  if (!w.size) return zusammenfassung;
  return String(zusammenfassung || '').split(/(?<!\b(?:Dr|Prof|Hr|Fr|Nr|ca|bzw|ggf|z\.\s?B|u\.\s?a|St)\.)(?<=[.!?])\s+/i)
    .filter((satz) => !rag.woerter(satz).some((x) => w.has(x))).join(' ').trim();
}
function loescheFakt(patientId, faktId) {
  if (!FAKT_ID_RE.test(String(faktId || ''))) throw gFehler(400, 'Ungültige ID.');
  const g = lade(patientId);
  const i = g.fakten.findIndex((f) => f.id === faktId);
  if (i < 0) throw gFehler(404, 'Diesen Eintrag gibt es nicht (mehr).');
  const [weg] = g.fakten.splice(i, 1);
  // Vergessen heißt vergessen: auch aus der Kurz-Zusammenfassung die Sätze entfernen, die diese Angabe enthalten.
  if (weg.quelle.typ === 'gespraech') g.zusammenfassung = ohneFakt(g.zusammenfassung, weg.text);
  if (!g.fakten.some((f) => f.quelle.typ === 'gespraech')) g.zusammenfassung = '';
  // Gelöschte Dokument-Angabe soll nicht beim nächsten Lernen zurückkommen: Dokument als gelernt behalten.
  speichere(patientId, g);
  return exportiere(patientId);
}
// Alles vergessen (Demo zurücksetzen). Laufende Lernvorgänge werden verworfen.
function vergiss(patientId) {
  const d = datei(patientId);
  generation.set(patientId, (generation.get(patientId) || 0) + 1);
  fs.rmSync(d, { force: true });
  return { patientId, geloescht: true };
}

module.exports = {
  ARTEN,
  // Lernen
  lerneAusGespraech, lerneAusDokument, lerneAlleDokumente, vergissDokument, warteAufLernen,
  // Abruf
  kontextFuerFrage, abrufFakten, quellenAusAntwort, istGedaechtnisFrage, verlauf, steckbrief, nameAus,
  // Anzeige / Löschen
  exportiere, loescheFakt, vergiss,
  // Tests / prüfbare Anweisungen
  setzeBasis, GESPRAECH_ANWEISUNG, DOKUMENT_ANWEISUNG,
};
