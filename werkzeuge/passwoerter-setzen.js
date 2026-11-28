'use strict';
// Setzt die Passwörter von Admin- und Demo-Nutzer neu – aus den Werten in .env.
// Nur für die Entwicklungsphase. Aufruf im Projektordner:
//   node --env-file=.env werkzeuge/passwoerter-setzen.js
// Danach den Server neu starten (alte Anmeldungen bleiben sonst bis zum Neustart gültig).
// Es wird nichts ausgegeben außer Nutzername und Rolle – nie ein Passwort.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATEI = path.join(__dirname, '..', 'lokal', 'nutzer.json');
const MIN = 4; // für die Entwicklungsphase bewusst kurz erlaubt

function hash(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

let nutzer = [];
try { nutzer = JSON.parse(fs.readFileSync(DATEI, 'utf8')); } catch { nutzer = []; }

const paare = [
  { name: process.env.ADMIN_USER, pw: process.env.ADMIN_PASSWORD, rolle: 'admin' },
  { name: process.env.DEMO_USER, pw: process.env.DEMO_PASSWORD, rolle: 'admin' }, // demo hat für die Demo Admin-Rechte
];

let geaendert = 0;
for (const { name, pw, rolle } of paare) {
  if (!name) continue;
  const n = String(name).toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,32}$/.test(n)) { console.log(`Übersprungen: Nutzername „${n}“ ist ungültig (3–32 Zeichen, a–z, 0–9, . _ -).`); continue; }
  if (!pw || pw.startsWith('hier-') || pw.length < MIN) { console.log(`Übersprungen: Passwort für ${n} fehlt oder ist kürzer als ${MIN} Zeichen.`); continue; }
  const vorhanden = nutzer.find((u) => u.username === n);
  if (vorhanden) Object.assign(vorhanden, hash(pw));
  else nutzer.push({ username: n, role: rolle, ...hash(pw) });
  geaendert++;
  console.log(`Passwort gesetzt: ${n} (${vorhanden ? vorhanden.role : rolle})`);
}

if (geaendert) {
  fs.mkdirSync(path.dirname(DATEI), { recursive: true });
  fs.writeFileSync(DATEI + '.tmp', JSON.stringify(nutzer, null, 2), { mode: 0o600 });
  fs.renameSync(DATEI + '.tmp', DATEI);
  console.log('Fertig. Bitte den Server neu starten.');
}
