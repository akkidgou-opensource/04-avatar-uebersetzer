'use strict';
// Avatar-Übersetzer – Server (Prototyp, nur Testdaten).
// Nur Node-Bordmittel, keine zusätzlichen Pakete.
// Es werden keine Texte, Bilder oder Tonaufnahmen gespeichert oder geloggt.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT) || 3000;
// Standard: nur dieser Rechner. Fürs Handy im WLAN in .env HOST=0.0.0.0 setzen.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'lokal', 'nutzer.json');

const IDLE_MS = 15 * 60 * 1000;        // Abmeldung nach 15 Min. Inaktivität
const MAX_MS = 8 * 60 * 60 * 1000;     // spätestens nach 8 Stunden
const MAX_BODY = 20 * 1024;            // 20 KB reichen für Anmeldung und Nutzerverwaltung
const MIN_PW = 10;

// ---------- KI-Anbindung (Übersetzen) ----------
const PROMPT_FILE = path.join(__dirname, 'prompt', 'system.md');
const PROMPT_MARKE = '<!-- PLATZHALTER';     // solange das in system.md steht, ist der Prompt nicht fertig
const MAX_BODY_UEBERSETZEN = 64 * 1024;      // 64 KB nur für /api/uebersetzen
const MAX_TEXT = 15000;                      // höchstens 15.000 Zeichen Originaltext
const KI_TIMEOUT_MS = 60 * 1000;             // nach 60 Sekunden abbrechen
const ANBIETER = 'Anthropic (Cloud, USA – nicht DSGVO-konform)';
const MODI = ['einfach'];                    // "zielsprache" folgt, wenn die Sprache feststeht
// Modelle, die den serverseitigen Ersatz bei Ablehnung ("fallbacks") kennen
const FALLBACK_MODELLE = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
// Nur die technische Form der Antwort – keine inhaltlichen Regeln (die stehen in prompt/system.md).
const ANTWORT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    nicht_uebersetzbare_stellen: { type: 'array', items: { type: 'string' } },
    hinweise: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'nicht_uebersetzbare_stellen', 'hinweise'],
  additionalProperties: false,
};

// ---------- D-ID Avatar (Echtzeit-Video über WebRTC) ----------
// Der Server macht alle Aufrufe an D-ID, der Browser baut nur die Videoverbindung auf.
// Der Avatar-Agent hat KEINE eigene KI: er spricht genau den Text, den wir schicken.
const DID_URL = 'https://api.d-id.com';
const DID_AGENT_FILE = path.join(__dirname, 'lokal', 'did-agent.json');     // alter Einzel-Avatar (Emma)
const DID_AGENTS_FILE = path.join(__dirname, 'lokal', 'did-agents.json');   // { avatarId: agentId }
const DID_BILD_BASIS = 'https://create-images-results.d-id.com/DefaultPresenters/';
// Auswahl der Avatare: id = unsere eigene Kennung (nicht die D-ID-ID). Bilder per HEAD geprüft (200).
const AVATARE = [
  { id: 'emma', name: 'Emma', bild: DID_BILD_BASIS + 'Emma_f/v1_image.jpeg', stimme: 'de-DE-KatjaNeural',
    beschreibung: 'Ruhig und freundlich, spricht klar und deutlich.' },
  { id: 'noelle', name: 'Noelle', bild: DID_BILD_BASIS + 'Noelle_f/v1_image.jpeg', stimme: 'de-DE-AmalaNeural',
    beschreibung: 'Herzlich und geduldig, mit warmer Stimme.' },
  { id: 'william', name: 'William', bild: DID_BILD_BASIS + 'William_m/v1_image.jpeg', stimme: 'de-DE-ConradNeural',
    beschreibung: 'Gelassen und zugewandt, mit ruhiger Stimme.' },
  { id: 'eric', name: 'Eric', bild: DID_BILD_BASIS + 'Eric_m/v1_image.jpeg', stimme: 'de-DE-KillianNeural',
    beschreibung: 'Sachlich und freundlich, erklärt Schritt für Schritt.' },
];
const AVATAR_STANDARD = 'emma';
const DID_BILD = AVATARE[0].bild;
const DID_STIMME = AVATARE[0].stimme;
const DID_ANBIETER = 'D-ID (Israel/USA, Server in den USA – nicht DSGVO-konform)';
const DID_TIMEOUT_MS = 30 * 1000;
const MAX_BODY_AVATAR = 32 * 1024;   // reicht für die Verbindungsdaten (SDP)
const MAX_SPRECHTEXT = 5000;

