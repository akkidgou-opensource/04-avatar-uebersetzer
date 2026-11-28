'use strict';
// ---------------------------------------------------------------------------------------------
// rag.js – Wissensspeicher für Test-Patienten (nur synthetische Arztbriefe, nur Node-Bordmittel)
//
// Ablauf einer Frage (vom Team prüfbar):
//   1. Frage (+ letzte Nutzerfrage aus dem Verlauf) in Suchwörter zerlegen (deutsche Normalisierung).
//   2. Optional: Claude (schnelles Modell) schlägt 5–12 Suchbegriffe/Fachsynonyme vor (max. 4 s, sonst ohne).
//   3. BM25-Suche über alle Abschnitte („Chunks“) der Unterlagen des Patienten → beste 6–8 Abschnitte.
//   4. Diese Abschnitte gehen als document-Blöcke mit eingeschalteten Citations an Claude.
//   5. Ergebnis: Text ohne Quellenmarker (zum Vorlesen) + Liste der Quellen (Dokument, Abschnitt, Zitat, Stelle).
//
// Speicherort: lokal/patienten/<patientId>/  (patient.json, index.json, dokumente/<docId>.txt)
// Dateien 0600, Ordner 0700, atomar geschrieben. Inhalte werden NIE geloggt.
// Kein Embedding-Anbieter: BM25 ist ein „sparse vector store“; der Bewerter ist austauschbar (setzeBewerter).
// ---------------------------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let BASIS = path.join(__dirname, 'lokal', 'patienten');
const PROJEKT = __dirname;

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const SUCH_MODELL_STANDARD = 'claude-haiku-5-5';
const ANTWORT_MODELL_STANDARD = 'claude-sonnet-5-5';
const FALLBACK_MODELLE = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
const OHNE_EFFORT = ['claude-haiku-4-5', 'claude-sonnet-4-5'];
const ERWEITERUNG_TIMEOUT_MS = 4000;
const ANTWORT_TIMEOUT_MS = 60 * 1000;
// Erster Teil früher sprechen: ab so vielen Zeichen darf der erste Teil an Komma/Gedankenstrich enden (0 = aus). Per .env.
const ERSTER_TEIL_ZEICHEN = Math.max(0, Math.min(200, Number.isFinite(Number(process.env.ERSTER_TEIL_ZEICHEN)) && process.env.ERSTER_TEIL_ZEICHEN !== '' ? Number(process.env.ERSTER_TEIL_ZEICHEN) : 60));
// Obergrenze inkl. Denkanteil (Sonnet 5.5 denkt trotz „between_tools“ manchmal vorher; 450 reichte dann für keinen Text).
// Kürze steuern Stil-Hinweis und Satzbremse in server.js. Per .env GESPRAECH_MAX_TOKENS änderbar (mind. 1024).
const ANTWORT_MAX_TOKENS = Math.min(8192, Math.max(1024, Number(process.env.GESPRAECH_MAX_TOKENS) || 2048));

const CHUNK_ZIEL = 750;      // Zielgröße eines Abschnitts in Zeichen
const CHUNK_MIN = 600;
const CHUNK_MAX = 900;
const UEBERLAPPUNG_MAX = 250; // letzter kurzer Absatz wird in den nächsten Abschnitt mitgenommen
const TOP_K = 8;
const MAX_KONTEXT_ZEICHEN = 12000;
const MAX_JE_DOKUMENT = 3;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const DOC_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// ---------- Fehler (gleiche Form wie kiFehler in server.js: status + meldung) ----------
function ragFehler(status, meldung) {
  const e = new Error(meldung);
  e.status = status;
  e.meldung = meldung;
  return e;
}

// ---------- Dateien ----------
function setzeBasis(ordner) { BASIS = ordner; }
function patientOrdner(patientId) {
  if (!ID_RE.test(String(patientId || ''))) throw ragFehler(400, 'Ungültige Patienten-ID (nur Buchstaben, Ziffern, - und _).');
  return path.join(BASIS, patientId);
}
function ordnerAnlegen(o) { fs.mkdirSync(o, { recursive: true, mode: 0o700 }); }
function schreibeAtomar(datei, inhalt) {
  ordnerAnlegen(path.dirname(datei));
  const tmp = `${datei}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, inhalt, { mode: 0o600 });
  fs.renameSync(tmp, datei);
}
function leseJson(datei, ersatz) {
  try { return JSON.parse(fs.readFileSync(datei, 'utf8')); } catch { return ersatz; }
}

// ---------- Deutsche Normalisierung ----------
const STOPPWOERTER = new Set((
  'aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist ' +
  'da damit dann das dass dein deine dem den der des dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch ' +
  'ein eine einem einen einer eines einig einige er es etwas euch euer eure fuer gegen gewesen hab habe haben hat hatte hatten hier hin ' +
  'hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer im in indem ins ist jede jedem jeden jeder jedes jetzt kann kein keine keinem keinen ' +
  'koennen koennte man manche mein meine meinem meinen meiner mich mir mit muss musste nach nicht nichts noch nun nur ob oder ohne sehr sein ' +
  'seine seinem seinen seiner seit sich sie sind so solche soll sollte sondern sonst ueber um und uns unser unsere unter viel vom von vor ' +
  'war waren warst was weg weil weiter welche welchem welchen welcher welches wenn wer werde werden wie wieder will wir wird wo wollen ' +
  'wurde wurden zu zum zur zwar zwischen bitte mal gibt gab geht ging los denn eigentlich genau gerade gut ja nein wann warum wieso weshalb ' +
  'zuletzt letzte letzten letzter immer schon wirklich gemacht macht passiert erzaehl erklaer sag sage'
).split(' '));

function umlauteWeg(t) {
  return t.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
}
// Leichte Stammformung: häufige Endungen ab, aber nur bei längeren Wörtern.
function stamm(w) {
  if (w.length <= 4 || /^\d/.test(w)) return w;
  for (const end of ['ungen', 'innen', 'heiten', 'keiten', 'ischen', 'ische', 'ischer', 'isches', 'ern', 'em', 'en', 'er', 'es', 'e', 'n', 's']) {
    if (w.length - end.length >= 4 && w.endsWith(end)) return w.slice(0, -end.length);
  }
  return w;
}
function woerter(text) {
  const roh = umlauteWeg(String(text || '')).split(/[^a-z0-9]+/);
  const aus = [];
  for (const w of roh) {
    if (w.length < 2 || STOPPWOERTER.has(w)) continue;
    if (/^\d+$/.test(w) && w.length < 4) continue;   // kurze Zahlen (Tage, Dosen) sind kaum trennscharf
    aus.push(stamm(w));
  }
  return aus;
}

// ---------- Datum, Titel ----------
const DATUM_RE = /(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4}|\d{2})(?!\d)/g;
function isoDatum(t, m, j) {
  let jahr = Number(j);
  // Zweistellig: 20JJ, außer das läge mehr als 5 Jahre in der Zukunft (dann 19JJ, z. B. Geburtsdatum 5.7.54).
  if (j.length === 2) jahr += jahr + 2000 > new Date().getFullYear() + 5 ? 1900 : 2000;
  const tag = Number(t), monat = Number(m);
  if (monat < 1 || monat > 12 || tag < 1 || tag > 31) return null;
  return `${jahr}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}
