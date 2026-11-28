# Patientendaten (patientendaten.js) – Einbindung in server.js und Oberfläche

Nur synthetische Test-Patienten. Baut auf `rag.js` auf (gleicher Ordner `lokal/patienten/<id>/`, Dateien 0600, Ordner 0700).
Inhalte werden nie geloggt; das Modul schreibt nur Status-Codes ins Log.

| Datei im Patientenordner | Inhalt |
|---|---|
| `patient.json`, `index.json`, `dokumente/<docId>.txt` | gehören `rag.js` (Unterlagen + Suchindex) |
| `patientendaten.json` | Zusatz je Dokument (`typ:'foto'`, Seitenanzahl) + Gesundheitsangaben |
| `zeitstrahl.json` | Ereignisse je Dokument, mit Prüfsumme des Textes (Neuberechnung nur bei Änderung) |
| `bilder/<docId>-<n>.jpg` | optionale Scan-Seitenbilder |

## Ausprobieren
```
node werkzeuge/patientendaten-test.js --ohne-ki                 # Ablauf ohne Claude
node --env-file=.env werkzeuge/patientendaten-test.js --ohne-p2 # + 2 Claude-Aufrufe (1 echt, 1 aus Cache)
node --env-file=.env werkzeuge/patientendaten-test.js           # + p2-Zeitstrahl (nur fehlende Briefe)
```
Gemessen am 27.11.2026 (Sonnet 5.5, effort low): ein Brief ca. 10 s, ca. 0,02 $. p2 (15 Briefe, 4 parallel) 34 s, 160 Ereignisse,
alle 160 Zitate wörtlich im Brief gefunden. Der p2-Zeitstrahl ist schon berechnet und liegt in `lokal/patienten/p2/zeitstrahl.json`.

## Funktionen (`const pd = require('./patientendaten');`)
Fehler haben wie `rag.js` `e.status` und `e.meldung` → direkt als JSON-Fehler zurückgeben.

| Funktion | Zweck |
|---|---|
| `richteTestpatientenEin()` | beim Serverstart: legt `p-demo` leer an und `p2` (15 GraSCCo-Briefe), falls sie fehlen |
| `patientFuerNutzer(username)` | `ADMIN_USER → 'p2'`, `DEMO_USER → 'p-demo'`, sonst `null` |
| `standardZuordnung()` | `{ admin: 'p2', demo: 'p-demo' }` (Namen aus .env, klein geschrieben) |
| `zuruecksetzen(patientId)` | löscht alles des Patienten und legt ihn leer neu an. Nur `p-demo` (sonst 403) |
| `liste(patientId)` | Unterlagen, siehe unten |
| `dokument(patientId, docId)` | Unterlage mit Volltext |
| `bild(patientId, docId, seite)` | `{ mime:'image/jpeg', daten:Buffer }` (Seite ab 1) |
| `umbenennen(patientId, docId, {titel?, datum?})` | Titel/Datum ändern, Suchindex wird neu gebaut |
| `loeschen(patientId, docId)` | Text, Suchindex-Einträge, Seitenbilder und Zeitstrahl-Einträge weg |
| `neu(patientId, {titel?, text, typ, bilder?, datum?})` | neue Unterlage + Suchindex. `typ`: `arztbrief`\|`scan`\|`upload`\|`foto`; `bilder`: JPEG als Buffer/Base64/Data-URL (max. 20, je 8 MB). `text` ist Pflicht (Abschrift macht `schreibeAb()` in server.js) |
| `await extrahiereEreignisse(patientId, docId, {erzwingen?})` | Zeitstrahl-Ereignisse eines Dokuments per Claude (Cache, wenn unverändert) |
| `await aktualisiereZeitstrahl(patientId, {parallel?:3, max?})` | alle fehlenden Dokumente nachberechnen → `{berechnet, fehler:[{docId,status,meldung}], offen:[docId]}` |
| `zeitstrahl(patientId)` | sortierter Zeitstrahl aus dem Cache (kein KI-Aufruf) |
| `profil(patientId)` | Gesundheitsangaben |
| `speicherProfilAngabe(patientId, {feld, wert, quelle})` | eine Angabe ergänzen (doppelte werden erkannt) |
| `setzeProfilFeld(patientId, feld, werte)` | ein Feld ganz ersetzen (Bearbeiten) |
| `loescheProfilAngabe(patientId, feld, id)` | eine Angabe entfernen |
| `status(patientId)` | nächster Onboarding-Schritt |
| `onboardingSatz(status, sprache)` / `onboarding(patientId, sprache)` | organisatorischer Hinweis für den Avatar (de, en, fr, tr, ar) |

Modell: `ANTHROPIC_MODEL_ZEITSTRAHL`, sonst `ANTHROPIC_MODEL`, sonst `claude-sonnet-5-5`.