// ---------- Gespräch mit dem Avatar ----------
const GESPRAECH_PROMPT_FILE = path.join(__dirname, 'prompt', 'gespraech.md');
const MAX_NACHRICHT = 1000;
const MAX_VERLAUF = 12;

// ---------- Nutzerspeicher (Datei, nur Passwort-Hashes) ----------
let users = [];

function loadUsers() {
  try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
}
function saveUsers() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}
async function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(pw, salt, 64);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}
async function checkPassword(user, pw) {
  // Auch bei unbekanntem Nutzer rechnen, damit die Antwortzeit nichts verrät.
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16);
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64);
  const actual = await scrypt(pw, salt, 64);
  return crypto.timingSafeEqual(actual, expected) && !!user;
}
const validName = (n) => typeof n === 'string' && /^[a-z0-9._-]{3,32}$/.test(n);
const validRole = (r) => r === 'admin' || r === 'arzt';

async function seedAdmin() {
  loadUsers();
  if (users.length) return;
  const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
  if (!validName(ADMIN_USER) || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < MIN_PW) {
    console.log('Hinweis: Noch kein Nutzer vorhanden. Trage ADMIN_USER und ADMIN_PASSWORD (mind. 10 Zeichen) in .env ein und starte neu.');
    return;
  }
  users.push({ username: ADMIN_USER, role: 'admin', ...(await hashPassword(ADMIN_PASSWORD)) });
  saveUsers();
  console.log('Erster Administrator wurde angelegt.');
}

// ---------- Sitzungen (nur im Arbeitsspeicher) ----------
const sessions = new Map();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function getSession(req) {
  const token = parseCookies(req).sid;
  const s = token && sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > IDLE_MS || now - s.created > MAX_MS) { stoppeAvatar(s); sessions.delete(token); return null; }
  s.last = now;
  return { token, ...s };
}
function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, { username: user.username, role: user.role, created: now, last: now, consent: true });
  setCookie(res, token, MAX_MS / 1000);
}
function setCookie(res, value, maxAge) {
  // Lax statt Strict: Safari/iOS verliert Strict-Cookies, wenn die Seite von außen geöffnet wird.
  // Schutz vor fremden Seiten bleibt: Änderungen brauchen zusätzlich X-Requested-With + JSON.
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.last > IDLE_MS || now - s.created > MAX_MS) { stoppeAvatar(s); sessions.delete(t); }
}, 60 * 1000).unref();

// ---------- Bremse gegen Raten von Passwörtern und Überlastung ----------
const fails = new Map();   // "ip|nutzer" -> { count, until }
const hits = new Map();    // ip -> { count, reset }
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

function tooManyRequests(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now > h.reset) { h = { count: 0, reset: now + 60 * 1000 }; hits.set(ip, h); }
  return ++h.count > 120;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (now > h.reset) hits.delete(k);
  for (const [k, f] of fails) if (f.until && now > f.until) fails.delete(k);
}, 5 * 60 * 1000).unref();