// Briefdatum erkennen: erst eindeutige Stellen („Arztbrief vom“, „bis zum“, „Entlassung am“), sonst das
// späteste Datum am Briefanfang. Geburtsdaten (* / geb.) werden übersprungen. Ohne Treffer: null.
function erkenneDatum(text) {
  const t = String(text || '');
  const kandidaten = [];
  let m;
  DATUM_RE.lastIndex = 0;
  while ((m = DATUM_RE.exec(t))) {
    const vorher = t.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
    if (/\*\s*$|geb\.?\s*(am)?\s*$|geboren\s*(am)?\s*$/.test(vorher)) continue;
    const iso = isoDatum(m[1], m[2], m[3]);
    if (iso) kandidaten.push({ iso, pos: m.index, vorher: t.slice(Math.max(0, m.index - 40), m.index).toLowerCase() });
  }
  if (!kandidaten.length) return null;
  const stark = kandidaten.find((k) => /(arztbrief|brief|bericht|datum)\s*(vom|:)?\s*$/.test(k.vorher) || /(bis\s*(zum)?|entlassung\s*(am)?|entlassen\s*(am)?)\s*$/.test(k.vorher));
  if (stark) return stark.iso;
  const vorn = kandidaten.filter((k) => k.pos < 1500);
  return (vorn.length ? vorn : kandidaten).map((k) => k.iso).sort().pop();
}
const FAECHER = ['Kardiologie', 'Neurologie', 'Onkologie', 'Gastroenterologie', 'Neurochirurgie', 'Unfallchirurgie', 'Allgemeinchirurgie',
  'Chirurgie', 'Psychiatrie', 'Dermatologie', 'Orthopädie', 'Urologie', 'Gynäkologie', 'Pneumologie', 'Nephrologie', 'Hämatologie',
  'Ophthalmologie', 'Augenheilkunde', 'Innere Medizin', 'Radiologie', 'Geriatrie', 'Rheumatologie', 'Endokrinologie', 'Pädiatrie', 'HNO'];
function erkenneTitel(text, ersatz) {
  const t = String(text || '');
  const kopf = t.slice(0, 600);
  let art = (kopf.match(/\b(Entlassungsbrief|Entlassungsbericht|Arztbrief|Befundbericht|Ambulanzbrief|Konsiliarbericht|Operationsbericht|OP-Bericht|Verlegungsbericht|Kurzbrief)\b/i) || [])[1];
  art = art ? art.charAt(0).toUpperCase() + art.slice(1).toLowerCase().replace('op-bericht', 'OP-Bericht') : 'Arztbrief';
  if (art === 'Op-bericht') art = 'OP-Bericht';
  let fach = (t.slice(0, 3000).match(/\b(?:Klinik|Abteilung|Zentrum)\s+für\s+([A-ZÄÖÜ][a-zäöüß-]+(?:\s+und\s+[A-ZÄÖÜ][a-zäöüß-]+)?)/) || [])[1];
  if (!fach) fach = FAECHER.find((f) => new RegExp(`\\b${f}`, 'i').test(t.slice(0, 1500)));
  return [art, fach].filter(Boolean).join(' – ') + (ersatz ? ` (${ersatz})` : '');
}

// ---------- Chunking ----------
// Bekannte Abschnittsüberschriften (nur zum Erkennen, keine medizinische Logik).
const UEBERSCHRIFTEN = [
  'anamnese', 'diagnose', 'diagnosen', 'befund', 'befunde', 'therapie', 'medikation', 'verlauf', 'epikrise', 'procedere',
  'beurteilung', 'labor', 'histo', 'histologie', 'entlassung', 'aufnahme', 'aufnahmegrund', 'allergien', 'vorerkrankungen',
  'zusammenfassung', 'empfehlung', 'untersuchung', 'operation', 'bestrahlung', 'dekurs', 'vorgeschichte', 'nebendiagnosen',
  'hauptdiagnose', 'sozialanamnese', 'familienanamnese', 'tumormarker', 'blutbild', 'sonographie', 'roentgen', 'ct', 'mrt',
  'ekg', 'echokardiographie', 'herzkatheter', 'weiteres vorgehen', 'empfehlungen', 'fragestellung', 'indikation', 'eingriff',
];
function istUeberschrift(zeile) {
  const z = zeile.trim();
  if (!z || z.length > 70) return null;
  const mitDoppelpunkt = z.match(/^([A-ZÄÖÜ][^:]{1,60}):\s*(.*)$/);
  const kopf = mitDoppelpunkt ? mitDoppelpunkt[1] : z;
  const norm = umlauteWeg(kopf);
  const bekannt = UEBERSCHRIFTEN.some((u) => norm.split(/[^a-z]+/).some((w) => w && (w === u || (w.length > 5 && w.startsWith(u)) || w.endsWith(u))));
  const grossbuchstaben = /^[A-ZÄÖÜ0-9 /&.-]{4,}$/.test(kopf) && /[A-ZÄÖÜ]{4}/.test(kopf);
  if (mitDoppelpunkt && (bekannt || grossbuchstaben)) return kopf.trim();
  if (!mitDoppelpunkt && !/^[A-Za-zÄÖÜäöü]/.test(z)) return null;
  if (!mitDoppelpunkt && /\d/.test(z) && !grossbuchstaben) return null;
  if (!mitDoppelpunkt && (grossbuchstaben || (bekannt && z.split(/\s+/).length <= 4 && !/[.,;]$/.test(z)))) return kopf.trim();
  return null;
}
function schoeneUeberschrift(u) {
  if (!u) return 'Allgemein';
  return /^[A-ZÄÖÜ0-9 /&.-]+$/.test(u) ? u.charAt(0) + u.slice(1).toLowerCase() : u;
}
// Text in Einheiten zerlegen (Absätze bzw. Zeilengruppen), jeweils mit Zeichenposition und Abschnitt.
function einheiten(text) {
  const aus = [];
  let abschnitt = null, pos = 0, blockStart = -1, blockEnde = -1;
  const schliessen = () => {
    if (blockStart >= 0) aus.push({ start: blockStart, ende: blockEnde, abschnitt });
    blockStart = -1;
  };
  for (const zeile of text.split('\n')) {
    const start = pos, ende = pos + zeile.length;
    pos = ende + 1;
    if (!zeile.trim()) { schliessen(); continue; }
    const u = istUeberschrift(zeile);
    if (u) { schliessen(); abschnitt = u; }
    if (blockStart < 0) blockStart = start;
    blockEnde = ende;
    // lange Blöcke an Zeilengrenzen auftrennen
    if (blockEnde - blockStart >= CHUNK_ZIEL) schliessen();
  }
  schliessen();
  // Zu lange Einzelzeilen an Satzgrenzen teilen
  const fein = [];
  for (const e of aus) {
    let s = e.start;
    while (e.ende - s > CHUNK_MAX) {
      const stueck = text.slice(s, s + CHUNK_MAX);
      let schnitt = Math.max(stueck.lastIndexOf('. '), stueck.lastIndexOf('; '), stueck.lastIndexOf('\n'));
      if (schnitt < CHUNK_MIN / 2) schnitt = stueck.lastIndexOf(' ');
      if (schnitt < 100) schnitt = CHUNK_MAX - 1;
      fein.push({ start: s, ende: s + schnitt + 1, abschnitt: e.abschnitt });
      s = s + schnitt + 1;
    }
    if (e.ende > s) fein.push({ start: s, ende: e.ende, abschnitt: e.abschnitt });
  }
  return fein;
}
function abschnittName(liste) {
  let l = liste.map(schoeneUeberschrift);
  if (l.length > 1) l = l.filter((x) => x !== 'Allgemein');
  return l.slice(0, 3).join(', ') + (l.length > 3 ? ' …' : '');
}
function zerlege(dok, text) {
  const teile = einheiten(text);
  const chunks = [];
  let i = 0;
  while (i < teile.length) {
    const startIdx = i;
    let start = teile[i].start, ende = teile[i].ende;
    const abschnitte = [teile[i].abschnitt];
    i++;
    while (i < teile.length) {
      const n = teile[i];
      const neueLaenge = n.ende - start;
      const wechsel = n.abschnitt !== teile[i - 1].abschnitt;
      if (neueLaenge > CHUNK_MAX) break;
      if (wechsel && ende - start >= CHUNK_MIN) break;
      ende = n.ende;
      if (!abschnitte.includes(n.abschnitt)) abschnitte.push(n.abschnitt);
      i++;
    }
    chunks.push({
      chunkId: `${dok.docId}#${chunks.length + 1}`,
      docId: dok.docId, titel: dok.titel, datum: dok.datum,
      abschnitt: abschnittName(abschnitte),
      text: text.slice(start, ende), start, ende,
    });
    // Überlappung: letzten kurzen Absatz noch einmal mitnehmen (aber Fortschritt garantieren)
    // (nur wenn er zusammen mit dem nächsten Absatz in einen Abschnitt passt – sonst entstünde ein Duplikat)
    if (i < teile.length && i - 1 > startIdx && teile[i - 1].ende - teile[i - 1].start <= UEBERLAPPUNG_MAX &&
        teile[i].ende - teile[i - 1].start <= CHUNK_MAX) i--;
  }
  return chunks;
}

