# Wissensspeicher (rag.js) – Einbindung in server.js und Oberfläche

Nur synthetische Test-Patienten. Daten liegen in `lokal/patienten/<id>/` (in `.gitignore`, Dateien 0600).
Kein Embedding-Anbieter: Suche per BM25 (Stichwortsuche), Claude schlägt vorher Suchbegriffe vor.

## Ausprobieren
```
node werkzeuge/patient-import.js --id p2 --name "Testpatient Max Mustermann" --anzahl 15 --neu
node --env-file=.env werkzeuge/rag-test.js            # 5 Fragen, ca. 10 API-Aufrufe
node werkzeuge/rag-test.js --ohne-ki --ohne-aufbau    # nur Suche, ohne Claude
```

## Funktionen (`const rag = require('./rag');`)
| Funktion | Zweck |
|---|---|
| `listePatienten()` | `[{id, name, geburtsjahr, dokumente}]` |
| `legePatientAn({patientId, name, geburtsjahr?})` | anlegen bzw. Name ändern |
| `ladePatient(id)` | `patient.json` (siehe unten) |
| `loeschePatient(id)` | Ordner komplett löschen |
| `importiereAusOrdner({patientId, name, geburtsjahr?, dateien:['daten/grascco/X.txt', …]})` | nur Dateien unter `daten/`; doppelte werden übersprungen. Rückgabe `{neu, doppelt, fehler, chunks, woerter, patient}` |
| `fuegeDokumentHinzu({patientId, titel?, text, typ:'upload'\|'scan'\|'arztbrief'})` | für Uploads/Scan-Abschriften; Datum wird erkannt. Rückgabe `{doppelt, dokument}` |
| `entferneDokument(patientId, docId)` | einzelnes Dokument löschen |
| `ladeDokument(patientId, docId)` | `{…meta, text}` – zum Anzeigen, wenn eine Quelle angetippt wird |
| `suche(patientId, {frage, k?})` | nur Suche ohne KI (Abschnitte mit Score) |
| `antworteMitQuellen({...})` | Frage beantworten, siehe unten |
| `setzeBewerter(fn)` | Suchverfahren austauschen (später z. B. Embeddings) |

Fehler haben `e.status` und `e.meldung` (wie `kiFehler` in server.js) → direkt als JSON-Fehler zurückgeben.

### patient.json
```json
{ "id": "p2", "name": "Testpatient Max Mustermann", "geburtsjahr": null, "synthetisch": true,
  "hinweis": "Synthetischer Test-Patient. Die GraSCCo-Briefe … zusammengeführt …",
  "erstelltAm": "…",
  "dokumente": [ { "docId": "gebauer", "titel": "Entlassungsbericht", "datum": "2028-11-24",
                   "quelle": "daten/grascco/Gebauer.txt", "typ": "arztbrief", "zeichen": 7559, "hinzugefuegtAm": "…" } ] }
```
Dokumente sind nach Datum sortiert (ohne Datum am Ende) → direkt als Zeitstrahl nutzbar.

### antworteMitQuellen
```js
const r = await rag.antworteMitQuellen({
  patientId, frage, verlauf,            // verlauf: [{rolle:'nutzer'|'avatar', text}] (ohne die neue Frage)
  systemprompt,                         // gespraechStand().systemprompt (App-Anweisung bzw. prompt/gespraech.md)
  model,                                // optional, Standard ANTHROPIC_MODEL_GESPRAECH bzw. claude-sonnet-5-5
  streaming: true,                      // optional
  beiSatz: (satz) => avatarSprichText(satz),   // optional, nur mit streaming: jeder fertige Satz sofort
  erweitern: true,                      // optional; false spart ca. 1–3 s (keine Claude-Suchbegriffe)
});
```
Rückgabe:
```json
{
  "text": "Antwort ohne Quellenmarker – zum Vorlesen und als Untertitel",
  "textMitMarkern": "… Ramipril [1]. … [2, 3]",
  "segmente": [ { "text": "Teilsatz", "quellen": [1] } ],
  "quellen": [ { "nr": 1, "docId": "xavier", "titel": "Arztbrief", "datum": "2022-02-10",
                 "abschnitt": "Therapieempfehlung", "zitat": "Tambocor 100 mg 1-0-1 …",
                 "chunkId": "xavier#8", "start": 5585, "ende": 5739 } ],
  "treffer": [ { "chunkId": "…", "docId": "…", "titel": "…", "datum": "…", "abschnitt": "…", "start": 0, "ende": 700, "score": 6.1 } ],
  "suchbegriffe": ["Medikation", "…"],
  "modell": "claude-sonnet-5-5", "stopGrund": "end_turn",
  "dauerMs": 8900, "zeiten": { "erweiterungMs": 2500, "sucheMs": 5, "ersteTextMs": 3900, "antwortMs": 6400 }
}
```
`start`/`ende` sind Zeichenpositionen im Volltext von `ladeDokument(patientId, docId).text` → beim Antippen genau diese Stelle markieren.