## Änderungen in server.js (Koordinator / backend-auth)
1. `const pd = require('./patientendaten');` und beim Start `pd.richteTestpatientenEin()`.
2. Zuordnung: in der Funktion, die den Patienten zum Nutzer liefert (heute `STANDARD_PATIENT` für beide Standardnutzer),
   ohne eigenen Eintrag in `patient-zuordnung.json` **`pd.patientFuerNutzer(nutzer)`** verwenden → demo bekommt `p-demo`.
3. `POST /api/kontext`: Uploads mit zugeordnetem Patienten über `pd.neu()` statt `rag.fuegeDokumentHinzu()` anlegen
   (dann gibt es Typ `foto` und Seitenbilder). Danach **ohne zu warten** `pd.extrahiereEreignisse(pid, docId).catch(() => {})`
   anstoßen, damit der Zeitstrahl bald fertig ist.
4. Neue Routen unten. Alle brauchen eine Anmeldung; der Patient ist immer der des angemeldeten Nutzers (nie aus der URL).
   Änderungen wie bisher mit `X-Requested-With: akki-app` + `Content-Type: application/json`.
   Fehler: `{ fehler: e.meldung }` mit `e.status`. Kein Patient zugeordnet → `404 { fehler:'Kein Test-Patient zugeordnet.' }`.

## Routen und Rückgabeform

### Unterlagen
**`GET /api/unterlagen`** → `{ patientId, unterlagen: [Unterlage] }`
```json
{ "patientId": "p2", "unterlagen": [
  { "docId": "xavier", "titel": "Arztbrief", "datum": "2022-02-10", "typ": "arztbrief",
    "quelle": "daten/grascco/Xavier.txt", "zeichen": 6120, "erstelltAm": "2026-11-27T16:09:14.980Z",
    "seiten": 0, "ereignisse": 12 } ] }
```
`datum` `null` = ohne Datum (steht am Ende). `typ`: `arztbrief`|`scan`|`upload`|`foto`. `seiten` = Anzahl Seitenbilder.
`ereignisse`: Anzahl im Zeitstrahl, `null` = noch nicht ausgewertet.

**`GET /api/unterlagen/:docId`** → `{ unterlage: { …Unterlage, text, bilder:[1,2] } }` (`bilder` = Seitennummern)

**`GET /api/unterlagen/:docId/bild/:seite`** → JPEG (`Content-Type: image/jpeg`, `Cache-Control: private, no-store`)

**`PATCH /api/unterlagen/:docId`** `{ titel?, datum?: 'JJJJ-MM-TT' | null }` → `{ unterlage: Unterlage }`

**`DELETE /api/unterlagen/:docId`** → `{ geloescht: docId, unterlagen: [Unterlage] }`

**`POST /api/unterlagen`** – eine neue Unterlage. Body (JSON, Größenlimit wie `/api/kontext`):
```json
{ "titel": "optional",
  "art": "text" | "bild" | "pdf" | "seiten",
  "text": "…",                       // bei art:text
  "inhalt": "<base64>", "mime": "image/jpeg|image/png|application/pdf",   // bei art:bild/pdf
  "seiten": ["<base64-JPEG>", "…"]   // bei art:seiten (Kamera-Scan mehrerer Seiten)
}
```
Server: Text direkt; Bild/PDF/Seiten zuerst mit `schreibeAb()` abschreiben (Seiten als mehrere Bilder in einem Aufruf
oder nacheinander, Texte mit Leerzeile verbinden), dann `pd.neu(pid, { titel, text, typ, bilder })`:
`text → 'upload'`, `pdf → 'upload'`, `bild → 'foto'` (+ `bilder:[inhalt]`, nur bei JPEG), `seiten → 'scan'` (+ `bilder: seiten`).
Danach `pd.extrahiereEreignisse(...)` im Hintergrund.
→ `201 { unterlage: Unterlage, doppelt: false, zeitstrahl: 'laeuft' }`

### Zeitstrahl
**`GET /api/zeitstrahl`** → `pd.zeitstrahl(pid)`:
```json
{ "patientId": "p2",
  "zeitraum": { "von": "2008", "bis": "2066-12-12" },
  "dokumente": { "gesamt": 15, "ausgewertet": 15, "offen": [] },
  "ereignisse": [
    { "id": "xavier~3", "datum": "2022-02", "datumGenauigkeit": "monat", "datumQuelle": "text", "sortDatum": "2022-02",
      "art": "medikation", "titel": "Herzrhythmus-Medikament", "beschreibung": "Ein Satz in einfacher Sprache.",
      "docId": "xavier", "dokumentTitel": "Arztbrief", "dokumentDatum": "2022-02-10",
      "zitat": "Tambocor 100 mg 1-0-1", "belegt": true, "start": 5585, "ende": 5606 } ] }
```
- `datum`: `JJJJ-MM-TT` | `JJJJ-MM` | `JJJJ` | `null` (`datumGenauigkeit` `tag`|`monat`|`jahr`|`null`).
- Ohne eigenes Datum: `datumQuelle:'dokument'` und `sortDatum` = Briefdatum (in der Oberfläche als „ungefähr“ zeigen).
- `art`: `diagnose`|`behandlung`|`op`|`untersuchung`|`medikation`|`aufenthalt`|`sonstiges` (Farbe/Symbol je Art).
- Antippen → `GET /api/unterlagen/:docId` und `text.slice(start, ende)` markieren (= Beleg). `belegt:false` = Stelle nicht gefunden.
- `dokumente.offen` nicht leer → Hinweis „wird noch ausgewertet“ und optional `POST /api/zeitstrahl/aktualisieren`.

