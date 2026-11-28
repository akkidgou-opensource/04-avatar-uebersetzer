# Schnittstellen Runde 2 (28.11.2026) – vereinbarte Felder

Angelegt vom Dialog-Agenten (server.js/rag.js/gedaechtnis.js/patientendaten.js). Andere Agenten ergänzen ihre Abschnitte.
Alle Änderungen per API wie bisher mit `X-Requested-With: akki-app` + `Content-Type: application/json`.

## 1. Gefühle und Krise (Dialog → Design)
`POST /api/gespraech/weg` liefert zusätzlich:
- `grund: 'gefuehl'` – Gefühle/Sorgen/Ängste/Trauer/Einsamkeit → Claude, Überbrückung einfühlsam, ohne Witz.
- `grund: 'krise'`, `krise: 'seelisch' | 'koerperlich'`, `hilfe` – NUR bei klaren Anzeichen (Nutzerentscheid 28.11.2026, Team prüft):
  `seelisch` = Suizidalität, schwere Depression, seelisches Trauma; `koerperlich` = akute schwere körperliche Erkrankung/Verletzung.
  Überbrückung ruhig („Ich bin da. Einen Moment.“). Ohne Krise gibt es KEIN `krise`-Feld.
Die Gesprächsantwort (`POST /api/avatar/gespraech`, SSE `fertig` bzw. JSON) hat bei Krise ebenfalls `krise` und `hilfe`
(auch wenn die Weiche nichts erkannt hat: zweite Prüfung im Hintergrund per Haiku).
```json
"hilfe": { "art": "seelisch", "text": "Du bist nicht allein. Hier bekommst du sofort Hilfe – rund um die Uhr.",
           "nummern": [ { "nummer": "116 123", "name": "TelefonSeelsorge (rund um die Uhr, kostenlos)" },
                        { "nummer": "112", "name": "Notruf / Rettungsdienst" } ] }
"hilfe": { "art": "koerperlich", "text": "Das klingt ernst. Hier bekommst du schnell ärztliche Hilfe.",
           "nummern": [ { "nummer": "116 117", "name": "Ärztlicher Bereitschaftsdienst" },
                        { "nummer": "112", "name": "Notruf / Rettungsdienst" } ] }
```
Format laut Design-Agent: hilfe:{text, nummern:[{nummer, name}]} (+ `art`); text/name in der Profilsprache. `tel:`-Link = Nummer ohne Leerzeichen.
Krisen-Gespräche werden nicht ins Gedächtnis übernommen. Im Log steht nur „Weg: claude (krise)“.

## 2. Sofort-Lesen neuer Unterlagen (Dialog → Design/Avatar)
`POST /api/unterlagen` (und Upload über `POST /api/kontext` beim Test-Patienten) antworten zusätzlich mit
`ansage: { status: 'laeuft', url: '/api/unterlagen/<docId>/ansage' }`.
`GET /api/unterlagen/<docId>/ansage` → `{ status: 'laeuft' | 'fertig' | 'fehler', text, sprache }` (text = 2 Sätze, Du-Form, Profilsprache,
endet mit dem Angebot „Soll ich ihn dir erklären?“). Ca. 2–4 s nach dem Hochladen fertig; Browser fragt alle ~1,5 s nach (max. 20 s).
→ Browser/Avatar spricht `text` wie einen Antwortsatz (V2: `did.speak`; V1: `POST /api/avatar/sprechen { text }`) und zeigt ihn als Untertitel.
Sagt die Person danach „ja/gern/erzähl …“, erklärt Mitano. genau dieses Dokument (Server merkt sich das Dokument nach dem Abruf der fertigen Ansage, 10 min).
Wissensspeicher, Zeitstrahl und Gedächtnis werden beim Hochladen sofort im Hintergrund aktualisiert.

