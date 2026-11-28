# Einbauplan Gedächtnis (gedaechtnis.js) in server.js – Phase 2

Stand: 28.11.2026, gelesen gegen server.js (Zeilen ungefähr, maßgeblich sind die Funktionsnamen).
Grundsatz: Lernen läuft **immer im Hintergrund** (`.catch(() => {})`, nie `await` vor der Antwort). Keine Inhalte loggen.

## 0. Kopf
```js
const gd = require('./gedaechtnis');   // Patienten-Gedächtnis (Fakten aus Gesprächen + Unterlagen)
```
Hilfsfunktion (neben `zeitstrahlImHintergrund`):
```js
function lerneImHintergrund(patientId, nutzerText, avatarText, sprache) {
  if (!patientId || !nutzerText) return;
  gd.lerneAusGespraech({ patientId, nutzerText, avatarText: String(avatarText || '').replace(UNTERBROCHEN_MARKE, ''), sprache }).catch(() => {});
}
function dokumentLernenImHintergrund(patientId, docId) {
  gd.lerneAusDokument({ patientId, docId }).catch((e) => console.log(`Gedächtnis: Dokument nicht ausgewertet (${e.status || 'Fehler'}).`));
}
```

## 1. Claude-Weg bekommt das Gedächtnis
**`ragAntwort()`** (Unterlagen-Weg): vor `rag.antworteMitQuellen` den Block holen und an den Systemprompt hängen; Fakten zurückgeben.
```js
const gedaechtnis = gd.kontextFuerFrage({ patientId, frage: nachricht });
systemprompt: `${stand.systemprompt}${gedaechtnis.text ? '\n\n' + gedaechtnis.text : ''}\n\n${…anweisung}`,
…
const r = await rag.antworteMitQuellen(…);
return { ...r, gedaechtnisFakten: gedaechtnis.fakten };
```
**Ohne Unterlagen** (p-demo ganz am Anfang: `ragAntwort` gibt `null`, dann `kiAntwortStream(baueSystem(...))`):
in **`baueSystem(prompt, dokumente, sprache, gedaechtnisText = '')`** nach dem `cache_control`-Block (damit der Cache bleibt)
`if (gedaechtnisText) bloecke.push({ type: 'text', text: gedaechtnisText });` ergänzen.
Aufrufer in **`gespraechStrom()`** und in der Route **`POST /api/avatar/gespraech`** (V1-Zweig): `gd.kontextFuerFrage({ patientId, frage: nachricht })` holen, wenn `patientId`.

## 2. Nach jeder Antwort lernen
- **`gespraechStrom()`**: direkt nach `roh.protokoll.push({ rolle: 'nutzer', … weg: 'claude' }, …)` (normales Ende) →
  `lerneImHintergrund(patientId, nachricht, antwort, sprache);`
  Beim Abbruch-Zweig (nur wenn `gehoert.length`) ebenfalls mit `gehoert.join(' ')`.
- **Route `POST /api/avatar/gespraech`** (V1): nach `roh.protokoll.push(...)` → `lerneImHintergrund(patientId, nachricht, antwort, sprache);`
- **Route `POST /api/gespraech/nativ`** (D-ID-eigene KI): nach dem Push →
  `lerneImHintergrund(patientVon(sess.username), nachricht, antwort, roh.avatar?.sprache || profilSprache(sess.username));`
  So lernt das Gedächtnis auch aus Smalltalk („Mein Hund heißt Bello“), der nativ beantwortet wird.

## 3. Quellen-Anzeige
In beiden Antworten (`sendJson` der V1-Route und `senden('fertig', …)` in `gespraechStrom`) ergänzen:
```js
gedaechtnisQuellen: wissen?.gedaechtnisFakten ? gd.quellenAusAntwort({ fakten: wissen.gedaechtnisFakten, antwort }) : [],
```
(Im Weg ohne Unterlagen die Fakten aus Schritt 1 verwenden.) Form je Eintrag: siehe `werkzeuge/GEDAECHTNIS_UI.md`.

## 4. Weiche: Gedächtnisfragen → claude
**`waehleWeg({ nachricht, verlauf, titel, stand, patientId })`** – neuer Parameter `patientId`, direkt **vor** `wegVorfilter`:
```js
if (patientId && gd.istGedaechtnisFrage(nachricht, patientId)) return fertig('claude', 'gedaechtnis', 'vorfilter');
```
Route **`POST /api/gespraech/weg`**: `patientId` an `waehleWeg` übergeben.
Zusätzlich im Fallback `rueckfall`: auch `claude`, wenn das Gedächtnis Gesprächs-Fakten hat
(`gd.exportiere(patientId).anzahl.gespraech > 0`) – sonst würde p-demo ohne Unterlagen bei Zeitlimit nativ antworten.
**`WEG_ANWEISUNG`**: Zeile U um „…, oder bezieht sich auf etwas, das die Person früher erzählt hat (Personen, Beschwerden, Vorlieben)“ ergänzen (rein technische Weichenregel).
**`ueberbrueckung(sprache, grund)`**: `grund === 'gedaechtnis'` → neue Liste `erinnern` (siehe 7).