**`POST /api/zeitstrahl/aktualisieren`** `{}` → `await pd.aktualisiereZeitstrahl(pid, { parallel: 3 })`, dann
`{ berechnet, fehler, zeitstrahl: pd.zeitstrahl(pid) }` (dauert ca. 10 s je 3 Briefe).

### Gesundheitsangaben (Onboarding)
**`GET /api/profil-gesundheit`** → `pd.profil(pid)`:
```json
{ "patientId": "p-demo",
  "felder": { "erkrankungen": [ { "id": "e371467a", "wert": "Bluthochdruck", "quelle": "gespraech", "am": "…" } ],
              "medikamente": [], "allergien": [ { "id": "…", "wert": "keine", "quelle": "gespraech", "am": "…" } ] },
  "fehlend": ["medikamente"], "geaendertAm": "…" }
```
**`PUT /api/profil-gesundheit`** – zwei Formen:
- eine Angabe ergänzen: `{ feld, wert, quelle:'gespraech'|'scan' }` → `pd.speicherProfilAngabe` → Profil + `eintrag`, `doppelt`
- ein Feld ersetzen: `{ feld, werte:['…'] }` → `pd.setzeProfilFeld` → Profil

**`DELETE /api/profil-gesundheit/:feld/:id`** → Profil

### Onboarding
**`GET /api/onboarding`** (Sprache aus dem Nutzerprofil, `profilSprache(nutzer)`) → `pd.onboarding(pid, sprache)`:
```json
{ "patientId": "p-demo", "anzahlDokumente": 0, "profilVollstaendig": false,
  "fehlendeFelder": ["erkrankungen", "medikamente", "allergien"], "naechstesFeld": null,
  "zeitstrahlOffen": 0, "naechsterSchritt": "scannen", "sprache": "de",
  "satz": "Du hast noch keine Unterlagen bei mir. Tippe unten auf Unterlagen und scanne deinen letzten Arztbrief, dann kann ich dir helfen." }
```
`naechsterSchritt`: `scannen` (keine Unterlagen) → `profil` (`naechstesFeld` fehlt noch) → `fertig`.

### Admin
**`POST /api/admin/demo-zuruecksetzen`** `{}` (nur Rolle admin) → `pd.zuruecksetzen('p-demo')` → `{ patientId:'p-demo', dokumente:0 }`.
Danach auch die Sitzungs-Unterlagen von demo (`/api/kontext`-Speicher) leeren.

## Ablauf für demo (Avatar führt per Sprache)
1. Nach der Anmeldung `GET /api/onboarding`; ist `naechsterSchritt` nicht `fertig`, spricht der Avatar `satz`
   (über `avatarSprichText`) und die Oberfläche hebt den passenden Knopf hervor (`scannen` → „Unterlagen“).
2. Nach jedem Upload erneut `GET /api/onboarding` → nächster Satz (Frage nach `naechstesFeld`).
3. Antwortet die Person im Gespräch auf diese Frage, speichert die Oberfläche (oder der Gesprächs-Endpunkt) die Antwort
   mit `PUT /api/profil-gesundheit { feld: naechstesFeld, wert: <Antwort>, quelle:'gespraech' }`.
   Einfachster Weg für die Demo: solange `naechsterSchritt === 'profil'`, die nächste gesprochene Eingabe als Wert speichern
   und zur Bestätigung im Profil anzeigen (dort änderbar). Eine automatische Erkennung per Claude wäre ein nächster Schritt.
4. `fertig` → Unterlagen, Zeitstrahl und Profil sind in der App einsehbar.

## Was das Team noch prüfen/liefern sollte
- Welche Gesundheitsangaben gesammelt werden (`PROFIL_FELDER`, Platzhalter im Code) und der Wortlaut der Onboarding-Sätze
  (vor allem Türkisch und Arabisch, `SAETZE` in `patientendaten.js`).
- Die technische Extraktions-Anweisung `EXTRAKTION_ANWEISUNG` (nur übernehmen, was im Text steht; keine Bewertung) gegenlesen.
- GraSCCo-Briefe haben fiktive Jahre (z. B. 2066) – der p2-Zeitstrahl reicht deshalb von 2008 bis 2066.