## 3. Zeitstrahl je Dokument (Dialog → Design)
`GET /api/zeitstrahl` → jedes Ereignis hat zusätzlich `dokumentTyp` ('arztbrief'|'scan'|'upload'|'foto') und `farbe` (0–7, stabil je Dokument,
Nachbarn nach Datum unterschiedlich); vorhanden waren schon `docId`, `dokumentTitel`, `dokumentDatum`.
Neu außerdem `dokumentListe: [{ docId, titel, datum, typ, farbe, ereignisse }]` (nach Datum) zum Gruppieren/Legende (`dokumente` bleibt die bisherige Zählung gesamt/ausgewertet/offen).

## 4. Knöpfe leuchten bei Erklärungen (Dialog → Design)
Bei App-Erklärungen (Weg-Grund `app`) sendet der SSE-Strom ein Ereignis `knoepfe` mit `{ knoepfe: ['…'] }`, sobald ein Satz einen Knopf nennt
(vor bzw. mit dem Satz), und `fertig` enthält `zeigeKnoepfe: ['…']` (alle). Schlüssel = **Element-ID in index.html** (Vorschlag, Design darf ändern):
`mikro`, `tastatur` (Schreiben), `kontext-knopf` (Meine Unterlagen), `stopp`, `quellen-knopf`, `einstellungen-knopf`, `tab-zeitstrahl`, `tab-dokumente`,
`scannen`, `datei-knopf`, `tab-original`, `tab-text`, `tab-einfach`, `uebersetzen`, `vorlesen`, `dok-umbenennen`, `dok-loeschen`, `gd-alles`,
`protokoll-knopf`, `neu-gespraech`, `logout`.
→ Design: Klasse für Leuchten/Pulsieren, solange Mitano. spricht (bzw. ~6 s); Knöpfe in geschlossenen Sheets ignorieren oder den Öffner-Knopf leuchten lassen.

## 5. Wake-Word-Hinweis (Dialog → iOS)
`GET /api/onboarding` liefert zusätzlich `wakewordHinweis` (Profilsprache), z. B. de: „Übrigens: Wenn du eine Weile nichts sagst, ruh ich mich kurz aus. Sag einfach ‚Mitano‘, dann bin ich wieder da.“
→ iOS: einmal pro Gerät + Patient beim ersten Gespräch sprechen (Merker im localStorage, z. B. `mitano-wakeword-<patientId>`), nach der Begrüßung.

## 6. Zuhören / Sprechen am `<body>` (iOS/Avatar → Design) – eingetragen vom Design-Agenten
Das Design liest NUR diese Attribute (CSS + kleiner Beobachter), setzt sie nie selbst. Fehlen sie, nutzt es die Zustände aus `oberflaeche()`.

| Attribut | Werte | Bedeutung | gesetzt von |
|---|---|---|---|
| `body[data-hoeren]` | `aus` / `hoert` / `hoert-sprache` / `verarbeitet` / `ruhe` | Mikro aus · offen, hört („Ich höre dich“) · Stimme gerade erkannt (stärkeres Signal) · Satz gehört, wird verarbeitet („Ich hab dich gehört – einen Moment“) · Ruhemodus, Wake-Word „Mitano“ aktiv | iOS |
| `--pegel` auf `document.body.style` | `0` … `1` (Zahl ohne Einheit) | Mikrofonpegel, ca. 10–20× pro Sekunde | iOS |
| `body[data-avatar]` | `still` / `spricht` / `unterbrochen` | ruhig · spricht hörbar (Glow an) · gerade unterbrochen (Glow sofort aus, < 150 ms; danach wieder `still`) | Avatar |