## 5. Neue Routen (angemeldet, Patient = `patientVon(sess.username)`, nie aus der URL)
Neben `GET /api/profil-gesundheit` (gleicher Block mit `pid`, 404 ohne Patient):
```js
if (route === 'GET /api/gedaechtnis') return sendJson(res, 200, gd.exportiere(pid));
if (route === 'DELETE /api/gedaechtnis') { console.log('Gedächtnis: gelöscht.'); return sendJson(res, 200, gd.vergiss(pid)); }
const mFakt = url.pathname.match(/^\/api\/gedaechtnis\/([a-z0-9-]{4,40})$/i);
if (mFakt && req.method === 'DELETE') return sendJson(res, 200, gd.loescheFakt(pid, mFakt[1]));
```
DELETE braucht wie alle Änderungen `X-Requested-With: akki-app` (bestehende Prüfung greift).

## 6. Unterlagen und Zurücksetzen
- **`legeUnterlageAn()`** und Upload in **`POST /api/kontext`**: nach `zeitstrahlImHintergrund(...)` → `dokumentLernenImHintergrund(patientId, r.dokument.docId);`
- **`DELETE /api/unterlagen/:docId`**: nach `pd.loeschen(pid, docId)` → `gd.vergissDokument(pid, docId);`
  (gleich beim Löschen über `/api/kontext`, falls dort `pd.loeschen`/`rag.entferneDokument` beim Patienten aufgerufen wird: `entferneAusPatient()`).
- **`POST /api/admin/demo-zuruecksetzen`**: vor `pd.zuruecksetzen(...)` → `gd.vergiss(pd.PATIENT_DEMO);`
  (pd.zuruecksetzen löscht den Ordner ohnehin; `vergiss` verwirft zusätzlich noch laufende Lernvorgänge).
- **Serverstart** (nach `pd.richteTestpatientenEin()`): p2 einmalig befüllen, falls nötig – kostet nur beim ersten Mal (15 Haiku-Aufrufe), danach Prüfsummen-Cache:
  `gd.lerneAlleDokumente('p2', { parallel: 3 }).then((r) => console.log(`Gedächtnis: p2 bereit (${r.gelernt} neu, ${r.ausCache} vorhanden).`), () => {});`
  (p2 ist schon befüllt: lokal/patienten/p2/gedaechtnis.json, 123 Fakten.)

## 7. Überbrückungssätze lockerer (keine medizinischen Inhalte)
`UEBERBRUECKUNG` je Sprache 5 Varianten pro Grund, plus neuer Grund `erinnern`. Vorschlag Deutsch:
- unterlagen: „Moment, ich schau kurz in deine Unterlagen.“ · „Sekunde, ich blätter mal in deinen Briefen.“ · „Gute Frage – ich guck kurz nach.“ · „Warte, das such ich dir raus.“ · „Einen Moment, ich schau rein.“
- nachdenken: „Hm, lass mich kurz überlegen.“ · „Gute Frage! Moment.“ · „Oh, da denk ich kurz drüber nach.“ · „Sekunde, ich sortier kurz meine Gedanken.“ · „Moment mal …“
- erinnern: „Moment, lass mich kurz überlegen, was du mir erzählt hast.“ · „Warte, das hattest du mir doch gesagt …“ · „Sekunde, ich kram kurz in meinem Gedächtnis.“ · „Hm, Moment, gleich hab ich's.“ · „Gute Frage – lass mich kurz nachdenken.“
Englisch/Französisch/Türkisch/Arabisch entsprechend locker (Entwurf im Einbau; Türkisch/Arabisch bitte vom Team gegenlesen).

## 8. Kürze im Claude-Weg (Prompt bleibt unverändert) – Vorschlag
Beobachtung im Test (gedaechtnis-test.js, Sonnet 5.5, effort low): Antworten 3–8 Sätze, 250–700 Zeichen, trotz „meist zwei bis drei Sätze“.
1. **max_tokens senken**: `GESPRAECH_MAX_TOKENS` 2048 → **450** und in `rag.js` `ANTWORT_MAX_TOKENS` 2048 → **450**
   (mit `between_tools` gibt es kein Nachdenken vor dem Text; 450 Tokens ≈ 6–8 deutsche Sätze = harte Obergrenze, nicht Zielwert).
   Per `.env` änderbar machen: `GESPRAECH_MAX_TOKENS` (Standard 450).
2. **Abgeschnittenes Ende nicht sprechen**: Bei `stop_reason === 'max_tokens'` den unvollständigen Rest nach dem letzten Satzende verwerfen
   (in `rag.antworteMitQuellen` beim abschließenden `beiSatz(rest)` und in `kiAntwortStream` beim letzten Satz) – sonst spricht Mitano. einen halben Satz.