// ---------- Index (BM25) ----------
function baueIndex(patientId) {
  const ordner = patientOrdner(patientId);
  const patient = ladePatient(patientId);
  const chunks = [];
  for (const d of patient.dokumente) {
    let text = '';
    try { text = fs.readFileSync(path.join(ordner, 'dokumente', `${d.docId}.txt`), 'utf8'); } catch { continue; }
    chunks.push(...zerlege(d, text));
  }
  const df = {};
  let gesamt = 0;
  for (const c of chunks) {
    const w = woerter(`${c.titel} ${c.abschnitt} ${c.text}`);
    const tf = {};
    for (const x of w) tf[x] = (tf[x] || 0) + 1;
    c.tf = tf; c.laenge = w.length; gesamt += w.length;
    for (const x of Object.keys(tf)) df[x] = (df[x] || 0) + 1;
  }
  const index = { version: 1, bewerter: 'bm25', erstelltAm: new Date().toISOString(), N: chunks.length, avgdl: chunks.length ? gesamt / chunks.length : 0, df, chunks };
  schreibeAtomar(path.join(ordner, 'index.json'), JSON.stringify(index));
  indexCache.delete(patientId);
  return { chunks: chunks.length, woerter: Object.keys(df).length };
}
const indexCache = new Map();   // patientId → { mtimeMs, index }
function ladeIndex(patientId) {
  const datei = path.join(patientOrdner(patientId), 'index.json');
  let st;
  try { st = fs.statSync(datei); } catch { return null; }
  const c = indexCache.get(patientId);
  if (c && c.mtimeMs === st.mtimeMs) return c.index;
  const index = leseJson(datei, null);
  if (index) {
    index.vokabular = Object.keys(index.df);
    indexCache.set(patientId, { mtimeMs: st.mtimeMs, index });
  }
  return index;
}

// Standard-Bewerter: BM25 mit Präfix-Treffern in beide Richtungen (deutsche Komposita: „herz“ findet „herzinsuffizienz“,
// „kaliumwert“ findet „kalium“), halbe Gewichtung.
// Schnittstelle: bewerter(index, anfrage:[{wort, gewicht}]) → Map(chunkIndex → score).
// Später austauschbar, z. B. durch Embedding-Ähnlichkeit oder eine Mischung (setzeBewerter).
function bm25Bewerter(index, anfrage) {
  const k1 = 1.2, b = 0.75;
  const scores = new Map();
  const ausgedehnt = new Map();   // Indexwort → Gewicht
  for (const { wort, gewicht } of anfrage) {
    if (index.df[wort]) ausgedehnt.set(wort, Math.max(ausgedehnt.get(wort) || 0, gewicht));
    if (wort.length >= 4) {
      for (const v of index.vokabular) {
        // „herz“ → „herzinsuffizienz“ (0,5) · „kaliumwert“ → „kalium“ (0,8: Grundwort des Kompositums)
        const faktor = v.startsWith(wort) ? 0.5 : v.length >= 5 && wort.startsWith(v) ? 0.8 : 0;
        if (v !== wort && faktor) ausgedehnt.set(v, Math.max(ausgedehnt.get(v) || 0, gewicht * faktor));
      }
    }
  }
  for (const [wort, gewicht] of ausgedehnt) {
    const n = index.df[wort];
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    index.chunks.forEach((c, i) => {
      const f = c.tf[wort];
      if (!f) return;
      const s = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * c.laenge / (index.avgdl || 1)));
      scores.set(i, (scores.get(i) || 0) + gewicht * s);
    });
  }
  return scores;
}
let bewerter = bm25Bewerter;
function setzeBewerter(fn) { bewerter = typeof fn === 'function' ? fn : bm25Bewerter; }

function anfrageAus(teile) {
  // teile: [{text, gewicht}] → zusammengeführte Wortliste mit höchstem Gewicht je Wort
  const m = new Map();
  for (const { text, gewicht } of teile) for (const w of woerter(text)) m.set(w, Math.max(m.get(w) || 0, gewicht));
  return [...m].map(([wort, gewicht]) => ({ wort, gewicht }));
}

