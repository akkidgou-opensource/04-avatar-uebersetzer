# QA-Durchgang Nachtschicht (Entwicklung, Port 3210)

Stand: 28.11.2026, 00:15–00:47 Uhr. Getestet vom Test-Agenten, **ohne Code-Änderung**. Andere Agenten haben parallel
gearbeitet; der Server wurde während der Tests mehrfach neu gestartet (00:21:54, ~00:23:20, ~00:26, ~00:40).

**Werkzeuge:** Chrome headless über DevTools-Protokoll, 402×874, Touch-Emulation, echte Touch-Ereignisse
(Tippen, Wischen); Stichprobe Simulator „iPhone 18 Pro“ (Safari, http://localhost:3210). Gesprächsqualität
zusätzlich ohne D-ID direkt über den Wissensspeicher (`rag.antworteMitQuellen`, gleicher Prompt `prompt/gespraech.md`).
Testskripte: Scratchpad des Test-Agenten (`run.mjs`, `t01…t08*.mjs`, `qualitaet.cjs`).

**D-ID-Guthaben:** 202,75 (00:15) → 180,75 (00:40). Verbraucht: 3 Sitzungen + 1 Neuverbinden (Stimme) + 2 stille
Neuverbindungen nach Server-Neustarts + 1 abgebrochener Verbindungsaufbau. Danach wegen neuer Budget-Regel keine D-ID-Tests mehr.

**Sicherheit/Regeln:** Keine Gesprächsinhalte im Server-Log gefunden (Suche nach Fragewörtern in /tmp/akki.log: 0 Treffer).
Prototyp-Hinweis steht auf der Anmeldeseite und in den Einstellungen. Ohne `X-Requested-With` → 403, zu große Anfrage → 413,
ohne Einwilligung → 400 mit verständlicher Meldung.

---

## 1. Inventar der Bedienelemente (public/index.html)

| Bereich | Elemente / Abläufe |
|---|---|
| Anmeldung | Benutzername, Passwort, „Mehr anzeigen/Weniger anzeigen“ (details), Einwilligungs-Haken, Anmelden, Fehlermeldung |
| Einrichtung | Avatar-Karte(n) (radio), 5 Sprachen (de/en/fr/tr/ar, ar als RTL), „Los geht’s“, Abmelden |
| Hauptbildschirm | Status-Pille, Modus-Zeile, „Ton einschalten“, „Quellen (n)“, Zahnrad, Toast, Schreiben (Stift) → Tippfeld (Senden, Schließen, Esc), Mikrofon (V2: Freihand an/aus; sonst einmal zuhören), Unterlagen (mit Zahl), Stopp |
| Gesten | Rand-Zurück-Wischen (Sheet, Dokument, Unterlagen; nicht im Zoom), Sheet nach unten wischen (Kopf / Inhalt oben), Zurückfedern bei kurzem Wisch |
| Unterlagen | Zurück, Zeitstrahl/Dokumente, Ereignis antippen (Detail mit Zitat, „Dokument öffnen“ → Sprung mit Markierung), leerer Zustand (Scannen/Datei), Scannen (Capacitor-Scanner, im Browser Rückfall auf Kamera-Input), Datei hochladen (mehrere), Fortschrittszeilen, Liste je Dokument: öffnen/umbenennen/löschen |
| Dokument | Zurück, Original/Text/Einfach, Seitenbild → Zoom (Tippen = groß, Schließen), „Im Zeitstrahl“, Umbenennen (Titel+Datum, Speichern/Abbrechen), Löschen zweistufig (5 s), Übersetzen, Vorlesen |
| Quellen-Sheet | Liste, Eintrag → Volltext mit Markierung, „Zurück zur Liste“, Schließen |
| Protokoll-Sheet | Verlauf, Protokoll leeren |
| Einstellungen | Weiter zuhören, Ton des Avatars, Protokoll ansehen, Neu beginnen, Avatar, Stimme (4) + Probehören, Sprache (5) + „Jetzt in der neuen Sprache verbinden“, Anweisung (Admin: Textfeld, Zähler, Speichern, Zurücksetzen), Datenschutz, Demo zurücksetzen (nur Rolle admin), Nutzer verwalten (admin), Abmelden |
| Hintergrund | Pausieren nach D-ID-Leerlauf, stilles Neuverbinden beim nächsten Satz, pagehide → Stop |

---

## 2. Ergebnisse

Schwere: **blockierend / hoch / mittel / niedrig**. „ok“ = wie erwartet.

| Nr | Uhrzeit | Bereich | Schritt | erwartet | tatsächlich | Schwere | vermutete Ursache (Datei:Funktion) | zuständig |
|---|---|---|---|---|---|---|---|---|
| 1 | 00:24–00:36 | Gespräch/Wissen | „Wann war ich wegen dem Herzinfarkt im Krankenhaus?“ (admin, p2) | Fabry-Brief: NSTEMI, stationär 03.09.–12.09.2026, Stent RCA | Live und offline: „Ein Herzinfarkt taucht … nirgends auf“. Quellen: Brief 23.2.2020 (falsch). BM25 findet „Herzinfarkt“ ≠ „NSTEMI“ nicht | **hoch** | rag.js:suche (rein wörtlich), server.js:553 `RAG_ERWEITERN_STANDARD='aus'` | agentic-dialog |
| 2 | 00:27 / 00:36 | Gespräch/Wissen | „Welche Medikamente soll ich nach dem Aufenthalt wegen der Leber nehmen?“ | Osler-Brief 10.11.2026: Bifiteral 1-0-1, Pantozol 40 0-0-1, Aldactone 100 1-0-0, Unat 5 1-0-0, Protaphane 30/70 0-0-0-6 IE, KEINE ACE-Hemmer | Live: Quellen Brief 10.2.2022 (Xavier, Leberbestrahlung). Offline: „finde keine Entlassmedikation“, Quellen Fabry/Alzheimer. Osler wird nicht gefunden | **hoch** | rag.js:suche (Suchbegriff „Leber“ vs. „Leberzirrhose/hepatisch“) | agentic-dialog |
| 3 | 00:36 | Gespräch/Wissen | Abfrageerweiterung eingeschaltet (`erweitern:true`, 1200 ms) | Zusatzbegriffe (z. B. NSTEMI, Zirrhose) | Jede Erweiterung: „Abfrageerweiterung ohne Ergebnis (Zeitlimit)“ → gleiches falsches Ergebnis | **hoch** | rag.js:erweitereAnfrage – Zeitlimit 1,2 s zu kurz (Haiku braucht länger) | agentic-dialog |
| 4 | 00:36 | Gespräch/Wissen | Frage auf Arabisch „Medikamente nach Leberproblem?“ | Antwort aus Osler-Brief | Keine passende Quelle („kann ich nicht belegen“); fremdsprachige Fragen finden in deutschen Briefen nichts | **hoch** (für en/fr/tr/ar) | rag.js:suche – Frage wird nicht ins Deutsche übertragen | agentic-dialog |
| 5 | 00:28 | Gespräch | „Darf ich dabei einen ACE-Hemmer nehmen?“ | „Nein, KEINE ACE-Hemmer!“ + Grund, Quelle Osler | Richtig, mit korrekter Medikamentenliste und Quellen (Entlassungsbrief 10.11.2026). Weg laut Log: claude (vorfilter, gedaechtnis) | ok | – | – |
| 6 | 00:36 | Gespräch | Folgefrage „Was wurde da genau am Herzen gemacht?“ / „Und was war danach?“ | Bezug zur vorigen Frage | Offline richtig (Katheter 4.9.2026, Stent RCA; danach Langzeit-EKG, Entlassung 12.9.2026, Medikamente) und korrigiert sich selbst („NSTEMI … fälschlich nirgends gefunden“). Live (Herz-Frage): Brief 2020 statt Fabry, weil F1 schon falsch | mittel (Folge von Nr. 1) | wie Nr. 1 | agentic-dialog |
| 7 | 00:36 | Gespräch/Gedächtnis | „Ich heiße Max und gehe gern wandern.“ → „Wie heiße ich nochmal …?“ | Name und Hobby aus dem Gespräch | Richtig („Max, wandern – aus unserem Gespräch, nicht aus den Unterlagen“) | ok | – | – |
| 8 | 00:36 | Gespräch | 2021 Kopf-Diagnose; Chemotherapie Melanom | Vogler: TIA 2.10.2021, V. a. Mikroangiopathie; König: Carboplatin (9. Zyklus), vorher DTIC | Beide richtig mit passenden Quellen | ok | – | – |
| 9 | 00:36 | Gespräch/Ton | Smalltalk „Ich heiße Max …“ | kurze lockere Antwort | Lenkt ungefragt auf Ramipril/ACE-Hemmer („lass bitte deine Ärztin klären …“) – wirkt belehrend, nicht locker | mittel | prompt/gespraech.md bzw. Gedächtnis-Zusatz im Systemprompt (keine medizinische Änderung durch Test) | agentic-dialog (Team entscheidet) |
| 10 | 00:24 / 00:36 | Gespräch | Antworttext | keine Technik-Interna | „Die Entlassungsberichte … liegen mir nur als Titel vor, ohne Inhalt“, „in den Auszügen“ – verwirrt Patienten | mittel | rag.js:baueAnfrage (Dokumentliste nur mit Titel im Prompt) | agentic-dialog |
| 11 | 00:17 / 00:23 | Gespräch nativ | „Hallo Mitano, wie geht es dir?“ | kurze natürliche Antwort | „Hallo, wie kann ich dir helfen? Mir geht es gut, danke. … Das wärs erstmal von mir – hast du noch weitere Fragen oder Wünsche?“ (Reihenfolge holprig, Floskel) | niedrig | D-ID-Agent-Anweisung (nativer Weg) | agentic-dialog / avatar |
| 12 | 00:23–00:28 | Zeiten | Zeit bis Ton | < 2–3 s | Claude-Weg: erster Satz serverseitig 1,1–2,4 s, im Browser „spricht“ nach 1,3–2,6 s; nativ: Ton nach 0,5–2,6 s (Log). Nach Server-Neustart: 11,7–12,8 s (stilles Neuverbinden). Antworten 320–670 Zeichen, gesprochen 14–60 s | mittel (lange Antworten) | prompt/gespraech.md (Länge) | agentic-dialog |
| 13 | 00:35 | Gespräch | Antworttext im Protokoll bei F4/F5 | Text vorhanden | Protokoll leer, nachdem der Server neu gestartet wurde (Protokoll nur im Arbeitsspeicher) | niedrig | server.js: roh.protokoll nur im Speicher | backend-auth |
| 14 | 00:18 | Unterlagen/Einfach | Dokument → „Einfach“ → „In einfache Sprache übersetzen“ | Erklärung in einfacher Sprache | 503: „Der System-Prompt fehlt noch. Bitte die Regeln aus spec.md wortgetreu in prompt/system.md einfügen …“ – Kernfunktion aus, Meldung für Patienten unverständlich | **hoch** | prompt/system.md ist Platzhalter (Team muss füllen); index.html:uebersetzen zeigt Rohtext | Team / agentic-dialog; Meldung: design-ux |
| 15 | 00:18 | Unterlagen | Ereignis → „Dokument öffnen“ (Sprung mit Markierung) | Dokument-Ansicht ohne Zeitstrahl-Reste | Sprung + Markierung ok, **aber** die Jahresmarken „2027“/„2026“ des Zeitstrahls schweben über dem Brieftext | mittel | index.html CSS `.zs-jahr-titel` (sticky, z-index) über `#ul-dok` | design-ux |
| 16 | 00:17 | Hauptbildschirm | Freihand an → Toast „Ich höre zu …“ | Toast lesbar | Stopp-Pille liegt über dem Toast-Text („Mikrofon antipper[n]“ verdeckt) | mittel | index.html CSS `.toast` / Stopp-Position | design-ux |
| 17 | 00:17 | Hauptbildschirm | Freihand aus | Hinweis „Ich höre zu“ verschwindet | Toast bleibt bis zum Timeout stehen, obwohl Freihand aus ist | niedrig | index.html:freihandAus (toast nicht geleert) | ios |
| 18 | 00:17 | Hauptbildschirm | Nach „Los geht’s“ (Tippen) spricht Avatar | Ton an | In Chrome erscheint „Ton einschalten“, obwohl getippt wurde; am iPhone nicht geprüft (Budget) | niedrig (prüfen) | index.html:videoAbspielen / oberflaeche | avatar |
| 19 | 00:22–00:28 | Stabilität | Server-Neustart während Sitzung | Anmeldung bleibt, Avatar verbindet still neu | Klappt: Anmeldungen werden übernommen, nächste Nachricht → 409 → stilles Neuverbinden, Antwort kommt (11–13 s). Jeder Neustart kostet eine D-ID-Sitzung | ok / mittel (Wartezeit) | – | backend-auth (Neustarts bündeln) |
| 20 | 00:37 | Stabilität | Sitzung verloren (Cookie weg) → Zahnrad | zurück zur Anmeldung mit Hinweis | Zurück zur Anmeldung, aber **ohne** Hinweis (Meldung leer) | niedrig | index.html:api → zeigeLogin (keine Meldung) | design-ux |
| 21 | 00:35 | Stabilität | Viele Test-Anmeldungen | eigene Sitzung bleibt | Meine admin-Sitzung war plötzlich 401 (40 übernommene Anmeldungen; je Nutzer max. 20, älteste fällt weg) – betrifft nur Testbetrieb mit vielen Agenten | niedrig | server.js:startSession (20 je Nutzer) | backend-auth |
| 22 | 00:18 / 00:37 | Netzfehler | /api/avatar/start schlägt fehl (Netz) | verständliche Meldung + Weg zum erneuten Versuch | Toast „Keine Verbindung zum Server.“, Status „Nicht verbunden“; kein „Erneut versuchen“, Text verschwindet nach 12 s; Senden danach: Nachricht verschwindet, nur kurzer Toast | mittel | index.html:avatarVerbinden / sendeNachricht | avatar / design-ux |
| 23 | 00:37 | Netzfehler | /api/unterlagen + /api/zeitstrahl → 500 | Fehlermeldung, Liste bleibt | Meldung zeigt Rohtext des Servers; zusätzlich „Noch keine Unterlagen – Scanne deinen letzten Arztbrief“ (falsch für admin mit 15 Briefen). Netzfehler: „Keine Verbindung zum Server.“ ok | mittel | index.html:ladeUnterlagen / zeigeTab (leer-Zustand bei Fehler) | design-ux |
| 24 | 00:16 | Anmeldung | leer / ohne Haken / falsches Passwort | Browser-Pflichtfeld / Hinweis / Meldung | ok („Anmeldung nicht möglich. Bitte Eingaben prüfen.“) | ok | – | – |
| 25 | 00:16 | Anmeldung | „Mehr anzeigen“ zweimal tippen | auf/zu, Text wechselt | ok | ok | – | – |
| 26 | 00:16 | Anmeldung | Layout Datenschutz-Kasten | Überschrift abgesetzt | „Wichtig zum Datenschutz  Für diese Demo …“ läuft ohne Doppelpunkt/Umbruch in den Satz | niedrig | index.html Markup `.datenschutz-kurz` | design-ux |
| 27 | 00:16 | Einrichtung | Sprache wählen, Avatar wählen, „Los geht’s“ doppelt tippen | eine Verbindung | ok (zweites Tippen ins Leere, nur eine Verbindung). Bereit nach 8,7 s | ok | – | – |
| 28 | 00:16 | Einrichtung | Avatar-Beschreibung | patientengerecht | „Gesicht und Stimme von D-ID, Antworten von Claude auf Basis deiner Unterlagen.“ – technisch | niedrig | server.js /api/avatare (beschreibung) | design-ux |
| 29 | 00:17 | Hauptbildschirm | Mikrofon: an, aus, doppelt schnell | Freihand an/aus, Doppeltipp = aus | ok (aria-pressed/Label passen) | ok | – | – |
| 30 | 00:17 | Hauptbildschirm | Tippfeld: leer senden, 1200 Zeichen, Umlaute/Arabisch/HTML | leer ignoriert, max. 1000, Text sicher angezeigt | ok (maxlength 1000; Server max. 2000 → 400 mit Meldung; HTML wird als Text angezeigt) | ok | – | – |
| 31 | 00:17 | Hauptbildschirm | Stopp während Antwort | sofort still, „Bereit“ | ok | ok | – | – |
| 32 | 00:39 | Gesten | Zurück-Wischen in Unterlagen, während der Avatar spricht | Unterlagen zu, Avatar spricht weiter | ok | ok | – | – |
| 33 | 00:18 | Gesten | Rand-Wischen Dokument → Liste → Gespräch; kurzer Wisch; Wisch im Zoom | schließt je Ebene; federt zurück; im Zoom nichts | ok | ok | – | – |
| 34 | 00:21 | Gesten | Sheet am Kopf nach unten wischen; Rand-Wischen im Einstellungen-Sheet | schließt | ok | ok | – | – |
| 35 | 00:18 | Unterlagen | Zeitstrahl/Dokumente umschalten, Ereignis auf/zu | ok | ok (15 Dokumente) | ok | – | – |
| 36 | 00:20 | Unterlagen (demo) | 5 Dateien gleichzeitig: 2× .txt (eine mit Umlaut-Namen), .docx, leere .txt, Foto .png | 3 ok, 2 verständliche Fehler, Fortschritt | ok: „Fertig: …“, „Diese Dateiart geht nicht …“, „Der Text ist leer.“; Foto gelesen (OCR korrekt), 3,2 s gesamt; Zeitstrahl nach ~20 s (23 Ereignisse) | ok | – | – |
| 37 | 00:20 | Unterlagen | Scannen im Browser | Rückfall Kamera/Datei | ok (Kamera-Input wird geöffnet) | ok | – | – |
| 38 | 00:20 | Dokument | Original-Bild → Zoom → groß → Schließen | ok | ok | ok | – | – |
| 39 | 00:20 | Dokument | Umbenennen mit „Ümläut – عربي <b>x</b>“ | sicher gespeichert | ok (als Text, kein HTML) | ok | – | – |
| 40 | 00:20 | Dokument | Umbenennen erneut öffnen | leere Meldung | alte Meldung „Gespeichert.“ steht noch; nach Löschen ebenfalls | niedrig | index.html:dok-umbenennen (meldung nicht geleert) | design-ux |
| 41 | 00:20 | Dokument | Löschen zweistufig, 5 s warten | Knopf kehrt zurück; 2. Tippen löscht | ok | ok | – | – |
| 42 | 00:21 | Einstellungen | Inhalte als admin | alle Gruppen | ok: 4 Stimmen, 5 Sprachen, Anweisung (1711 Zeichen, Zähler, Speichern erst nach Änderung), Datenschutz, Demo zurücksetzen, Nutzer verwalten | ok | – | – |
| 43 | 00:21 | Einstellungen | Inhalte als demo | eingeschränkt? | demo ist **Administrator**: darf Anweisung ändern, Nutzer anlegen/löschen (auch admin), Demo zurücksetzen. Laut server.js:190 bewusst („für die Demo“) | mittel (Risiko bei Vorführung) | server.js:190 | backend-auth (Team entscheidet) |
| 44 | 00:21 | Einstellungen | Ton aus/an, Protokoll ansehen, Neu beginnen, Abmelden | ok | ok; Abmelden leert Felder, /api/me → 401 | ok | – | – |
| 45 | 00:21 | Einstellungen | Zähler Anweisung | Grenze passt zum Feld | Zähler zeigt „/ 20.000“, HTML-Feld hat maxlength 4000 (JS setzt maxLength nach) – ok, nur Markup veraltet | niedrig | index.html `#sp-text maxlength` | design-ux |
| 46 | 00:39 | Einstellungen | Sprache während des Verbindens auf en, dann zurück auf de | Hinweis nur bei echter Änderung | „Gilt ab der nächsten Verbindung“ ok; nach Rückwechsel auf de bleibt „Jetzt in der neuen Sprache verbinden“ sichtbar | niedrig | index.html:speichereSprache | ios |
| 47 | 00:39 | Einstellungen | Stimme wechseln + Probehören | neu verbinden, Probesatz | ok: bereit nach 8,8 s, Probesatz nach 10,1 s; Stimme danach per API zurückgesetzt („standard“) | ok | – | – |
| 48 | 00:39 | Randfall | Abmelden mitten im Verbinden | sauber, keine offene D-ID-Sitzung | ok (Anmeldeseite, pc=false; Stop gesendet) | ok | – | – |
| 49 | 00:39 | Stabilität | Zuhörer/Intervalle vor/nach Neuverbinden | gleich | window 9→9, document 7→7, Video 10→10, Intervalle 8→9 (verbunden), getrennt 1 → kein echtes Leck (+1 Intervall während Probehören) | ok / niedrig | – | avatar |
| 50 | 00:37 | Stabilität | 3× Unterlagen + Einstellungen auf/zu, 3× zeigeApp | keine wachsenden Intervalle | Intervalle bleiben 1; Knoten fallen nach Abmelden zurück | ok | – | – |
| 51 | 00:23–00:39 | Stabilität | Mehrere Verbindungen hintereinander | gleich schnell | 8,7 s / 8,8 s / 9,1 s / 8,8 s bis „Bereit“ | ok | – | – |
| 52 | – | Stabilität | Pausieren nach 2,5 min + stilles Neuverbinden | – | nicht gezielt getestet (Budget). Beobachtet: Status „Pausiert – sprich oder schreib einfach weiter“, nächste Nachricht verbindet still neu (11–13 s bis Ton) | – | – | avatar |
| 53 | 00:16 | Allgemein | Konsole | keine Fehler | 404 /favicon.ico; ein 404 nach „Bereit“ (Ressource unklar, vermutlich Standbild/Leerlauf); sonst nur erwartete 4xx aus Tests | niedrig | server.js (favicon fehlt) | backend-auth |
| 54 | 00:40 | iPhone-Simulator | Safari http://localhost:3210 | Anmeldeseite sauber | ok (Layout, Hinweis, Datenschutz-Kasten). Nicht angemeldet (würde D-ID verbinden) | ok | – | – |

---

## 3. Gesprächsqualität (Zusammenfassung)

Live (D-ID, admin, 00:23–00:29) und offline (gleicher Wissensspeicher, 00:36).

| Frage | Weg (Log) | Korrekt? | Quellen stimmen? |
|---|---|---|---|
| Smalltalk „Wie geht es dir?“ | nativ (smalltalk) | ja, holprig | – |
| Herzinfarkt wann? | claude (vorfilter) | **nein** (NSTEMI nicht gefunden) | nein (Brief 2020) |
| Was am Herzen gemacht? | claude | live nein / offline ja | offline ja (Fabry) |
| Und was war danach? | claude | offline ja | ja |
| Medikamente nach Leber-Aufenthalt | claude | **nein** | nein |
| ACE-Hemmer erlaubt? | claude (gedaechtnis) | ja | ja (Osler) |
| „Ich heiße Max …“ | nativ / claude | ja, aber lenkt auf Ramipril | – |
| Wie heiße ich? | claude | ja | richtig: keine Quelle |
| 2021 Kopf-Diagnose | claude | ja (TIA) | ja (Vogler) |
| Chemotherapie Melanom | claude | ja (Carboplatin, vorher DTIC) | ja (König) |
| Arabische Leber-Frage | claude | **nein** | keine |

Fazit: Wenn das richtige Dokument gefunden wird, sind die Antworten genau und gut belegt. Schwachstelle ist die
**Suche bei Alltagswörtern und anderen Sprachen** (Nr. 1–4). Das Gedächtnis (Gesprächsfakten, ACE-Hemmer-Fakt) wirkt.

## 4. Nicht getestet

- Pausieren nach genau 2,5 min (Budget), Freihand mit echter Stimme (headless ohne Mikrofon-Sprache), Vorlesen eines
  übersetzten Textes (Übersetzen ist aus, Nr. 14), Gerät „David’s Phone“.
- Simulator nur Anmeldeseite (jede Anmeldung startet sofort eine D-ID-Verbindung).

---

## 5. Schlussrunde (Regression, 28.11.2026 00:54–01:00, ohne D-ID)

Weg: Weiche über den echten Server (`POST /api/gespraech/weg`), Antwort lokal wie `server.js:ragAntwort`
(gleicher Prompt `prompt/gespraech.md`, `prompt/app-wissen.md`, Suchbegriffe über `rag.erweitereAnfrage`, Gedächtnis
über `gd.kontextFuerFrage`). Nativer Weg (D-ID-KI) ist ohne D-ID nicht prüfbar – dort ersatzweise Claude mit gleichem Prompt.
Keine D-ID-Sitzung gestartet. Chrome-Profil danach gelöscht.

| Nr | Bereich | Schritt | erwartet | tatsächlich | Ergebnis | zuständig |
|---|---|---|---|---|---|---|
| S1 | Automatik | `node --check` server.js, rag.js, gedaechtnis.js, patientendaten.js, Skriptteil index.html | ok | alles ok | bestanden | – |
| S2 | Automatik | `bash werkzeuge/server-test.sh` | grün | 48 bestanden, 0 fehlgeschlagen | bestanden | – |
| S3 | Automatik | `gedaechtnis-test.js --ohne-ki`, `patientendaten-test.js --ohne-ki`, `rag-test.js --ohne-ki --ohne-aufbau` | grün | 14/14; „Alle Prüfungen bestanden“; Suche läuft | bestanden | – |
| S4 | Unterlagen | „Wann war ich wegen dem Herzinfarkt im Krankenhaus?“ | Fabry 03.–12.09.2026, Stent RCA | Richtig („03.09.–12.09.2026 … NSTEMI … Stent an der rechten Herzkranzarterie“), Quelle Fabry. Suchbegriffe NSTEMI/Myokardinfarkt in 1,5 s | **bestanden** (vorher Nr. 1) | – |
| S5 | Unterlagen | „Welche Medikamente nach dem Aufenthalt wegen der Leber?“ | Osler: Bifiteral, Pantozol, Aldactone, Unat, Protaphane; KEINE ACE-Hemmer | Richtiger Brief (Osler), aber „keine Medikamentenliste für danach“; ACE-Hemmer nur „zu diskutieren … ob abgesetzt, geht nicht hervor“ – der Brief sagt ausdrücklich „KEINE ACE-Hemmer!“. Abschnitt „Weitere Therapie und Behandlungsvorschlag“ wird nicht gefunden | **nicht bestanden** (hoch) | agentic-dialog (rag.js:suche – Abschnitt Therapie/Entlassmedikation; Begriff „Entlassmedikation“ passt nicht auf „Weitere Therapie“) |
| S6 | Unterlagen | gleiche Frage auf Arabisch | Osler-Brief | Richtiger Brief (Osler), Antwort auf Arabisch, aber gleiche Lücke wie S5 | teilweise | agentic-dialog |
| S7 | Gedächtnis | „Mein Hausarzt heißt Dr. Test-Nacht.“ → „Wie heißt mein Hausarzt?“ | exakt | Fakt nach < 30 s gelernt; Weiche: claude (gedaechtnis); Antwort „Dein Hausarzt heißt Dr. Test-Nacht …“ (+ Hinweis auf Dr. Albers als Briefempfänger). Fakt danach per DELETE gelöscht (200, weg) | **bestanden** | – |
| S8 | App-Fragen | „Wie lade ich einen Brief hoch?“ | richtige Knopfnamen | Weiche `app`; „Meine Unterlagen“ → „Scannen“/„Datei hochladen“ – richtig, mit kleinem Otter-Witz | bestanden | – |
| S9 | App-Fragen | „Wo stelle ich die Stimme um?“ | Weiche `app`, Zahnrad → Stimme → Probehören | Weiche erkennt es **nicht** als App-Frage → `nativ` (D-ID-KI antwortet). Mit Claude ersatzweise richtig (Zahnrad, „Stimme“, „Probehören“) | teilweise (mittel) | agentic-dialog (server.js `APP_FRAGE_RE`: „stelle … um“, „Stimme um“ fehlen) |
| S10 | App-Fragen | „How can I delete a document?“ | App-Antwort | Weiche `unterlagen` statt `app` („how can i“ fehlt in `APP_FRAGE_RE`), Antwort trotzdem richtig („Meine Unterlagen“ → „Löschen“ → „Wirklich löschen?“) | teilweise (niedrig) | agentic-dialog |
| S11 | App-Wissen | Position „Stopp“ | stimmt mit Oberfläche | `prompt/app-wissen.md` sagt „ganz rechts ‚Stopp‘“; in der Leiste sind nur Schreiben, Mikrofon, Meine Unterlagen (Stopp erscheint nur beim Sprechen über dem Mikrofon) → Mitano. kann sich widersprechen | nicht bestanden (niedrig) | agentic-dialog (prompt/app-wissen.md) |
| S12 | Witze | 3× Smalltalk („Was machst du so?“, „Erzähl was Lustiges“, „Wetter mies“) | locker, gelegentlich Witz, keine Emojis | Locker, Otter-Humor, ein Arztwitz auf Wunsch, keine Emojis; 3–4 Sätze. (Echtbetrieb: Weg `nativ` → D-ID-KI, nicht geprüft) | bestanden (Claude-Weg) | – |
| S13 | Witze | „Ich habe Angst vor der OP morgen.“ | kein Witz, einfühlsam | Kein Witz, einfühlsam, Rückfrage (Weg `nativ`) | bestanden (Claude-Weg) | – |
| S14 | Kürze | „Erklär mir alles über meine Leberzirrhose.“ | ≤ 4 Sätze + Angebot | 5 Sätze, 611 Zeichen, endet mit „Soll ich dir mehr … erzählen?“ | knapp (niedrig) | agentic-dialog |
| S15 | Kürze | „ja“ → Rest | Rest der Antwort | Nicht prüfbar ohne Server-Sitzung mit Avatar (gemerkter Rest liegt nur in der Server-Sitzung) | nicht getestet | – |
| S16 | Einfache Sprache | Osler-Brief → `POST /api/uebersetzen` | 200, verständlich | 200, gut verständlich, 4 Hinweise, Anbieter-Hinweis; **53 s** Dauer. Leerer Text → 400 „Bitte zuerst einen Text einfügen.“ | bestanden (Dauer mittel) | agentic-dialog |
| S17 | Oberfläche | Login, demo-Einrichtung | ok | ok; Avatar-Beschreibung jetzt „Dein Begleiter Mitano. – erklärt dir deine Unterlagen und hört dir zu.“ | bestanden (vorher Nr. 28) | – |
| S18 | Oberfläche | Netzfehler beim Verbinden | verständlich + „Nochmal versuchen“ | „Ich konnte mich gerade nicht verbinden. Prüf kurz dein Internet …“ + Knopf „Nochmal versuchen“ | bestanden (vorher Nr. 22) | – |
| S19 | Oberfläche | Netzfehler in Unterlagen | Meldung + Nochmal, kein „Noch keine Unterlagen“ | „Gerade nicht erreichbar …“ + „Nochmal versuchen“, kein leerer Zustand | bestanden (vorher Nr. 23) | – |
| S20 | Oberfläche | Jahresmarken in Dokument-Ansicht | nicht sichtbar | 0 von 15 obenauf, Bildschirmfoto sauber | bestanden (vorher Nr. 15) | – |
| S21 | Oberfläche | „Was Mitano. über dich weiß“ (admin/demo) | sichtbar, verständlich | admin: „Aus unseren Gesprächen …“, „123 Angaben aus deinen Unterlagen anzeigen“, „Alles vergessen“; demo: „Ich kenne dich noch kaum …“, aber Knopf „0 Angaben aus deinen Unterlagen anzeigen“ | bestanden; „0 Angaben …“ niedrig | design-ux |
| S22 | Oberfläche | Quellen-Sheet → Dokument | Volltext | ok (Liste, Volltext 3059 Zeichen, keine Meldung) | bestanden | – |
| S23 | Oberfläche | Modus-Pille ohne Verbindung | nichts oder passend | „Claude aktiv“ steht unter „Nicht verbunden“ | niedrig | design-ux |
| S24 | Oberfläche | Konsole | keine Ausnahmen | 0 Ausnahmen | bestanden | – |
| S25 | Sicherheit | /tmp/akki.log nach Testtexten („Test-Nacht“, „Angst vor der OP“, „Herzinfarkt“, …) | 0 Treffer | 0 Treffer; nur „Gedächtnis: ein Eintrag vergessen.“ | bestanden | – |
| S26 | Sicherheit | Schlüssel im Seitenquelltext | keine | keine | bestanden | – |
| S27 | Ton | `V2_TON_PUFFER_MS = 400` vorhanden, Syntax ok, Seite lädt fehlerfrei | ok | ok (Knacken selbst nicht hörbar geprüft – keine D-ID-Sitzung laut Koordinator) | bestanden (ohne Hörprobe) | avatar |

**Urteil Schlussrunde:** weitgehend bestanden (22 von 27 ok). Offen: S5/S6 Leber-Medikamente (hoch), S9/S10 App-Frage-Erkennung,
S11 Stopp-Position im App-Wissen, S16 Dauer der einfachen Sprache, S15 „ja → Rest“ und die Hörprobe (Knacken) nur mit D-ID prüfbar.
