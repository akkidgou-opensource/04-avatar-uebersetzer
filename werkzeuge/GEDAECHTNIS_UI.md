# „Was Mitano. über dich weiß“ – Spezifikation für die Oberfläche (Design-Agent)

Kleiner Abschnitt in den **Einstellungen** (unter „Unterlagen“/„Gesundheitsangaben“). Nur Test-Patienten, nur synthetische Daten.
Keine Popups (Design-Vorliebe), keine `style=`-Attribute, keine Inline-Handler. Warm, Amber-Glas wie der Rest.

## Daten
`GET /api/gedaechtnis` (angemeldet; Patient = der des Nutzers) →
```json
{ "patientId": "p2", "synthetisch": true,
  "zusammenfassung": "Hausarzt: Dr. Sommer. Allergie gegen Penicillin. Seit 27.11.2026 schwindelig.",
  "anzahl": { "gesamt": 127, "gespraech": 4, "dokument": 123, "verlauf": 12 },
  "fakten": [
    { "id": "g-1a2b3c4d", "art": "person", "text": "Hausarzt heißt Dr. Sommer", "sicher": true,
      "aktualisiert": "2026-11-28T01:10:00.000Z",
      "quelleTyp": "gespraech", "quelleText": "Du hast mir am 28.11.2026 erzählt",
      "zitat": "Mein Hausarzt heißt übrigens Dr. Sommer.", "docId": null, "start": null, "ende": null,
      "widerspruch": null },
    { "id": "d-9f8e7d6c", "art": "medikament", "text": "Tambocor 100 mg, morgens und abends", "sicher": true,
      "quelleTyp": "dokument", "quelleText": "Arztbrief vom 10.2.2022",
      "zitat": "Tambocor 100 mg 1-0-1", "docId": "xavier", "start": 5585, "ende": 5606, "widerspruch": null }
  ],
  "aktualisiert": "2026-11-28T01:10:00.000Z" }
```
- `fakten` ist schon sortiert: erst aus Gesprächen, dann aus Unterlagen; innerhalb nach `art`.
- `art`: `person` | `beschwerde` | `diagnose` | `medikament` | `allergie` | `termin` | `vorliebe` | `lebensumstand` | `sonstiges`.
- `widerspruch` (nur Gespräch): `{ text, quelleText }` = später anders gesagt → als kleiner Hinweis „Später hast du gesagt: …“ zeigen.
- `sicher:false` → dezent „(unsicher)“.

`DELETE /api/gedaechtnis/:id` (mit `X-Requested-With: akki-app`) → gleiche Antwort wie GET (neuer Stand).
`DELETE /api/gedaechtnis` → alles vergessen → `{ patientId, geloescht: true }` (danach neu laden).
Kein Patient zugeordnet → `404 { fehler }` → Abschnitt ausblenden.

## Aufbau
1. Überschrift „Was Mitano. über dich weiß“, darunter klein: „Gesammelt aus euren Gesprächen und deinen Unterlagen. Nur Testdaten.“
2. **Zusammenfassung** (falls nicht leer) als ruhiger Absatz in einer Glas-Karte.
3. **Aus unseren Gesprächen** (Gruppe 1), darin **nach `art` gruppiert** (Zwischenüberschrift je Art, nur Arten mit Einträgen, Reihenfolge wie oben).
   Je Zeile:
   - kleines Symbol/Farbe je `art`; Anzeigenamen: Menschen um dich, Beschwerden, Diagnosen, Medikamente, Allergien, Termine, Vorlieben, Alltag, Sonstiges
   - `text`, darunter klein `quelleText` (z. B. „Du hast mir am 28.11.2026 erzählt“); `sicher:false` → „(da warst du dir nicht ganz sicher)“
   - `widerspruch` → zusätzliche kleine Zeile „Später hast du gesagt: {widerspruch.text}“
   - rechts Knopf „Vergessen“ (Symbol, `aria-label="Diesen Eintrag vergessen"`), **zweistufig ohne Popup**: erster Tipp → Knopf wird zu „Wirklich?“ (Amber, 4 s, dann zurück), zweiter Tipp → `DELETE /api/gedaechtnis/:id`, Zeile sanft ausblenden, kurz „Vergessen.“
   - Antippen der Zeile (nicht des Knopfs) klappt `zitat` auf: „Deine Worte: „…““.
4. **Aus deinen Unterlagen** (Gruppe 2): standardmäßig eingeklappt („123 Angaben aus deinen Unterlagen anzeigen“), ebenfalls nach `art` gruppiert.
   Zeile: `text`, darunter `quelleText` („Arztbrief vom 10.2.2022“). Antippen öffnet die Unterlage wie beim Quellen-Chip (`GET /api/unterlagen/:docId`, Stelle `start`–`ende` markieren; `start:null` → nur Dokument öffnen). „Vergessen“ zweistufig wie oben.
5. **Leerzustand** (`anzahl.gesamt === 0`): freundliche Karte „Ich kenne dich noch kaum. Erzähl mir einfach von dir – wer dein Hausarzt ist, was du nimmst, wie es dir geht. Ich merke mir das Wichtige.“
   Nur Gespräche leer: „Aus unseren Gesprächen weiß ich noch nichts – erzähl mir einfach von dir.“
6. Ganz unten: Textknopf „Alles vergessen“ → zweistufig ohne Popup: erster Tipp ändert den Text zu „Wirklich alles vergessen? Nochmal tippen“ (5 s), zweiter Tipp → `DELETE /api/gedaechtnis` → danach neu laden, Hinweis „Erledigt – ich habe alles vergessen. Deine Unterlagen bleiben gespeichert.“ (Angaben aus Unterlagen kommen beim nächsten Hochladen bzw. Neu-Lernen wieder.)

Alle Texte per Du, kurz, ohne Fachjargon.

## Quellen im Gespräch
Die Gesprächsantwort (`/api/avatar/gespraech`, JSON bzw. SSE `fertig`) bekommt zusätzlich
`gedaechtnisQuellen: [Fakt wie oben]` – nur die Fakten, die die Antwort benutzt hat.
Als Chips neben den Unterlagen-Quellen zeigen: Gesprächs-Fakt → „Du hast mir am 28.11.2026 erzählt“ (nicht antippbar oder Antippen zeigt `zitat`),
Dokument-Fakt → wie Unterlagen-Chip (antippbar, `docId`, `start`, `ende`).

## Aktualisieren
Abschnitt beim Öffnen der Einstellungen laden. Das Lernen läuft im Hintergrund (2–3 s nach einer Antwort); ein „Neu laden“-Wischen ist nicht nötig.