## 7. Knopf-Schlüssel (Design) – ergänzt Abschnitt 4
`zeigeHilfeKnoepfe(schluessel[])` (Design) nimmt **beides**: die Element-IDs aus Abschnitt 4 UND diese Kurz-Schlüssel:
`mikro`, `schreiben`, `unterlagen`, `einstellungen`, `stopp`, `quellen`, `scannen`, `hochladen`, `zeitstrahl`, `dokumente`, `stimme`, `sprache`,
`avatar`, `gedaechtnis`, `datenschutz`, `abmelden`, `protokoll` (Dashboard-Agent kann eigene Ziele per Attribut `data-hilfe="<schlüssel>"` am Element ergänzen – zeigeHilfeKnoepfe sucht zuerst `[data-hilfe~=schlüssel]`).
Liegt das Ziel in den geschlossenen Einstellungen → `einstellungen-knopf` leuchtet; in den geschlossenen Unterlagen → `kontext-knopf`.
Leuchten endet 2 s nachdem Mitano. fertig gesprochen hat (spätestens 25 s); `zeigeHilfeKnoepfe([])` beendet sofort. Unbekannte Schlüssel: still ignoriert.
Design verdrahtet SSE `knoepfe` und `fertig.zeigeKnoepfe` selbst an der Übergabestelle (neben `zeigeQuellenKnopf`).

## 8. Krisen-Hilfekarte (Design)
`zeigeKrisenKarte(hilfe)` – ruhige Karte über dem Gespräch, nicht blockierend, große `tel:`-Knöpfe, „Jetzt nicht“. Danach in dieser Sitzung
in den Einstellungen („Hilfe in schweren Momenten“) und im Quellen-Sheet wieder auffindbar. Design ruft sie an der Übergabestelle auf
(`fertig.krise`/`hilfe`; das `weg`-Ergebnis mit `krise` wird ebenfalls übergeben, falls an der Stelle verfügbar).

## 9. Ansage nach dem Hochladen (Design) – geändert
Design ruft nach dem Upload `window.avatarAnsage(ansage.url)` (Avatar, Abschnitt 7 unten) auf, zeigt bis dahin „Mitano. liest deinen Brief …“
und kehrt ins Gespräch zurück, sobald der Upload fertig ist. Design fragt NICHT selbst ab.
Hinweis Design: `data-hoeren` nimmt die Werte des iOS-Agenten `aus | hoert | hoert-sprache | ruhe | verarbeitet` (nicht `ruht`);
`data-avatar` zusätzlich `zuhoeren`.

## 6. Sprech-Zustand des Avatars (Avatar → Design)
`document.body.dataset.avatar` (CSS: `body[data-avatar="spricht"]` usw.), gesetzt von `avatarZustand()` in index.html:
- `spricht` – Mitanos Ton ist WIRKLICH hörbar (Pegel der Tonspur nach dem Puffer, Takt 150 ms, 300 ms Nachlauf; nicht „Auftrag gesendet“).
- `unterbrochen` – sofort beim Unterbrechen (Barge-in, Stopp, neue getippte Frage), ca. 1,2 s lang; Ton wird gleichzeitig lokal
  in ca. 40 ms ausgeblendet (wo der Browser `volume` erlaubt; iPhone: hartes Stumm, ohne Rampe nicht möglich).
- `zuhoeren` – Freihand an bzw. Zuhören aktiv, Mitano still.
- `still` – sonst.
Zuhör-Details (hört/verarbeitet/ruht, Pegel) kommen vom iOS-Agenten über `body[data-hoeren]` und `--pegel`.

## 7. Ansage nach dem Hochladen sprechen (Avatar, für Design/Upload-Ablauf)
`window.avatarAnsage(ansage.url)` aufrufen, sobald die Upload-Antwort `ansage.url` liefert (nicht awaiten nötig).
Fragt alle 1,5 s nach (max. ~21 s), wartet bis eine laufende Antwort fertig ist (max. 20 s), verbindet bei Bedarf neu
(auch aus dem Ruhemodus), zeigt den Text als Blase und spricht ihn über den normalen Weg (V2 did.speak / V1 /api/avatar/sprechen).
Rückgabe Promise<boolean> (true = gesprochen).

## 10. Dashboard (Dashboard-Agent ctx_dc1bd3a58b5c) – eingetragen vom Dashboard-Agenten
- **Ablauf:** Anmeldung → (einmalig) Einrichtung → **Dashboard** `#ansicht-dashboard` (Startbildschirm) → „Mit Mitano. reden“ `#dash-mitano` → Gespräch.
  `zeige('dashboard')` ist eine vierte Ansicht neben login/einrichtung/gespraech; Login und Einrichtung sind dabei `hidden`.