// Suche ohne KI. Liefert die besten Abschnitte (ohne tf-Daten).
// fokusDocs: Dokumente, aus denen die letzte Antwort zitiert hat – bei Folgefragen („Und was wurde da gemacht?“)
// bekommen ihre Abschnitte einen Bonus, damit das Gespräch beim selben Brief bleibt.
const MEDIKATION_FRAGE = /medikament|medikation|tablette|arznei|nehme ich|einnehm|dosis|therapie|verschrieb|verordn|medication|medicine|pill|médicament|traitement|ilaç|دواء|أدوية/i;
const MEDIKATION_ABSCHNITT = /medikation|therapie|behandlungsvorschlag|empfehl|procedere|entlass/i;
// Abschnitte eines Briefs mit passender Überschrift (höchstens 2, ohne die schon gefundenen).
function abschnitteMitTitel(patientId, docId, re, schon = [], max = 2) {
  const index = ladeIndex(patientId);
  if (!index) return [];
  const aus = [];
  for (const c of index.chunks) {
    if (aus.length >= max) break;
    if (c.docId !== docId || !re.test(c.abschnitt || '') || schon.some((t) => t.chunkId === c.chunkId)) continue;
    const { tf, laenge, ...rest } = c;
    aus.push({ ...rest, score: 0 });
  }
  return aus;
}
function suche(patientId, { frage, zusatzBegriffe = [], vorfrage = '', fokusDocs = [], k = TOP_K, maxZeichen = MAX_KONTEXT_ZEICHEN } = {}) {
  const index = ladeIndex(patientId);
  if (!index || !index.N) return [];
  const anfrage = anfrageAus([
    { text: frage, gewicht: 1 },
    // Die ersten Begriffe sind die Fachbegriffe zur Erkrankung/zum Ereignis (Laienwort → Fachwort, auch aus anderen
    // Sprachen) und zählen wie die Frage selbst; allgemeine Abschnittsbegriffe danach schwächer.
    { text: zusatzBegriffe.slice(0, 6).join(' '), gewicht: 1 },
    { text: zusatzBegriffe.slice(6).join(' '), gewicht: 0.5 },
    { text: vorfrage, gewicht: 0.3 },
  ]);
  const scores = bewerter(index, anfrage);
  if (fokusDocs.length) {
    const max = Math.max(1, ...scores.values());
    index.chunks.forEach((c, i) => { if (fokusDocs.includes(c.docId)) scores.set(i, (scores.get(i) || 0) * 1.3 + max * 0.35); });
  }
  const sortiert = [...scores].sort((a, b) => b[1] - a[1]);
  const aus = [], jeDok = {};
  let zeichen = 0;
  for (const [i, score] of sortiert) {
    const c = index.chunks[i];
    if ((jeDok[c.docId] || 0) >= (fokusDocs.includes(c.docId) ? MAX_JE_DOKUMENT + 2 : MAX_JE_DOKUMENT)) continue;
    if (zeichen + c.text.length > maxZeichen && aus.length) continue;
    // fast gleiche Abschnitte (Überlappung) nicht doppelt
    if (aus.some((a) => a.docId === c.docId && a.start < c.ende && c.start < a.ende && Math.min(a.ende, c.ende) - Math.max(a.start, c.start) > c.text.length * 0.6)) continue;
    const { tf, laenge, ...rest } = c;
    aus.push({ ...rest, score: Math.round(score * 100) / 100 });
    jeDok[c.docId] = (jeDok[c.docId] || 0) + 1;
    zeichen += c.text.length;
    if (aus.length >= k) break;
  }
  // Kaum Stichwort-Treffer (z. B. „Wann war ich zuletzt im Krankenhaus?“): mit den Anfängen der neuesten Unterlagen
  // auffüllen (Briefkopf mit Datum, Aufenthalt, Diagnosen) – so kann Claude trotzdem mit Quellen antworten.
  if (aus.length < 3) {
    const neueste = [...new Set(index.chunks.filter((c) => c.datum).sort((x, y) => y.datum.localeCompare(x.datum)).map((c) => c.docId))];
    for (const docId of neueste) {
      if (aus.length >= Math.min(k, 5)) break;
      const c = index.chunks.find((x) => x.docId === docId);
      if (!c || aus.some((a) => a.chunkId === c.chunkId) || zeichen + c.text.length > maxZeichen) continue;
      const { tf, laenge, ...rest } = c;
      aus.push({ ...rest, score: 0 });
      zeichen += c.text.length;
    }
  }
  return aus;
}