## Routen in server.js (umgesetzt am 27.11.2026)
Alle Änderungen brauchen wie bisher `X-Requested-With: akki-app` + `Content-Type: application/json`.

**Patient (angemeldeter Nutzer):**
- `GET /api/patient` → `{ patient: null | { id, name, geburtsjahr, hinweis, dokumente:[{docId, titel, datum:'JJJJ-MM-TT'|null, typ:'arztbrief'|'upload'|'scan', zeichen}] } }` (nach Datum sortiert → Zeitstrahl)
- `GET /api/patient/dokument/:docId` → `{ docId, titel, datum, typ, quelle, text }` (Volltext fürs Quellen-Popup; nur eigener Patient)

**Gespräch** `POST /api/avatar/gespraech` – unverändert aufrufen. Ist dem Nutzer ein Test-Patient zugeordnet, kommt die Antwort aus dessen Unterlagen:
- JSON (V1) bzw. SSE-Ereignis `fertig` (V2, `strom:true`) enthalten zusätzlich:
  `patientId` (oder null), `quellen:[{nr, docId, titel, datum, abschnitt, zitat, start, ende}]`, `antwortMitMarkern` („… Ramipril [1]. …“, nur zur Anzeige).
- `antwort` und die SSE-`satz`-Ereignisse sind OHNE Marker (zum Sprechen/Untertitel).
- Quelle antippen → `GET /api/patient/dokument/:docId`, Stelle `text.slice(start, ende)` markieren (das ist genau `zitat`).
- Kein Patient zugeordnet oder keine Unterlagen → wie bisher (hochgeladene Unterlagen als Kontext), `quellen: []`.

**Upload** `POST /api/kontext`: Bei zugeordnetem Patienten landet die Unterlage zusätzlich in dessen Suchindex (Typ `upload` bzw. `scan`); Löschen über `/api/kontext` entfernt sie dort wieder.

**Admin** (nur Rolle `admin`):
- `GET /api/admin/patienten` → `{ patienten:[{id, name, geburtsjahr, dokumente}], nutzer:[{username, role, patientId}], standardPatient:'p2' }`
- `POST /api/admin/patienten` `{id, name, geburtsjahr?}` → wie GET + `patient` (id: a–z, 0–9, - _)
- `GET /api/admin/patienten/:id` → `{ patient }`
- `DELETE /api/admin/patienten/:id` → wie GET
- `GET /api/admin/beispielbriefe` → `{ dateien:['Albers.txt', …] }` (daten/grascco)
- `POST /api/admin/patienten/:id/import` `{dateien:['Albers.txt', …]}` oder `{anzahl:15}` → `{ neu, doppelt, fehler, abschnitte, patient }`
- `PUT /api/admin/zuordnung` `{username, patientId}` (`null` = kein Patient) → wie GET
- Standard ohne Eintrag: ADMIN_USER und DEMO_USER → `p2`. p2 wird beim Serverstart angelegt, falls er fehlt.

**Einstellungen (.env):** `RAG_ERWEITERN=aus|an` (Standard aus), `RAG_ERWEITERN_MS` (1200), `ANTHROPIC_MODEL_SUCHE` (claude-haiku-5-5).
Gemessen: ohne Erweiterung erster Satz ca. 1,1–2,0 s, mit Erweiterung 2,2–3,2 s.

## Für das Design
- Unter dem Untertitel kleine Chips „1 · Arztbrief 10.2.2022 · Therapieempfehlung“, antippbar.
- Antippen öffnet das Dokument (`/api/patient/dokumente/:docId`) und markiert `start`–`ende` (zitiertes Stück).
- Datum deutsch anzeigen (`2022-02-10` → `10.2.2022`), `null` → „ohne Datum“.

## Offene Punkte
- Briefdatum und Titel werden nur grob erkannt (GraSCCo hat viele fiktive Jahre, z. B. 2051/2068); im Admin-Bereich änderbar machen wäre gut.
- Abfrageerweiterung (RAG_ERWEITERN=an) kostet ca. 1–1,5 s vor dem ersten Satz; Standard ist deshalb aus.
- Der technische Hinweis an Claude (Quellen zitieren, „alle Unterlagen gehören zur Test-Person“) steht in `rag.js` (`QUELLEN_HINWEIS`) – bitte vom Team gegenlesen.