// ---------- Hilfsfunktionen ----------
function securityHeaders(res, nonce) {
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; ` +
    `img-src 'self' data: https://create-images-results.d-id.com; media-src 'self' https://agents-results.d-id.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req, maxBody = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const zuGross = () => Object.assign(new Error('zu gross'), { status: 413, meldung: 'Die Anfrage ist zu groß.' });
    // Angekündigte Größe zuerst prüfen, dann gar nicht erst lesen.
    if (Number(req.headers['content-length']) > maxBody) { req.pause(); return reject(zuGross()); }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) { req.removeAllListeners('data'); req.pause(); reject(zuGross()); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('kein JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------- KI: System-Prompt und Anthropic-Aufruf ----------
// Fehler mit kurzer deutscher Meldung für die Oberfläche.
const kiFehler = (status, meldung) => Object.assign(new Error('ki'), { status, meldung });

function ladeSystemPrompt() {
  // Bei jeder Anfrage frisch lesen, damit Änderungen ohne Neustart wirken.
  let inhalt = '';
  try { inhalt = fs.readFileSync(PROMPT_FILE, 'utf8'); } catch { inhalt = ''; }
  if (!inhalt.trim() || inhalt.includes(PROMPT_MARKE)) {
    throw kiFehler(503, 'Der System-Prompt fehlt noch. Bitte die Regeln aus spec.md wortgetreu in prompt/system.md einfügen und die Platzhalter-Zeile löschen.');
  }
  return inhalt;
}

function kiZugang() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  const model = process.env.ANTHROPIC_MODEL || '';
  if (!key || key.startsWith('hier-')) throw kiFehler(503, 'Der API-Schlüssel fehlt noch. Bitte ANTHROPIC_API_KEY in .env eintragen und den Server neu starten.');
  if (!model || model.startsWith('hier-')) throw kiFehler(503, 'Das KI-Modell fehlt noch. Bitte ANTHROPIC_MODEL in .env eintragen und den Server neu starten.');
  return { key, model };
}

function meldungZuStatus(status) {
  if (status === 401 || status === 403) return 'Der API-Schlüssel wurde abgelehnt. Bitte ANTHROPIC_API_KEY in .env prüfen.';
  if (status === 404) return 'Das KI-Modell ist unbekannt. Bitte ANTHROPIC_MODEL in .env prüfen.';
  if (status === 413) return 'Der Text ist für den KI-Dienst zu lang.';
  if (status === 429) return 'Der KI-Dienst ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.';
  if (status >= 500) return 'Der KI-Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.';
  return 'Der KI-Dienst hat die Anfrage nicht angenommen.';
}

const nurTexte = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []);