3. **Satzbremse beim Sprechen** (optional, Server): höchstens **4 Sätze** an den Avatar schicken; weitere Sätze nur in den Untertitel/`antwort`.
   Nachteil: die angebotene Rückfrage am Ende („Soll ich dir mehr erzählen?“) könnte fehlen → deshalb nur zusammen mit 1., nicht allein.
4. **Gedächtnis-Block knapp halten** (schon so gebaut): max. 30 Gesprächs-Fakten + 8 passende Dokument-Fakten, ~1–1,6 kB; er bittet nur darum, die Herkunft zu nennen.
Empfehlung: 1 + 2 umsetzen, 3 erst nach Hörprobe entscheiden.

## 9. Prüfen nach dem Einbau
- `node --check server.js`, Dev-Server neu starten (nur Port 3210).
- curl/Chrome-headless als demo: „Mein Hausarzt heißt Dr. Sommer“ → 3 s warten → `GET /api/gedaechtnis` zeigt den Fakt → „Wie heißt mein Hausarzt?“ → `POST /api/gespraech/weg` liefert `claude/gedaechtnis`, Antwort nennt „Dr. Sommer“, `gedaechtnisQuellen` gefüllt.
- `DELETE /api/gedaechtnis/:id`, Demo zurücksetzen → Gedächtnis leer.
- D-ID: max. 8 Sitzungen (Hörprobe Überbrückung + Kürze), Credits vorher/nachher.

## Umgesetzt (28.11.2026, Phase 2)
Alle Punkte 0–7 und 8.1/8.2 eingebaut (server.js, rag.js: `signal`, `GESPRAECH_MAX_TOKENS` Standard 450, halber Schlusssatz wird verworfen).
Tests: server-test.sh 48/48, gedaechtnis-test.js 27/27, Ende-zu-Ende mit 2 D-ID-Sitzungen 19/20 (offen: Länge, s. u.).
Offen: Antworten haben noch 4–7 Sätze (~600 Zeichen) – 450 Tokens greifen dabei nicht. Treiber ist u. a. der technische Hinweis in rag.js
(`QUELLEN_HINWEIS`: „Wenn die Auszüge eine Frage nicht beantworten, sag das“) → Mitano. sagt oft „In deinen Unterlagen steht dazu nichts“.
Optionen fürs Team: 8.3 Satzbremse (4 Sätze), max_tokens 250, oder Hinweis anpassen.

## Kürze (28.11.2026, nachts)
- rag.js `QUELLEN_HINWEIS` + Stilregel „höchstens drei kurze Sätze, ohne Aufzählung …“.
- server.js Satzbremse `SATZBREMSE` (Standard 4, 0 = aus): nur im V2-Strom (`gespraechStrom`). Ab 2 überzähligen Sätzen → `roh.offenerRest`,
  Mitano. fragt „Soll ich dir mehr dazu erzählen?“ (5 Sprachen, `MEHR_ANGEBOT`). „ja/gern/erzähl mehr/yes/oui/evet/نعم …“ (`willMehr`, ≤ 6 Wörter)
  → Weiche `claude/mehr` ohne Überbrückung → `restStrom()` spricht den Rest ohne Claude-Aufruf. Rest gilt nur für die nächste Nachricht (max. 10 min).
  `fertig` hat `restOffen: true` bzw. `rest: true`; Quellen bleiben vollständig.
- max_tokens wieder 2048 (statt 450): Sonnet 5.5 denkt trotz „between_tools“ manchmal vorher – 450 Denk-Tokens → leere Antwort (gemessen).
- Messung 6 Fragen (3 Unterlagen, 2 Gedächtnis, 1 Smalltalk): vorher Ø 471 Zeichen, korrekt 5/6 → nachher gesprochen Ø 371 Zeichen (−21 %), korrekt 6/6.

## Latenz / Vorab-Denken (28.11.2026, nachts)
- Laut Skill claude-api ist bei claude-sonnet-5-5 `thinking: {type: "between_tools"}` (nur bei effort ≤ high, keine weiteren Felder) die niedrigste
  Denkstufe; `disabled` gibt 400. Das sendeten rag.js und kiAntwortStream schon – jetzt zentral in `rag.gespraechDenken()` mit .env-Schaltern
  `GESPRAECH_DENKEN` (between_tools | adaptiv), `GESPRAECH_EFFORT` (low | medium | high), `GESPRAECH_FALLBACK` (an | aus). Nur Gesprächsweg.
- Messung ohne D-ID, 6 Fragen × 2 Runden (denken-messung.js): between_tools/low Median 1,34 s bis 1. Satz, Ø 1,93 s, max 5,2 s, 12/12 inhaltlich richtig;
  adaptiv/low Median 1,58 s, Ø 1,78 s, max 3,1 s, 11/12 (einmal Schilddrüsentablette nicht gefunden); ohne Fallback-Kopf kein Vorteil.
  → Standard bleibt between_tools/low. Auch damit erzeugt Sonnet 5.5 bei breiten Fragen („erzähl mir alles …“) 200–450 Denk-Tokens (≈ 2–4 s).