// ---------- Patienten & Dokumente ----------
function ladePatient(patientId) {
  const p = leseJson(path.join(patientOrdner(patientId), 'patient.json'), null);
  if (!p) throw ragFehler(404, 'Diesen Test-Patienten gibt es nicht.');
  return p;
}
function speicherePatient(p) {
  schreibeAtomar(path.join(patientOrdner(p.id), 'patient.json'), JSON.stringify(p, null, 2));
}
function legePatientAn({ patientId, name, geburtsjahr = null, hinweis }) {
  const ordner = patientOrdner(patientId);
  const vorhanden = leseJson(path.join(ordner, 'patient.json'), null);
  if (vorhanden) {
    if (name) vorhanden.name = String(name).slice(0, 120);
    if (geburtsjahr) vorhanden.geburtsjahr = Number(geburtsjahr) || null;
    if (hinweis) vorhanden.hinweis = hinweis;
    speicherePatient(vorhanden);
    return vorhanden;
  }
  const p = {
    id: patientId,
    name: String(name || `Testpatient ${patientId}`).slice(0, 120),
    geburtsjahr: geburtsjahr ? Number(geburtsjahr) || null : null,
    synthetisch: true,
    hinweis: hinweis || 'Nur synthetische Testdaten.',
    erstelltAm: new Date().toISOString(),
    dokumente: [],
  };
  speicherePatient(p);
  return p;
}
function listePatienten() {
  let namen = [];
  try { namen = fs.readdirSync(BASIS); } catch { return []; }
  return namen.filter((n) => ID_RE.test(n)).map((n) => {
    const p = leseJson(path.join(BASIS, n, 'patient.json'), null);
    return p && { id: p.id, name: p.name, geburtsjahr: p.geburtsjahr, dokumente: p.dokumente.length };
  }).filter(Boolean);
}
function loeschePatient(patientId) {
  const ordner = patientOrdner(patientId);
  fs.rmSync(ordner, { recursive: true, force: true });
  indexCache.delete(patientId);
}
function neueDocId(p, basis) {
  let roh = umlauteWeg(basis || 'dok').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dok';
  if (!/^[a-z0-9]/.test(roh)) roh = 'd' + roh;
  let id = roh, n = 2;
  while (p.dokumente.some((d) => d.docId === id)) id = `${roh}-${n++}`;
  return id;
}
// Ein Dokument hinzufügen (Upload, Scan-Abschrift oder Arztbrief). Index wird neu gebaut (außer ohneIndex).
function fuegeDokumentHinzu({ patientId, titel, text, typ = 'upload', quelle = null, datum, ohneIndex = false }) {
  if (!['arztbrief', 'upload', 'scan'].includes(typ)) throw ragFehler(400, 'Unbekannter Dokumenttyp.');
  const inhalt = String(text || '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!inhalt.trim()) throw ragFehler(400, 'Das Dokument ist leer.');
  const p = ladePatient(patientId);
  if (quelle && p.dokumente.some((d) => d.quelle === quelle)) return { doppelt: true, dokument: p.dokumente.find((d) => d.quelle === quelle) };
  const docId = neueDocId(p, quelle ? path.basename(quelle, path.extname(quelle)) : titel);
  const dok = {
    docId,
    titel: String(titel || erkenneTitel(inhalt)).slice(0, 160),
    datum: datum !== undefined ? datum : erkenneDatum(inhalt),
    quelle, typ, zeichen: inhalt.length,
    hinzugefuegtAm: new Date().toISOString(),
  };
  schreibeAtomar(path.join(patientOrdner(patientId), 'dokumente', `${docId}.txt`), inhalt);
  p.dokumente.push(dok);
  p.dokumente.sort((a, b) => String(a.datum || '9999').localeCompare(String(b.datum || '9999')));
  speicherePatient(p);
  if (!ohneIndex) baueIndex(patientId);
  return { doppelt: false, dokument: dok };
}
function entferneDokument(patientId, docId) {
  if (!DOC_ID_RE.test(String(docId || ''))) throw ragFehler(400, 'Ungültige Dokument-ID.');
  const p = ladePatient(patientId);
  const vorher = p.dokumente.length;
  p.dokumente = p.dokumente.filter((d) => d.docId !== docId);
  if (p.dokumente.length === vorher) throw ragFehler(404, 'Dokument nicht gefunden.');
  fs.rmSync(path.join(patientOrdner(patientId), 'dokumente', `${docId}.txt`), { force: true });
  speicherePatient(p);
  baueIndex(patientId);
}
// Volltext eines Dokuments (für „Quelle antippen“: start/ende markieren die zitierte Stelle).
function ladeDokument(patientId, docId) {
  if (!DOC_ID_RE.test(String(docId || ''))) throw ragFehler(400, 'Ungültige Dokument-ID.');
  const p = ladePatient(patientId);
  const meta = p.dokumente.find((d) => d.docId === docId);
  if (!meta) throw ragFehler(404, 'Dokument nicht gefunden.');
  const text = fs.readFileSync(path.join(patientOrdner(patientId), 'dokumente', `${docId}.txt`), 'utf8');
  return { ...meta, text };
}

// Beispielbriefe aus daten/grascco: bevorzugte Auswahl (Herz/Kreislauf, Medikation, mehrere Aufenthalte), dann alphabetisch.
// Bevorzugt die Kopie mit verschobenen Datumsangaben (alle Daten bis 2027, werkzeuge/daten-datieren.js).
const GRASCCO_ORDNER = fs.existsSync(path.join(PROJEKT, 'daten', 'grascco-2027')) ? 'grascco-2027' : 'grascco';
const GRASCCO = path.join(PROJEKT, 'daten', GRASCCO_ORDNER);
const BEVORZUGT = [
  'Gebauer', 'Xavier', 'Weber', 'Fabry', 'Amanda_Alzheimer', 'Jenninger', 'Vogler', 'Queisser', 'Osler',
  'Colon_Fake_A', 'Colon_Fake_C', 'Colon_Fake_D', 'Neubauer', 'Zezelj', 'Koenig', 'Albers', 'Theodor', 'Utz', 'Wankel', 'Jadassohn',
];
function listeBeispielbriefe() {
  let alle = [];
  try { alle = fs.readdirSync(GRASCCO).filter((f) => f.endsWith('.txt') && !f.startsWith('_')).sort(); } catch {}
  return alle;
}
// namen: ['Albers.txt', …] (nur Dateinamen) oder leer → die ersten <anzahl> der bevorzugten Auswahl. Rückgabe: relative Pfade.
function waehleBeispielbriefe({ anzahl = 15, namen } = {}) {
  const alle = listeBeispielbriefe();
  let liste;
  if (Array.isArray(namen) && namen.length) {
    liste = namen.map((n) => String(n).trim()).map((n) => (n.endsWith('.txt') ? n : n + '.txt')).filter((n) => alle.includes(n));
  } else {
    const bevorzugt = BEVORZUGT.map((n) => n + '.txt').filter((n) => alle.includes(n));
    liste = [...bevorzugt, ...alle.filter((n) => !bevorzugt.includes(n))].slice(0, Math.max(1, Math.min(alle.length, Number(anzahl) || 15)));
  }
  return liste.map((n) => `daten/${GRASCCO_ORDNER}/${n}`);
}

// Arztbriefe aus Dateien (z. B. daten/grascco) einem Test-Patienten zuordnen.
const HINWEIS_GRASCCO = 'Synthetischer Test-Patient. Die GraSCCo-Briefe (CC BY 4.0, frei erfunden) stammen eigentlich von verschiedenen fiktiven Personen und wurden nur für die Demo zu einer Krankengeschichte zusammengeführt. Namen, Daten und Altersangaben in den Briefen passen deshalb nicht zusammen.';
function importiereAusOrdner({ patientId, name, geburtsjahr, dateien }) {
  if (!Array.isArray(dateien) || !dateien.length) throw ragFehler(400, 'Keine Dateien angegeben.');
  legePatientAn({ patientId, name, geburtsjahr, hinweis: HINWEIS_GRASCCO });
  const erlaubt = path.join(PROJEKT, 'daten') + path.sep;
  const ergebnis = { neu: 0, doppelt: 0, fehler: 0 };
  for (const datei of dateien) {
    const voll = path.resolve(PROJEKT, datei);
    if (!voll.startsWith(erlaubt) || path.extname(voll) !== '.txt') { ergebnis.fehler++; continue; }   // nur Testdaten aus daten/
    let text;
    try { text = fs.readFileSync(voll, 'utf8'); } catch { ergebnis.fehler++; continue; }
    const quelle = path.relative(PROJEKT, voll).split(path.sep).join('/');
    const r = fuegeDokumentHinzu({ patientId, titel: erkenneTitel(text), text, typ: 'arztbrief', quelle, ohneIndex: true });
    ergebnis[r.doppelt ? 'doppelt' : 'neu']++;
  }
  const idx = baueIndex(patientId);
  return { ...ergebnis, ...idx, patient: ladePatient(patientId) };
}

// ---------- Claude ----------
function apiSchluessel(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw ragFehler(503, 'Der API-Schlüssel fehlt noch (ANTHROPIC_API_KEY in .env).');
  return key;
}
function kopfzeilen(key, model) {
  const h = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
  if (fallbackAn(model)) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  return h;
}
// Gesprächsweg (nicht Import/Zeitstrahl): Denken und Ersatzmodell per .env, gelesen bei jeder Anfrage.
//   GESPRAECH_DENKEN = between_tools (Standard; Sonnet 5.5: kein Vorab-Denken laut Doku) | adaptiv (adaptives Denken)
//   GESPRAECH_EFFORT = low (Standard) | medium | high
//   GESPRAECH_FALLBACK = an (Standard; Ersatzmodell bei Ablehnung) | aus
function fallbackAn(model) { return FALLBACK_MODELLE.includes(model) && String(process.env.GESPRAECH_FALLBACK || 'an').trim().toLowerCase() !== 'aus'; }
function gespraechDenken(model, body) {
  const effort = ['low', 'medium', 'high'].includes(String(process.env.GESPRAECH_EFFORT || '').trim()) ? process.env.GESPRAECH_EFFORT.trim() : 'low';
  if (!OHNE_EFFORT.includes(model)) body.output_config = { effort };
  const denken = String(process.env.GESPRAECH_DENKEN || 'between_tools').trim().toLowerCase();
  if (model === 'claude-sonnet-5-5' && denken !== 'adaptiv') body.thinking = { type: 'between_tools' };
  else if (denken === 'adaptiv' && !OHNE_EFFORT.includes(model)) body.thinking = { type: 'adaptive' };
  if (fallbackAn(model)) body.fallbacks = 'default';
  return body;
}
function meldungZuStatus(status) {
  if (status === 401 || status === 403) return 'Der API-Schlüssel wurde abgelehnt.';
  if (status === 404) return 'Das KI-Modell ist unbekannt.';
  if (status === 429 || status === 529) return 'Der KI-Dienst ist gerade ausgelastet. Bitte kurz warten.';
  if (status >= 500) return 'Der KI-Dienst ist gerade nicht erreichbar.';
  return 'Der KI-Dienst hat die Anfrage nicht angenommen.';
}

// Abfrageerweiterung: 5–12 deutsche Suchbegriffe/Fachsynonyme. Bei Fehler/Zeitüberschreitung: [].
// Bewusst als kommagetrennter Text statt JSON-Schema (gemessen ca. 0,4 s schneller, 27.11.2026).
async function erweitereAnfrage({ frage, vorfrage = '', apiKey, model, timeoutMs = ERWEITERUNG_TIMEOUT_MS }) {
  const start = Date.now();
  let key;
  try { key = apiSchluessel(apiKey); } catch { return { begriffe: [], ms: 0, ok: false }; }
  const m = model || (process.env.ANTHROPIC_MODEL_SUCHE || '').trim() || SUCH_MODELL_STANDARD;
  // Rein technische Anweisung: Suchbegriffe für eine Stichwortsuche in deutschen Arztbriefen.
  const body = {
    model: m,
    max_tokens: 200,
    system: 'Du erzeugst Suchbegriffe für eine Stichwortsuche in deutschen Arztbriefen. Die Frage kann in Alltagssprache oder in einer anderen Sprache gestellt sein. Gib 6 bis 14 kurze DEUTSCHE Begriffe aus: zuerst Fachbegriffe, Synonyme und Abkürzungen für die genannte Erkrankung, das Organ oder Ereignis (z. B. Herzinfarkt → Myokardinfarkt, NSTEMI; Leber → Leberzirrhose, hepatisch), dann typische Abschnittsüberschriften zum gefragten Thema (z. B. Medikation, Entlassmedikation, Diagnosen). Nur die Begriffe, kommagetrennt, sonst nichts.',
    messages: [{ role: 'user', content: (vorfrage ? `<vorherige_frage>${vorfrage}</vorherige_frage>\n` : '') + `<frage>${frage}</frage>` }],
  };
  if (/^claude-haiku-5/.test(m)) { body.thinking = { type: 'disabled' }; body.output_config = { effort: 'low' }; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
    const r = await fetch(API_URL, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctrl.signal });
    const daten = await r.json().catch(() => null);
    if (!r.ok) {
      console.log(`RAG: Abfrageerweiterung fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
      return { begriffe: [], ms: Date.now() - start, ok: false };
    }
    const text = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const begriffe = text.split(/[,;\n]+/).map((x) => x.replace(/^[\s\-*•\d.]+/, '').trim().slice(0, 60)).filter((x) => x && x.length > 1).slice(0, 12);
    return { begriffe, ms: Date.now() - start, ok: true };
  } catch (e) {
    console.log(`RAG: Abfrageerweiterung ohne Ergebnis (${e.name === 'AbortError' ? 'Zeitlimit' : 'Fehler'})`);
    return { begriffe: [], ms: Date.now() - start, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Verlauf [{rolle:'nutzer'|'avatar', text}] → Nachrichten (beginnt mit user, Rollen wechseln sich ab).
function verlaufZuNachrichten(verlauf) {
  const liste = [];
  for (const v of Array.isArray(verlauf) ? verlauf.slice(-20) : []) {
    if (!v || typeof v.text !== 'string' || !v.text.trim()) continue;
    const role = v.rolle === 'avatar' ? 'assistant' : 'user';
    if (!liste.length && role !== 'user') continue;
    const letzte = liste[liste.length - 1];
    if (letzte && letzte.role === role) letzte.content += '\n' + v.text;
    else liste.push({ role, content: v.text });
  }
  // Der letzte Beitrag muss vom Assistenten sein, weil gleich die neue Nutzerfrage folgt.
  if (liste.length && liste[liste.length - 1].role === 'user') liste.pop();
  return liste;
}

function datumDeutsch(iso) {
  if (!iso) return 'Datum unbekannt';
  const [j, m, t] = iso.split('-');
  return `${Number(t)}.${Number(m)}.${j}`;
}
// Rein technischer Hinweis zur Quellenarbeit (keine medizinischen Regeln; die stehen im übergebenen Systemprompt).
const QUELLEN_HINWEIS = 'Technischer Hinweis: Mit der Frage kommen Auszüge aus den gespeicherten Unterlagen der Patientin bzw. des Patienten als Dokumente mit Titel, Datum und Abschnitt. Stütze Aussagen über die Unterlagen auf diese Auszüge und zitiere sie. Die Übersicht nennt alle vorhandenen Unterlagen mit Datum. Wenn die Auszüge eine Frage nicht beantworten, sag das. Antworte wie im Gespräch: höchstens drei kurze Sätze, ohne Aufzählung. Nenne nur das Wichtigste; Einzelheiten erst, wenn die Person nachfragt. Erwähne keine Technik oder Interna (etwa Auszüge, Titel, Suche oder wie dir Unterlagen vorliegen); sag stattdessen natürlich, was du weißt und was nicht. Nenne jede Angabe nur einmal: Wiederhole ein Datum oder eine Zahl nicht in einem weiteren Satz, auch nicht in anderer Schreibweise (also nicht „5. bis 10. November“ und danach „05.11. bis 10.11.“). Stelle die Belege gleich in deine Sätze; nach einer Rückfrage am Ende schreibst du nichts mehr.';

function baueAnfrage({ patient, treffer, frage, verlauf, systemprompt, model, streaming, appWissen = '', nachCache = [] }) {
  const system = [];
  if (systemprompt && String(systemprompt).trim()) system.push({ type: 'text', text: String(systemprompt) });
  if (appWissen && String(appWissen).trim()) system.push({ type: 'text', text: String(appWissen) });   // App-Handbuch (prompt/app-wissen.md)
  // Demo-Hinweis (technisch): GraSCCo-Briefe stammen von verschiedenen fiktiven Personen, gelten hier aber als EINE Geschichte.
  const demo = patient.synthetisch
    ? ` Für diese Demo gehören alle gespeicherten Unterlagen zur Test-Person „${patient.name}“, auch wenn darin andere Namen, Geschlechter oder Geburtsdaten stehen; diese Abweichungen nicht erwähnen.`
    : '';
  system.push({ type: 'text', text: QUELLEN_HINWEIS + demo, cache_control: { type: 'ephemeral' } });
  // Was sich je Frage ändert (Gedächtnis, Sprachanweisung), kommt NACH dem Cache-Punkt.
  for (const t of Array.isArray(nachCache) ? nachCache : []) if (t && String(t).trim()) system.push({ type: 'text', text: String(t) });

  const uebersicht = 'Übersicht der gespeicherten Unterlagen (nach Datum):\n' +
    patient.dokumente.map((d) => `- ${datumDeutsch(d.datum)}: ${d.titel}`).join('\n');
  const inhalt = [{ type: 'text', text: uebersicht }];
  for (const c of treffer) {
    inhalt.push({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: c.text },
      title: `${c.titel} – ${c.abschnitt} (${datumDeutsch(c.datum)})`,
      context: `Auszug aus einem Arztbrief vom ${datumDeutsch(c.datum)}, Abschnitt ${c.abschnitt}.`,
      citations: { enabled: true },
    });
  }
  // Bisheriges Gespräch als Text in derselben Nutzernachricht statt als eigene Rollenwechsel:
  // gemessen am 27.11.2026 denkt Claude Sonnet 5.5 sonst trotz „between_tools“ ca. 3 s vor der Antwort.
  const bisher = verlaufZuNachrichten(verlauf);
  if (bisher.length) {
    const zeilen = bisher.map((m) => `${m.role === 'assistant' ? 'Du' : 'Patient/in'}: ${m.content}`).join('\n');
    inhalt.unshift({ type: 'text', text: `Bisheriges Gespräch (zur Einordnung von Folgefragen):\n${zeilen}` });
  }
  inhalt.push({ type: 'text', text: frage });
  const messages = [{ role: 'user', content: inhalt }];

  const body = { model, max_tokens: ANTWORT_MAX_TOKENS, system, messages };
  if (streaming) body.stream = true;
  return gespraechDenken(model, body);
}

// Zitate → Quellenliste. Jede zitierte Stelle (Abschnitt + Position) bekommt eine Nummer.
function quellenSammler(treffer) {
  const quellen = [];
  const schluessel = new Map();
  return {
    quellen,
    nimm(cit) {
      if (!cit || cit.type !== 'char_location') return null;
      const c = treffer[cit.document_index];
      if (!c) return null;
      const s = `${c.chunkId}:${cit.start_char_index}`;
      if (schluessel.has(s)) return schluessel.get(s);
      const nr = quellen.length + 1;
      quellen.push({
        nr, docId: c.docId, titel: c.titel, datum: c.datum, abschnitt: c.abschnitt,
        zitat: String(cit.cited_text || '').trim(), chunkId: c.chunkId,
        start: c.start + (cit.start_char_index || 0), ende: c.start + (cit.end_char_index || 0),
      });
      schluessel.set(s, nr);
      return nr;
    },
  };
}

// Ende des ersten vollständigen Satzes (wie in server.js), Abkürzungen werden übersprungen.
const ABKUERZUNGEN = /(?:^|[\s.])(?:z|b|d|h|u|a|o|s|v|ca|bzw|ggf|evtl|inkl|etc|usw|vgl|dr|prof|nr|med|mg|ml|st|str|tbl|tabl|max|min|bspw|sog|stat|li|re)\.$/i;
function satzEnde(text) {
  const re = /[.!?…]["“”»)]?(?=\s+\S)/g;
  let m;
  while ((m = re.exec(text))) {
    const ende = m.index + m[0].length;
    if (text.slice(0, ende).trim().length < 25) continue;
    if (m[0][0] === '.' && (/\d\.$/.test(text.slice(0, m.index + 1)) || ABKUERZUNGEN.test(text.slice(0, m.index + 1)))) continue;
    return ende;
  }
  return -1;
}
// Segmente so kürzen, dass der Gesamttext mit einem vollständigen Satz endet (für stop_reason max_tokens).
function kuerzeAufSatzende(segmente) {
  const gesamt = segmente.map((s) => s.text).join('');
  if (/[.!?…]["“”»)]?\s*$/.test(gesamt)) return;   // endet schon mit einem ganzen Satz
  let ende = 0, e, pos = 0;
  while ((e = satzEnde(gesamt.slice(pos))) > 0) { pos += e; ende = pos; }
  if (!ende) return;   // kein einziger fertiger Satz: lieber alles behalten
  let rest = ende;
  for (const s of segmente) {
    if (rest <= 0) { s.text = ''; s.quellen = []; continue; }
    if (s.text.length > rest) s.text = s.text.slice(0, rest);
    rest -= s.text.length;
  }
  while (segmente.length && !segmente[segmente.length - 1].text) segmente.pop();
}
function sauber(t) { return String(t).replace(/\s*\n+\s*/g, ' ').replace(/[*#`|]/g, '').replace(/\p{Extended_Pictographic}\uFE0F?/gu, '').replace(/ {2,}/g, ' ').trim(); }

async function* sseEreignisse(body) {
  const dec = new TextDecoder();
  let puffer = '';
  for await (const stueck of body) {
    puffer += dec.decode(stueck, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = puffer.indexOf('\n\n')) >= 0) {
      const roh = puffer.slice(0, i);
      puffer = puffer.slice(i + 2);
      const daten = roh.split('\n').filter((z) => z.startsWith('data:')).map((z) => z.slice(5).trimStart()).join('\n');
      if (!daten) continue;
      try { yield JSON.parse(daten); } catch {}
    }
  }
}