async function frageKi(systemPrompt, modus, text) {
  const { key, model } = kiZugang();
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2026-10-21',
  };
  const body = {
    model,
    max_tokens: 16000,
    system: systemPrompt,
    // Nur technische Trennung von Modus und Text – die Regeln stehen in prompt/system.md.
    messages: [{ role: 'user', content: `<modus>${modus}</modus>\n<text>\n${text}\n</text>` }],
    output_config: { format: { type: 'json_schema', schema: ANTWORT_SCHEMA } },
  };
  // Lehnt das Modell ab, springt serverseitig ein passendes Ersatzmodell ein (nur wo unterstützt).
  if (FALLBACK_MODELLE.includes(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KI_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    daten = await r.json().catch(() => null);
  } catch (e) {
    if (e.name === 'AbortError') throw kiFehler(504, 'Die KI hat zu lange gebraucht. Bitte einen kürzeren Text versuchen.');
    throw kiFehler(502, 'Keine Verbindung zum KI-Dienst.');
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    // Nur Status und Fehlerart loggen – nie Schlüssel, Text oder Antwortinhalt.
    console.log(`KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw kiFehler(502, meldungZuStatus(r.status));
  }
  if (daten?.stop_reason === 'refusal') throw kiFehler(502, 'Die KI hat diese Anfrage abgelehnt.');
  if (daten?.stop_reason === 'max_tokens') throw kiFehler(502, 'Die Antwort der KI war zu lang und wurde abgeschnitten. Bitte einen kürzeren Text versuchen.');

  const block = (daten?.content || []).find((b) => b.type === 'text');
  let ergebnis;
  try { ergebnis = JSON.parse(block?.text || ''); } catch { ergebnis = null; }
  if (!ergebnis || typeof ergebnis.text !== 'string') throw kiFehler(502, 'Die Antwort der KI war unvollständig. Bitte erneut versuchen.');

  return {
    text: ergebnis.text,
    nicht_uebersetzbare_stellen: nurTexte(ergebnis.nicht_uebersetzbare_stellen),
    hinweise: nurTexte(ergebnis.hinweise),
  };
}

// ---------- Gespräch: Antwort erzeugen ----------
// Ist kein Gesprächs-Prompt oder kein Schlüssel da, läuft ein Echo-Test (keine KI, keine erfundenen Inhalte).
function gespraechBereit() {
  let prompt = '';
  try { prompt = fs.readFileSync(GESPRAECH_PROMPT_FILE, 'utf8'); } catch {}
  const key = process.env.ANTHROPIC_API_KEY || '';
  const model = process.env.ANTHROPIC_MODEL || '';
  if (!key || key.startsWith('hier-') || !model || model.startsWith('hier-')) {
    return { echo: true, grund: 'Echo-Test: Es fehlt noch ANTHROPIC_API_KEY bzw. ANTHROPIC_MODEL in .env.' };
  }
  if (!prompt.trim() || prompt.includes(PROMPT_MARKE)) {
    return { echo: true, grund: 'Echo-Test: Die Gesprächsregeln in prompt/gespraech.md fehlen noch.' };
  }
  return { echo: false, prompt };
}

// Verlauf in das Format der Anthropic-API bringen: beginnt mit "user", Rollen wechseln sich ab.
function baueNachrichten(verlauf, nachricht) {
  const liste = [];
  for (const v of [...verlauf, { rolle: 'nutzer', text: nachricht }]) {
    const role = v.rolle === 'avatar' ? 'assistant' : 'user';
    if (!liste.length && role !== 'user') continue;
    const letzte = liste[liste.length - 1];
    if (letzte && letzte.role === role) letzte.content += '\n' + v.text;
    else liste.push({ role, content: v.text });
  }
  return liste;
}

async function kiAntwort(systemPrompt, messages) {
  const { key, model } = kiZugang();
  const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  const body = { model, max_tokens: 800, system: systemPrompt, messages };
  if (FALLBACK_MODELLE.includes(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KI_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    daten = await r.json().catch(() => null);
  } catch (e) {
    throw kiFehler(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'Die KI hat zu lange gebraucht.' : 'Keine Verbindung zum KI-Dienst.');
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    console.log(`Gespräch: KI-Anfrage fehlgeschlagen (Status ${r.status}${daten?.error?.type ? ', ' + daten.error.type : ''})`);
    throw kiFehler(502, meldungZuStatus(r.status));
  }
  if (daten?.stop_reason === 'refusal') throw kiFehler(502, 'Die KI hat diese Anfrage abgelehnt.');
  const text = (daten?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw kiFehler(502, 'Die KI hat keine Antwort geliefert.');
  return text;
}

// ---------- D-ID: Aufrufe ----------
function didMeldung(status, art) {
  if (status === 401) return 'Der D-ID-Schlüssel wurde abgelehnt. Bitte DID_API_KEY in .env prüfen.';
  if (status === 402 || art === 'InsufficientCreditsError') return 'Das D-ID-Guthaben ist aufgebraucht.';
  if (status === 403 && art === 'ConcurrencyLimitError') return 'Zu viele Avatar-Verbindungen gleichzeitig. Bitte andere Avatar-Fenster schließen und kurz warten.';
  if (status === 403) return 'D-ID erlaubt diese Funktion für das Konto nicht.';
  if (status === 404) return 'Die Avatar-Verbindung ist abgelaufen. Bitte neu verbinden.';
  if (status === 429) return 'D-ID ist gerade ausgelastet. Bitte kurz warten.';
  if (status >= 500) return 'D-ID ist gerade nicht erreichbar. Bitte später erneut versuchen.';
  return 'D-ID hat die Anfrage nicht angenommen.';
}

async function did(methode, pfad, body) {
  const key = process.env.DID_API_KEY || '';
  if (!key || key.startsWith('hier-')) throw kiFehler(503, 'Der D-ID-Schlüssel fehlt noch. Bitte DID_API_KEY in .env eintragen und den Server neu starten.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DID_TIMEOUT_MS);
  let r, daten;
  try {
    r = await fetch(DID_URL + pfad, {
      method: methode,
      // Laut D-ID-Doku wird der Schlüssel unverändert als "Basic <key>" gesendet.
      headers: { Authorization: 'Basic ' + key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    daten = await r.json().catch(() => ({}));
  } catch (e) {
    throw kiFehler(e.name === 'AbortError' ? 504 : 502, 'Keine Verbindung zu D-ID.');
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // Nur Status und Fehlerart loggen – nie Schlüssel oder Text.
    console.log(`D-ID-Anfrage fehlgeschlagen (${methode} Status ${r.status}${daten?.kind ? ', ' + daten.kind : ''})`);
    throw kiFehler(502, didMeldung(r.status, daten?.kind));
  }
  return daten;
}

// Pro Avatar einmalig einen Agent ohne KI anlegen und merken (lokal/did-agents.json, in .gitignore).
function ladeAgentIds() {
  let ids = {};
  try { ids = JSON.parse(fs.readFileSync(DID_AGENTS_FILE, 'utf8')) || {}; } catch {}
  // Den früher angelegten Einzel-Avatar (Emma) weiterverwenden.
  if (!ids.emma) {
    try { const alt = JSON.parse(fs.readFileSync(DID_AGENT_FILE, 'utf8')).id; if (alt) ids.emma = alt; } catch {}
  }
  return ids;
}
function speichereAgentId(avatarId, agentId) {
  const ids = ladeAgentIds();
  ids[avatarId] = agentId;
  fs.mkdirSync(path.dirname(DID_AGENTS_FILE), { recursive: true });
  fs.writeFileSync(DID_AGENTS_FILE, JSON.stringify(ids, null, 2), { mode: 0o600 });
}

const agentWirdAngelegt = new Map();   // avatarId -> Promise (verhindert doppelte Anlage)
async function didAgent(avatar) {
  if (avatar.id === AVATAR_STANDARD && process.env.DID_AGENT_ID) return process.env.DID_AGENT_ID;
  const vorhanden = ladeAgentIds()[avatar.id];
  if (vorhanden) return vorhanden;
  if (!agentWirdAngelegt.has(avatar.id)) {
    agentWirdAngelegt.set(avatar.id, (async () => {
      const a = await did('POST', '/agents', {
        preview_name: `AKKI Avatar-Uebersetzer – ${avatar.name} (ohne KI)`,
        presenter: {
          type: 'talk', source_url: avatar.bild, thumbnail: avatar.bild,
          voice: { type: 'microsoft', voice_id: avatar.stimme },
        },
      });
      for (let i = 0; i < 30 && a.status !== 'done'; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const st = await did('GET', `/agents/${encodeURIComponent(a.id)}`);
        if (st.status === 'done') break;
        if (st.status === 'error') throw kiFehler(502, 'D-ID konnte den Avatar nicht anlegen.');
      }
      speichereAgentId(avatar.id, a.id);
      console.log(`D-ID-Avatar „${avatar.name}“ wurde einmalig angelegt.`);
      return a.id;
    })().finally(() => { agentWirdAngelegt.delete(avatar.id); }));
  }
  return agentWirdAngelegt.get(avatar.id);
}

// Leerlauf-Video des Agents (falls D-ID eins erzeugt hat). Nur merken, wenn vorhanden.
const leerlaufCache = new Map();   // agentId -> URL
async function didLeerlauf(agentId) {
  if (leerlaufCache.has(agentId)) return leerlaufCache.get(agentId);
  try {
    const a = await did('GET', `/agents/${encodeURIComponent(agentId)}`);
    const url = a && a.presenter && a.presenter.idle_video;
    if (typeof url === 'string' && url.startsWith('https://agents-results.d-id.com/')) {
      leerlaufCache.set(agentId, url);
      return url;
    }
  } catch {}
  return null;
}

function stoppeAvatar(s) {
  const av = s && s.avatar;
  if (!av) return;
  s.avatar = null;
  did('DELETE', `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}`,
    { session_id: av.sessionId }).catch(() => {});
}

async function avatarSprichText(roh, text) {
  const av = roh.avatar;
  const r = await did('POST', `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}`, {
    session_id: av.sessionId,
    script: { type: 'text', input: text, provider: { type: 'microsoft', voice_id: av.stimme || DID_STIMME } },
  });
  return r.duration || null;
}

async function avatarRoute(route, req, res, roh) {
  const basis = () => {
    const av = roh.avatar;
    if (!av) throw kiFehler(409, 'Der Avatar ist nicht verbunden. Bitte zuerst „Avatar verbinden“ drücken.');
    return { av, pfad: `/agents/${encodeURIComponent(av.agentId)}/streams/${encodeURIComponent(av.streamId)}` };
  };

  if (route === 'POST /api/avatar/start') {
    const b = (await readJson(req, MAX_BODY_AVATAR)) || {};
    const wunsch = b.avatarId === undefined || b.avatarId === null || b.avatarId === '' ? AVATAR_STANDARD : b.avatarId;
    const avatar = AVATARE.find((a) => a.id === wunsch);
    if (!avatar) return sendJson(res, 400, { fehler: 'Diesen Avatar gibt es nicht. Bitte einen Avatar aus der Liste wählen.' });
    stoppeAvatar(roh);
    const agentId = await didAgent(avatar);
    const s = await did('POST', `/agents/${encodeURIComponent(agentId)}/streams`, { stream_warmup: true, compatibility_mode: 'auto' });
    const offer = s.offer || s.jsep;
    if (!s.id || !offer) throw kiFehler(502, 'D-ID hat keine Verbindungsdaten geliefert.');
    roh.avatar = { agentId, streamId: s.id, sessionId: s.session_id, stimme: avatar.stimme, avatarId: avatar.id };
    const antwort = {
      offer, ice_servers: s.ice_servers || [], bild: avatar.bild, anbieter: DID_ANBIETER,
      avatar: { id: avatar.id, name: avatar.name, bild: avatar.bild },
    };
    const leerlauf = await didLeerlauf(agentId);
    if (leerlauf) antwort.leerlaufVideo = leerlauf;
    return sendJson(res, 200, antwort);
  }
  if (route === 'POST /api/avatar/sdp') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const a = b.answer;
    if (!a || a.type !== 'answer' || typeof a.sdp !== 'string') return sendJson(res, 400, { fehler: 'Ungültige Verbindungsdaten.' });
    const { av, pfad } = basis();
    await did('POST', pfad + '/sdp', { answer: { type: 'answer', sdp: a.sdp }, session_id: av.sessionId });
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/avatar/ice') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const { av, pfad } = basis();
    const daten = { session_id: av.sessionId };
    if (typeof b.candidate === 'string' && b.candidate) {
      daten.candidate = b.candidate;
      daten.sdpMid = typeof b.sdpMid === 'string' ? b.sdpMid : '0';
      daten.sdpMLineIndex = Number.isInteger(b.sdpMLineIndex) ? b.sdpMLineIndex : 0;
    }
    await did('POST', pfad + '/ice', daten);
    return sendJson(res, 200, { ok: true });
  }
  if (route === 'POST /api/avatar/sprechen') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length < 3) return sendJson(res, 400, { fehler: 'Bitte mindestens 3 Zeichen eingeben.' });
    if (text.length > MAX_SPRECHTEXT) return sendJson(res, 400, { fehler: `Der Text ist zu lang (höchstens ${MAX_SPRECHTEXT.toLocaleString('de-DE')} Zeichen).` });
    basis();
    const dauer = await avatarSprichText(roh, text);
    return sendJson(res, 200, { ok: true, dauer });
  }
  if (route === 'POST /api/avatar/gespraech') {
    const b = await readJson(req, MAX_BODY_AVATAR);
    const nachricht = typeof b.nachricht === 'string' ? b.nachricht.trim() : '';
    if (!nachricht) return sendJson(res, 400, { fehler: 'Es wurde nichts verstanden. Bitte noch einmal sprechen.' });
    if (nachricht.length > MAX_NACHRICHT) return sendJson(res, 400, { fehler: `Die Nachricht ist zu lang (höchstens ${MAX_NACHRICHT} Zeichen).` });
    const verlauf = (Array.isArray(b.verlauf) ? b.verlauf : [])
      .filter((v) => v && (v.rolle === 'nutzer' || v.rolle === 'avatar') && typeof v.text === 'string' && v.text.trim())
      .slice(-MAX_VERLAUF)
      .map((v) => ({ rolle: v.rolle, text: v.text.slice(0, 2000) }));

    const stand = gespraechBereit();
    const antwort = stand.echo
      ? `Ich habe verstanden: ${nachricht}`
      : await kiAntwort(stand.prompt, baueNachrichten(verlauf, nachricht));

    let gesprochen = false;
    if (roh.avatar) {
      await avatarSprichText(roh, antwort.slice(0, MAX_SPRECHTEXT));
      gesprochen = true;
    }
    return sendJson(res, 200, {
      antwort, gesprochen, modus: stand.echo ? 'echo' : 'ki',
      hinweis: stand.echo ? stand.grund : null,
      anbieter: stand.echo ? null : ANBIETER,
    });
  }
  if (route === 'POST /api/avatar/stop') {
    stoppeAvatar(roh);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unbekannt';
  if (tooManyRequests(ip)) return sendJson(res, 429, { fehler: 'Zu viele Anfragen. Bitte kurz warten.' });

  const changing = req.method !== 'GET' && req.method !== 'HEAD';
  // Schutz gegen fremde Webseiten: Änderungen nur mit eigenem Kopfzeilenfeld und JSON.
  if (changing && (req.headers['x-requested-with'] !== 'akki-app' ||
      !String(req.headers['content-type'] || '').startsWith('application/json'))) {
    return sendJson(res, 403, { fehler: 'Anfrage nicht erlaubt.' });
  }

  const route = `${req.method} ${url.pathname}`;
  const sess = getSession(req);

  if (route === 'POST /api/login') {
    const b = await readJson(req);
    const username = String(b.username || '').toLowerCase().trim();
    const password = String(b.password || '');
    if (b.consent !== true) return sendJson(res, 400, { fehler: 'Bitte zuerst den Datenschutz-Hinweis bestätigen.' });

    const key = `${ip}|${username}`;
    const f = fails.get(key);
    if (f && f.until && Date.now() < f.until) {
      return sendJson(res, 429, { fehler: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
    }
    const user = users.find((u) => u.username === username);
    if (password.length <= 200 && await checkPassword(user, password)) {
      fails.delete(key);
      startSession(res, user);
      return sendJson(res, 200, { username: user.username, role: user.role });
    }
    const n = (f ? f.count : 0) + 1;
    fails.set(key, { count: n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return sendJson(res, 401, { fehler: 'Anmeldung nicht möglich. Bitte Eingaben prüfen.' });
  }

  if (route === 'GET /api/me') {
    return sess ? sendJson(res, 200, { username: sess.username, role: sess.role })
                : sendJson(res, 401, { fehler: 'Nicht angemeldet.' });
  }

  if (!sess) return sendJson(res, 401, { fehler: 'Nicht angemeldet.' });

  if (route === 'POST /api/logout') {
    stoppeAvatar(sessions.get(sess.token));
    sessions.delete(sess.token); setCookie(res, '', 0);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'GET /api/avatare') {
    return sendJson(res, 200, {
      avatare: AVATARE.map(({ id, name, bild, beschreibung, stimme }) => ({ id, name, bild, beschreibung, stimme })),
      standard: AVATAR_STANDARD,
    });
  }

  if (url.pathname.startsWith('/api/avatar/')) {
    try {
      return await avatarRoute(route, req, res, sessions.get(sess.token));
    } catch (e) {
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      console.log('Avatar: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Interner Fehler beim Avatar.' });
    }
  }

  if (route === 'POST /api/uebersetzen') {
    const b = (await readJson(req, MAX_BODY_UEBERSETZEN)) || {};
    if (b.modus === 'zielsprache') return sendJson(res, 400, { fehler: 'Die Zielsprache ist noch nicht festgelegt. Bitte „Einfache Sprache“ wählen.' });
    if (!MODI.includes(b.modus)) return sendJson(res, 400, { fehler: 'Unbekannter Modus.' });
    if (typeof b.text !== 'string' || !b.text.trim()) return sendJson(res, 400, { fehler: 'Bitte zuerst einen Text einfügen.' });
    if (b.text.length > MAX_TEXT) return sendJson(res, 400, { fehler: `Der Text ist zu lang (höchstens ${MAX_TEXT.toLocaleString('de-DE')} Zeichen).` });
    try {
      const systemPrompt = ladeSystemPrompt();
      const ergebnis = await frageKi(systemPrompt, b.modus, b.text);
      return sendJson(res, 200, { ...ergebnis, anbieter: ANBIETER });
    } catch (e) {
      if (e.meldung) return sendJson(res, e.status, { fehler: e.meldung });
      console.log('KI-Anfrage: unerwarteter Fehler.');   // bewusst ohne Details
      return sendJson(res, 500, { fehler: 'Interner Fehler beim Übersetzen.' });
    }
  }

  // Ab hier nur Administratoren
  if (url.pathname.startsWith('/api/nutzer')) {
    if (sess.role !== 'admin') return sendJson(res, 403, { fehler: 'Nur für Administratoren.' });

    if (route === 'GET /api/nutzer') {
      return sendJson(res, 200, users.map((u) => ({ username: u.username, role: u.role })));
    }
    if (route === 'POST /api/nutzer') {
      const b = await readJson(req);
      const username = String(b.username || '').toLowerCase().trim();
      if (!validName(username)) return sendJson(res, 400, { fehler: 'Name: 3 bis 32 Zeichen (a–z, 0–9, Punkt, Strich).' });
      if (!validRole(b.role)) return sendJson(res, 400, { fehler: 'Unbekannte Rolle.' });
      if (typeof b.password !== 'string' || b.password.length < MIN_PW || b.password.length > 200) {
        return sendJson(res, 400, { fehler: `Passwort: mindestens ${MIN_PW} Zeichen.` });
      }
      if (users.some((u) => u.username === username)) return sendJson(res, 409, { fehler: 'Name ist schon vergeben.' });
      users.push({ username, role: b.role, ...(await hashPassword(b.password)) });
      saveUsers();
      return sendJson(res, 201, { username, role: b.role });
    }
    if (req.method === 'DELETE') {
      const name = decodeURIComponent(url.pathname.slice('/api/nutzer/'.length));
      const target = users.find((u) => u.username === name);
      if (!target) return sendJson(res, 404, { fehler: 'Nutzer nicht gefunden.' });
      if (name === sess.username) return sendJson(res, 400, { fehler: 'Das eigene Konto kann nicht gelöscht werden.' });
      users = users.filter((u) => u.username !== name);
      saveUsers();
      for (const [t, s] of sessions) if (s.username === name) sessions.delete(t);
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { fehler: 'Nicht gefunden.' });
}

// ---------- Statische Dateien ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    if (file.endsWith('index.html')) data = Buffer.from(data.toString('utf8').replaceAll('__NONCE__', res.nonce));
    res.writeHead(200, { 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- Start ----------
const server = http.createServer(async (req, res) => {
  res.nonce = crypto.randomBytes(16).toString('base64');
  securityHeaders(res, res.nonce);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    // Bewusst keine Inhalte der Anfrage loggen.
    if (e.status === 413) res.setHeader('Connection', 'close');   // Rest der zu großen Anfrage nicht mehr lesen
    if (!res.headersSent) sendJson(res, e.status || 500, { fehler: e.meldung || (e.status ? 'Ungültige Anfrage.' : 'Interner Fehler.') });
  }
});

seedAdmin().then(() => {
  server.listen(PORT, HOST, () => console.log(`Läuft auf http://${HOST}:${PORT}`));
});