- **D-ID-Kosten:** Nach Login/Einrichtung wird NICHT mehr verbunden. Verbinden erst in `dashZumGespraech()` (= `window.mitanoGespraechOeffnen`)
  über `waehleAvatar(a)`. Steht die Verbindung noch bzw. wird gerade verbunden → nur `zeige('gespraech')`. Sperre gegen Doppelaufruf, solange das Öffnen läuft.
- **Zurück:** Knopf `#dash-zurueck` oben links im Gespräch + Rand-Wischgeste (linker Rand, in `wischgesten()`, bewegt nur `#dash-zeiger`,
  nie das Live-Video) → `dashZurueck()`: Stopp, Sheets zu, Dashboard; Trennen per `avatarTrennen()` nach 60 s (`DASH_TRENNEN_MS`), außer die Person ist zurück.
- **Einstellungen → Neu verbinden** auf dem Dashboard: trennt nur, verbindet nicht (Guard in `neuVerbinden()`).
- **API (dashboard.js, in server.js eingehängt):** `GET /api/dashboard` → `{ name, unterlagen, termine:{naechste, vergangeneEigene, erzaehlt, bisherige, bisherigeGesamt},
  medikamente:{status:'fertig'|'laeuft'|'keiner'|'fehler', quelle:{docId,titel,datum,abschnitt,start}, eintraege:[{medikament,staerke,morgens,mittags,abends,nachts,schema,hinweis,zitat,start,ende}], hinweise},
  medikamentHinweise }`. `POST /api/termine {titel, datum JJJJ-MM-TT, uhrzeit SS:MM|null, ort|null, ausFakt?}`, `PUT /api/termine/:id`, `DELETE /api/termine/:id`
  (t-… = eigener Termin; Gedächtnis-ID = erzählten Termin vergessen). Speicher: `lokal/patienten/<id>/termine.json`, `medikamente.json` (0600, atomar).
- **Mitano kennt Termine/Medikamente:** `dashboard.kontextFuerClaude(pid,{frage})` → Systemblock (nur Zwischenspeicher, ≤ 1200 Zeichen), vom Dialog-Agenten bei Termin-/Medikamentenfragen angehängt.
- **Leuchten:** `data-hilfe` an `#dash-mitano` (avatar), `#dash-unterlagen` (unterlagen), `#dash-einstellungen` (einstellungen), `#dash-scannen` (scannen), `#dash-zurueck` (anfang).
- Code-Markierungen in index.html: `/* DASHBOARD */`, `<!-- DASHBOARD -->`, `// DASHBOARD` … `// /DASHBOARD`.

## 10. Zuhören, Ruhemodus, Wake-Word (iOS/Sprache) – eingetragen vom iOS-Agenten
- **Immer zuhören:** Nach dem Verbinden schaltet ein Regler (alle 0,5 s, `fhRegler()`) Freihand von selbst an. Barge-in ist immer aktiv
  (auch bei Überbrückung und Vorlesen). Ein erkannter Satz geht nie verloren (wartet bis zu 6,5 s, bis die unterbrochene Anfrage beendet ist).
- **Mikro-Knopf `#mikro` = Stummschalten.** Stumm = derselbe Wake-Word-Zustand wie der Ruhemodus (`data-hoeren="ruhe"`, `--pegel` 0);
  entmuten per „Mitano“ oder Antippen. `data-stumm="true|false"`, `data-zustand` = `stumm | ruhe | hoert | spricht | denkt | aus`,
  `aria-label` = `Stummschaltung aufheben` (stumm) / `Zuhören` (Ruhemodus) / `Stummschalten` (hört zu).
- **Begrüßung:** einmal pro Seitenaufruf 0,9 s nach dem ersten Verbinden `GET /api/gespraech/begruessung` → `avatarSprich(text)`
  (nur wenn nichts anderes läuft). Schonzeit: kein Barge-in, bis Mitano. die Begrüßung fertig gesprochen hat (max. 15 s ohne Ton).