/**
 * Frage beantworten – mit Quellen aus den Unterlagen des Test-Patienten.
 * @param {object} o
 *   patientId, frage, verlauf ([{rolle:'nutzer'|'avatar', text}]), systemprompt (z. B. prompt/gespraech.md),
 *   model (Standard ANTHROPIC_MODEL_GESPRAECH bzw. claude-sonnet-5-5), apiKey (Standard aus .env),
 *   streaming (true → Antwort wird gestreamt), beiSatz(satz) (nur mit streaming: jeder fertige Satz sofort,
 *   ohne Quellenmarker – zum schnellen Sprechen), erweitern (Standard true: Abfrageerweiterung per Claude).
 * @returns {Promise<{text, textMitMarkern, segmente, quellen, treffer, suchbegriffe, dauerMs, zeiten, modell, stopGrund}>}
 */
async function antworteMitQuellen({ patientId, frage, verlauf = [], systemprompt = '', model, apiKey, streaming = false, beiSatz, erweitern = true, erweiterungTimeoutMs, fokusDocs = [], signal, begriffe = null, appWissen = '', nachCache = [] }) {
  const t0 = Date.now();
  frage = String(frage || '').trim().slice(0, 2000);
  if (!frage) throw ragFehler(400, 'Die Frage ist leer.');
  const patient = ladePatient(patientId);
  const key = apiSchluessel(apiKey);
  const modell = model || (process.env.ANTHROPIC_MODEL_GESPRAECH || '').trim() || ANTWORT_MODELL_STANDARD;

  // Kontext für Folgefragen: letzte Nutzerfrage und Anfang der letzten Antwort (schwach gewichtet).
  const rueck = [...(Array.isArray(verlauf) ? verlauf : [])].reverse();
  const vorfrage = rueck.find((v) => v && v.rolle !== 'avatar')?.text || '';
  const vorantwort = String(rueck.find((v) => v && v.rolle === 'avatar')?.text || '').slice(0, 600);
  // begriffe: schon vorab ermittelte Suchbegriffe (server.js startet sie während der Überbrückung) → kein Warten hier.
  const erw = Array.isArray(begriffe) ? { begriffe, ms: 0, ok: true }
    : erweitern ? await erweitereAnfrage({ frage, vorfrage, apiKey: key, timeoutMs: erweiterungTimeoutMs }) : { begriffe: [], ms: 0, ok: false };
  const t1 = Date.now();
  const fokus = Array.isArray(fokusDocs) ? fokusDocs : [];
  const suchArgs = { frage, zusatzBegriffe: erw.begriffe, vorfrage: `${vorfrage} ${vorantwort}` };
  let treffer = suche(patientId, { ...suchArgs, fokusDocs: fokus });
  // Zweite Runde: Der beste Brief bekommt Vorrang, damit auch seine übrigen Abschnitte (z. B. Medikation) mitkommen.
  if (treffer.length && treffer[0].score > 0 && !fokus.includes(treffer[0].docId)) {
    treffer = suche(patientId, { ...suchArgs, fokusDocs: [...fokus, treffer[0].docId] });
  }
  // Medikamenten-/Therapiefrage: Medikations- und Therapie-Abschnitte des besten Briefs immer mitnehmen
  // (sonst fehlt z. B. „Weitere Therapie und Behandlungsvorschlag“ und die Antwort wird unvollständig).
  if (treffer.length && treffer[0].score > 0 && MEDIKATION_FRAGE.test(`${frage} ${(erw.begriffe || []).join(' ')}`)) {
    treffer = [...treffer, ...abschnitteMitTitel(patientId, treffer[0].docId, MEDIKATION_ABSCHNITT, treffer)];
  }
  const t2 = Date.now();
  if (!treffer.length) throw ragFehler(404, 'Für diesen Test-Patienten sind noch keine Unterlagen gespeichert.');

  const body = baueAnfrage({ patient, treffer, frage, verlauf, systemprompt, model: modell, streaming, appWissen, nachCache });
  const sammler = quellenSammler(treffer);
  const segmente = [];   // [{text, quellen:[nr]}]
  let stopGrund = null, ersteTextMs = null, verbrauch = null, cacheGelesen = 0;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTWORT_TIMEOUT_MS);
  // Abbruch von außen (z. B. Browser hat unterbrochen): Claude-Strom sofort beenden.
  const abgebrochen = () => Object.assign(ragFehler(499, 'Abgebrochen.'), { abgebrochen: true });
  const beiAbbruch = () => ctrl.abort();
  if (signal) { if (signal.aborted) throw abgebrochen(); signal.addEventListener('abort', beiAbbruch, { once: true }); }
  try {
    let r;
    try {
      r = await fetch(API_URL, { method: 'POST', headers: kopfzeilen(key, modell), body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (signal?.aborted) throw abgebrochen();
      throw ragFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die KI hat zu lange gebraucht.' : 'Keine Verbindung zum KI-Dienst.');
    }
    if (!r.ok) {
      const daten = await r.json().catch(() => null);
      console.log(`RAG: KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
      throw ragFehler(502, meldungZuStatus(r.status));
    }
    if (!streaming) {
      const daten = await r.json();
      stopGrund = daten.stop_reason;
      for (const b of daten.content || []) {
        if (b.type !== 'text') continue;
        segmente.push({ text: b.text, quellen: (b.citations || []).map((c) => sammler.nimm(c)).filter(Boolean) });
      }
    } else {
      let gesprochenBis = 0;
      const gesamt = () => segmente.map((s) => s.text).join('');
      const aktuell = () => segmente[segmente.length - 1];
      try {
        for await (const ev of sseEreignisse(r.body)) {
          if (ev.type === 'message_start') {
            cacheGelesen = ev.message?.usage?.cache_read_input_tokens || 0;
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'text') {
            segmente.push({ text: ev.content_block.text || '', quellen: [] });
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'fallback') {
            // Ersatzmodell übernimmt: bisherigen Text verwerfen, sofern noch nichts gesprochen wurde.
            if (gesprochenBis === 0) { segmente.length = 0; sammler.quellen.length = 0; }
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            if (ersteTextMs === null) ersteTextMs = Date.now() - t0;
            if (!aktuell()) segmente.push({ text: '', quellen: [] });
            aktuell().text += ev.delta.text;
            if (beiSatz) {
              const t = gesamt();
              let e;
              while ((e = satzEnde(t.slice(gesprochenBis))) > 0) { beiSatz(sauber(t.slice(gesprochenBis, gesprochenBis + e))); gesprochenBis += e; }
              // Latenz (Runde 2): Den allerersten Teil schon an einem Komma/Gedankenstrich ab ERSTER_TEIL_ZEICHEN abgeben,
              // statt auf das Satzende zu warten – der Avatar beginnt früher zu sprechen.
              if (gesprochenBis === 0 && ERSTER_TEIL_ZEICHEN > 0) {
                const m = new RegExp(`^[\\s\\S]{${ERSTER_TEIL_ZEICHEN},}?(,|\\s[–—-]|:)\\s`).exec(t);
                if (m && m[0].length <= 220) { beiSatz(sauber(t.slice(0, m[0].length))); gesprochenBis = m[0].length; }
              }
            }
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'citations_delta') {
            const nr = sammler.nimm(ev.delta.citation);
            if (nr && aktuell() && !aktuell().quellen.includes(nr)) aktuell().quellen.push(nr);
          } else if (ev.type === 'message_delta' && ev.usage) {
            verbrauch = { ausgabe: ev.usage.output_tokens || 0, denken: ev.usage.output_tokens_details?.thinking_tokens || 0, cacheGelesen };
            if (ev.delta?.stop_reason) stopGrund = ev.delta.stop_reason;
          } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) {
            stopGrund = ev.delta.stop_reason;
          } else if (ev.type === 'error') {
            console.log(`RAG: Fehler im KI-Strom (${ev.error?.type || 'unbekannt'})`);
            throw ragFehler(502, 'Die KI-Antwort wurde unterbrochen. Bitte erneut versuchen.');
          }
        }
      } catch (e) {
        if (signal?.aborted) throw abgebrochen();
        if (e.meldung) throw e;
        throw ragFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die KI hat zu lange gebraucht.' : 'Die KI-Antwort wurde unterbrochen.');
      }
      // Bei abgeschnittener Antwort (max_tokens) den halben Schlusssatz nicht sprechen.
      if (beiSatz && stopGrund !== 'max_tokens') { const rest = sauber(gesamt().slice(gesprochenBis)); if (rest) beiSatz(rest); }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', beiAbbruch);
  }
  if (signal?.aborted) throw abgebrochen();
  // Abgeschnitten: Text nach dem letzten vollständigen Satz verwerfen (Anzeige = Gesprochenes).
  if (stopGrund === 'max_tokens') kuerzeAufSatzende(segmente);

  const roh = segmente.map((s) => s.text).join('');
  if (stopGrund === 'refusal' && !roh.trim()) throw ragFehler(502, 'Die KI hat diese Anfrage abgelehnt.');
  if (!roh.trim()) throw ragFehler(502, 'Die KI hat keine Antwort geliefert.');
  for (const s of segmente) s.quellen = [...new Set(s.quellen)];
  const textMitMarkern = sauber(segmente.map((s) => s.text + (s.quellen.length ? ` [${s.quellen.join(', ')}]` : '')).join(''));
  return {
    text: sauber(roh),                 // zum Vorlesen und als Untertitel (ohne Marker)
    textMitMarkern,                    // für die Anzeige, z. B. „… Ramipril [1].“
    segmente,                          // [{text, quellen:[nr]}] – zum Antippen einzelner Aussagen
    quellen: sammler.quellen,          // [{nr, docId, titel, datum, abschnitt, zitat, chunkId, start, ende}]
    treffer: treffer.map(({ text, ...rest }) => rest),   // welche Abschnitte gesucht wurden (ohne Text)
    suchbegriffe: erw.begriffe,
    modell: modell, stopGrund, verbrauch,
    dauerMs: Date.now() - t0,
    zeiten: { erweiterungMs: t1 - t0, sucheMs: t2 - t1, ersteTextMs, antwortMs: Date.now() - t2 },
  };
}

module.exports = {
  // Patienten & Dokumente
  legePatientAn, ladePatient, listePatienten, loeschePatient,
  fuegeDokumentHinzu, entferneDokument, ladeDokument, importiereAusOrdner,
  // Suche & Antwort
  baueIndex, suche, erweitereAnfrage, antworteMitQuellen,
  // Gesprächsweg: Denk-/Effort-/Ersatzmodell-Einstellung (auch für kiAntwortStream in server.js)
  gespraechDenken, fallbackAn,
  // Erweiterbarkeit & Tests
  setzeBewerter, bm25Bewerter, setzeBasis, woerter, erkenneDatum, erkenneTitel, zerlege,
  HINWEIS_GRASCCO, listeBeispielbriefe, waehleBeispielbriefe,
};