- **Statuspille** `data-art` neu: `stumm` („Mikro stumm“), `ruhe` („Ruht – sag „Mitano““).
- **`body[data-hoeren]`** = `aus` | `hoert` | `hoert-sprache` (Stimme gerade erkannt bzw. „Mitano“ gehört) | `ruhe` | `verarbeitet`.
- **`--pegel`** auf `document.body.style`: 0…1, geglättet, 20 Hz aus dem Mikro im Avatar-Raum; im Ruhemodus/stumm 0.
- **Ruhemodus:** 20 s nach der letzten Aktivität (Antwort zu Ende, keine Stimme) → Mikro im Avatar-Raum aus (D-ID hört nichts),
  Geräte-Spracherkennung (iPhone: Apple-Plugin, Browser: Web Speech) wartet nur auf „Mitano“. Außerhalb von `#ansicht-gespraech`
  (z. B. Dashboard) sofort Ruhemodus. Die D-ID-Pause nach ~2,5 min bleibt unverändert.
- **Wake-Word:** Varianten Mitano/Mittano/Mi tano/Mi-tano/Mitanno/Mithano/Metano/Mit ano/Mıtano + arabische Schreibweisen, in allen 5 Sprachen.
  „Mitano, <Frage>“ → Frage direkt per `sendeNachricht()` (verbindet bei Bedarf still neu). Nur „Mitano“ → Ton + Haptik, dann zuhören
  (verbunden: Freihand; pausiert: neu verbinden + Frage mit Geräte-Erkennung aufnehmen).
  Außerhalb des Gesprächs: `await window.mitanoGespraechOeffnen()` (Dashboard-Agent), sonst `waehleAvatar(aktuellerAvatar)`.
- **Hinweis:** `wakewordHinweis` aus `GET /api/onboarding` spricht Mitano. genau dann, wenn er zum ersten Mal einschlafen würde
  (je Gerät + Patient, `localStorage` `mitano-wakeword-<patientId>`), danach Ruhemodus.
- **Kein Hintergrund** (Nutzerentscheid): Wake-Word nur bei geöffneter App.

## 8. Zuhör-Geste (Avatar)
`<video id="zuhoer-geste">` liegt in `.avatar-portrait` direkt über `#avatar-video` (gleiche Lage, contain, ohne transform/Maske).
Clip `public/avatar/mitano-zuhoeren.webm|.mp4` (2,1 s, stumm, aus dem Live-Strom aufgenommen: Kopf neigen + „Mhm?“-Blick, vor und zurück).
Startet automatisch beim Wechsel `data-avatar` spricht → zuhoeren/unterbrochen (einmal pro Phase), Klasse `.an` = sichtbar (150 ms Blende),
bei `spricht` sofort weg. Nur bei Mitano.-Avataren mit Live-Bild 1088×704. Design: bitte Glow/Lichtsaum nicht von #zuhoer-geste abhängig machen.

## 11. Audio-Sitzung iPhone / Ton-Vergleich (iOS-Agent)
- Plugin `@capgo/capacitor-speech-recognition` ist gepatcht (`ios-app/patches/`, `postinstall: patch-package`): Audio-Sitzung einmal
  `playAndRecord` + `[defaultToSpeaker, allowBluetoothA2DP, mixWithOthers]`, Modus nur bei Bedarf, `setActive(true)` einmal, **nie** `setActive(false)`.
- Modus per Web-App wählbar, ohne neuen Build: `?ton=voicechat` bzw. `?ton=default` an die Adresse hängen (wird in `localStorage`
  `mitano-tonmodus` gemerkt). Diagnose: `sprache:stt … start=ok … ton=<modus>`.
- Geräte-Erkennung: nur eine gleichzeitig (Start-Sperre), nach Fehlern Rückhaltung 1/2/4/8/15 s (`sprache:ruhe erkennung <fehler> folge=<n>`),
  kein (Neu-)Start, während mitano. spricht.
