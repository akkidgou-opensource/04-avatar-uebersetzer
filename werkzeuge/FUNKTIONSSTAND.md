# Funktionsstand Mitano. – Demo (Port 3000)

Stand: 28.11.2026, 09:31–09:40 Uhr. Getestet vom Test-Agenten, **nur getestet, kein Code geändert, Demo nicht neu gestartet**.
Code der Demo ist identisch mit der Entwicklung (server.js, index.html, rag.js, gedaechtnis.js geprüft).
Werkzeuge: Chrome headless (402×874, Touch) mit abgefangenem Avatar-Start (keine D-ID-Kosten), Server-Routen direkt,
Gesprächsinhalte über den gleichen Wissensspeicher wie der Server, Simulator „iPhone 18 Pro“.
D-ID-Guthaben: 169,25 (09:31) → 164,75 (09:38). Der Rückgang stammt von einem **gleichzeitig laufenden echten Gespräch**
auf der Demo (Server-Log 09:35), nicht von diesem Test.

## Zusammenfassung (einfache Sprache)

Fast alles funktioniert: Anmelden, Einrichtung, Unterlagen, Zeitstrahl, Hochladen, Löschen, Einstellungen und das Gedächtnis.
Es werden **nur die fünf Sprachen angezeigt, für die es Mitano. gibt** (Deutsch, Englisch, Französisch, Türkisch, Arabisch) –
keine ausgegrauten „bald verfügbar“-Kacheln mehr. Die Fragen aus den Unterlagen werden jetzt richtig beantwortet
(Herzinfarkt im September 2026, Leber-Medikamente mit „keine ACE-Hemmer“, auch auf Arabisch).
Probleme: Die „einfache Sprache“ braucht fast eine Minute und klingt noch wie ein Arztbrief („Liebe Kollegin …“), und
um 08:23 schlugen kurz alle Claude-Anfragen fehl (jetzt wieder in Ordnung).
Die Hörprobe mit Avatar (Ende-zu-Ende) habe ich nicht gemacht, weil gerade jemand live mit der Demo sprach.

## Tabelle

| Feature | Status | Beleg | Problem/Ursache (Datei:Funktion) | Vorschlag |
|---|---|---|---|---|
| Anmeldung + Einwilligung | ✅ | Ohne Haken keine Anmeldung; mit Haken → Einrichtung (demo) bzw. Gespräch (admin). Prototyp-Hinweis sichtbar | – | – |
| Abmelden | ✅ | Zurück zur Anmeldung, `/api/me` → 401 | – | – |
| Sitzung nach Server-Neustart | ✅ (nachgelesen) | server.js: Anmeldungen in `lokal/sitzungen.json` (nur Prüfsumme), werden beim Start übernommen; in der Nacht auf Dev mehrfach erlebt | – | – |
| Einrichtung: Avatar | ✅ | Nur „mitano.: Dein Begleiter Mitano. – erklärt dir deine Unterlagen und hört dir zu.“ (Bild `10-einrichtung.png`) | – | – |
| Einrichtung: nur vorhandene Sprachen | ✅ | Kacheln: Deutsch / English / Français / Türkçe / العربية; kein „bald verfügbar“. `/api/avatare` sprachen = de,en,fr,tr,ar; `/api/profil` alle `verfuegbar:true` | – | – |
| Einstellungen → Sprache | ✅ | Gleiche 5 Sprachen, kein „bald“. Wechsel: „Gespeichert: English. Gilt ab der nächsten Verbindung.“ + „Jetzt in der neuen Sprache verbinden“ | – | – |
| Stimmen bei Sprache ≠ Deutsch | ⚠️ | Bei Englisch: „Für diese Sprache gibt es noch keine weiteren Stimmen.“ (gut, Bild `10-stimmen-en.png`). **Direkt nach dem Sprachwechsel** stehen aber noch die 4 deutschen Stimmen da – erst nach erneutem Öffnen richtig. Gespeicherte Stimme „harper“ + Englisch → Server nimmt Standardstimme (`/api/stimmen`: standard) | index.html:speichereSprache (zeigeStimmen nicht neu aufgerufen) | Nach Sprachwechsel Stimmenliste neu laden |
| Hauptbildschirm: Schreiben, Unterlagen-Knopf mit Zahl, Zahnrad | ✅ | „Schreiben“, „Zuhören starten“, „Meine Unterlagen öffnen (15)“; Tippfeld öffnet/schließt | – | – |
| Hauptbildschirm: Stopp | ✅ | Nur sichtbar/aktiv, während Mitano. spricht | – | – |
| Hauptbildschirm: Mikrofon ohne Verbindung | ⚠️ | Ohne Avatar startet die Browser-Spracherkennung („Hört zu …“) – das Gesagte kann danach nur als Text beantwortet werden | index.html: Mikro-Knopf (startHoeren) | ok für Rückfall; evtl. Hinweis „Mitano. ist nicht verbunden“ |
| Verbindungsfehler + „Nochmal versuchen“ | ✅ | „Ich konnte mich gerade nicht verbinden. Prüf kurz dein Internet und versuch es nochmal.“ + Knopf „Nochmal versuchen“ | – | – |
| Unterlagen: Zeitstrahl | ✅ | admin: 157 Ereignisse, Jahre 2027…2003; Ereignis → „Dokument öffnen“ springt in den Text mit Markierung | – | – |
| Unterlagen: Dokumente, Original/Text | ✅ | 15 Briefe; Text-Briefe zeigen „liegt als Textdatei vor“, Text-Tab 5548 Zeichen | – | – |
| „In einfache Sprache übersetzen“ | ⚠️ | Funktioniert (kein Fehler mehr), **Dauer 49 s**; Ergebnis beginnt „Liebe Kollegin, wir berichten dir über unseren gemeinsamen Patienten, Herrn Osler …“ – Brief wird umformuliert statt der Patientin erklärt | server.js /api/uebersetzen (Prompt-Grundlage gespraech.md, langer Text in einem Stück) | Team: Aufgabe „erkläre der Patientin“ klären; Ausgabe streamen oder kürzer |
| Vorlesen | ⚠️ | Ohne Avatar-Verbindung inaktiv (erwartet); mit Avatar nicht geprüft | – | – |
| Umbenennen | ✅ | Formular mit Titel + Datum, Abbrechen ok (Speichern in der Nacht auf Dev geprüft) | – | – |
| Hochladen (demo, kleine .txt) + Löschen | ✅ | Hochgeladen in < 2 s, „wird ausgewertet …“; Löschen zweistufig ok | Hinweis: demo hatte schon 3 Scans aus einem früheren Test; Login setzt nur die Einrichtung zurück, nicht die Unterlagen | – |
| Scannen-Rückfall im Browser | ✅ | Im Browser öffnet „Scannen“ die Kamera/Dateiauswahl (Dev-Test); auf der Demo war die Liste nicht leer, daher der Knopf „Scannen“ statt Leer-Zustand | – | – |
| Demo zurücksetzen (als demo) | ✅ | „Demo zurückgesetzt.“ – Unterlagen leer | demo hat Admin-Rechte (bewusst) | – |
| Ton aus/ein, Gesprächsprotokoll | ✅ | Schalter reagiert; Protokoll-Sheet „Noch kein Gespräch in dieser Sitzung.“ | – | – |
| „Was Mitano. über dich weiß“ | ✅ | admin: „121 Angaben aus deinen Unterlagen anzeigen“, „Alles vergessen“; demo: „Ich kenne dich noch kaum. Erzähl mir einfach von dir …“ | – | – |
| Anweisung (admin) | ✅ | Textfeld 2216 Zeichen, „Aktiv · Modell: claude-sonnet-5-5 · Quelle: aus der Projektdatei“ | – | – |
| Datenschutz | ✅ | Abschnitt vorhanden mit Prototyp-Satz und Anbietern | – | – |
| Server wechseln | ✅ | Im Browser unsichtbar (nur iPhone-App) | – | – |
| Quellen-Knopf + Quellen-Fenster | ✅ | Liste → Volltext (Arztbrief 12.9.2026, 3059 Zeichen) | – | – |
| Wischgesten | ✅ | Zweimal Rand-Zurück: Dokument → Liste → Gespräch | – | – |
| Weiche: Smalltalk → nativ | ✅ | „Hallo, wie geht es dir?“, „How are you today?“, „Bugün nasılsın?“ → nativ (smalltalk), 0,5–1,4 s | – | – |
| Weiche: Unterlagen / Gedächtnis / App → claude | ✅ | Herzinfarkt → unterlagen; „Wie heißt mein Hausarzt?“ → gedaechtnis; „Wie lade ich einen Brief hoch?“, „Wo stelle ich die Stimme um?“, „How can I delete a document?“ → app; en/fr/ar-Medikamentenfragen → unterlagen | – | – |
| Weiche: ernste Frage | ⚠️ | „Ich habe Angst vor der OP morgen.“ → nativ (D-ID-KI antwortet, nicht Claude) | server.js waehleWeg | Team entscheiden, ob Gefühls-/Angstthemen über Claude laufen sollen |
| Antwort: Herzinfarkt | ✅ | „vom 03.09. bis 12.09.2026 stationär … Stent eingesetzt“, Quelle Fabry (Suchbegriffe NSTEMI usw. in 2,5 s) | kleine Unschärfe: „bei uns“ (spricht wie die Klinik) | – |
| Antwort: Leber-Medikamente | ✅ | Bifiteral, Pantozol 40, Aldactone 100, Unat 5, Protaphane 30/70 6 IE, „keine ACE-Hemmer!“ – Quelle Osler | – | – |
| Antwort auf Arabisch | ✅ | gleiche Liste auf Arabisch, Quelle Osler | – | – |
| Smalltalk mit Witz / ernst ohne Witz | ✅ (Claude-Weg) | Otter-Humor, Arztwitz auf Wunsch, keine Emojis; OP-Angst einfühlsam ohne Witz. Echtbetrieb: diese Fragen gehen an die D-ID-KI (nicht geprüft) | – | – |
| Claude-Zugang | ⚠️ | Demo-Log 08:23: alle Claude-Anfragen „Status 400, invalid_request_error“ (Weiche, Suchbegriffe, Antwort, Gedächtnis) → „Fehler nach 0 Sätzen“. Ab 09:31 wieder ok (Test-Aufruf Sonnet/Haiku 200) | vermutlich Anthropic-Konto (Guthaben/Limit) zeitweise – Ursache im Log nicht erkennbar | Anthropic-Konto/Guthaben prüfen; Fehlermeldung für Patienten prüfen |
| Inhalte im Log | ✅ | Testtexte nicht im Demo-Log gefunden | – | – |
| iOS-App im Simulator | ✅ | App „Mitano.“ startet, findet den Server über den Wegweiser, Anmeldeseite lädt (Bild `sim-app2.png`); nicht angemeldet (würde D-ID verbinden), App danach beendet | – | – |
| Ende-zu-Ende mit Avatar | ❓ nicht getestet | Zum Testzeitpunkt lief ein echtes Gespräch auf der Demo (Log 09:35, Guthaben sinkt) – keine eigene Sitzung gestartet, um nicht zu stören | – | Probe auf Freigabe nachholen |

Bilder: Scratchpad des Test-Agenten (`shots/10-*.png`, `11-einfach.png`, `sim-app2.png`). Chrome-Profil gelöscht.

---

## Sprachen (Prüfung 28.11.2026, 10:11–10:25, Demo Port 3000, ohne Video-Sitzung)

D-ID-Guthaben vorher/nachher: 141 / 141 (keine Kosten durch diesen Test).

**Wichtig vorab:** Der native Weg (Smalltalk, Gefühle, Freihand-Spracherkennung durch D-ID) lässt sich **ohne Video-Sitzung nicht
prüfen**. Die D-ID-Text-Chat-REST-API lehnt Nachrichten an diese V2-Agenten ab: `400 BadRequestError „StreamId and sessionId are required“`.
Darum sind a) und die Freihand-Erkennung nur über die Agent-Einstellungen bewertet, nicht über echte Antworten.

| Sprache | a) D-ID-Agent (nativer Weg): Anweisung | b) Stimme des Agenten | c) Spracherkennung (Tippen aufs Mikro) | d) Claude-Weg + Überbrückung + „mehr?“ | Gesamt |
|---|---|---|---|---|---|
| Deutsch (de) | ✅ eigener Agent, Grundanweisung deutsch, Begrüßung deutsch | ✅ de-DE-Grant (+ Harper/Mia/Klaus nur de) | ✅ iOS-Plugin `de-DE`, Chrome Web Speech `de-DE` | ✅ Herzinfarkt richtig (Fabry), App-Frage richtig; Überbrückung + „Soll ich dir mehr dazu erzählen?“ deutsch; „ja/gerne“ erkannt | ✅ freigeben |
| Englisch (en) | ⚠️ Agent „mitano. (EN, v2)“, Begrüßung + App-Teil englisch, **aber ohne Zeile „Antworte immer auf Englisch“** (fr/tr/ar haben sie); Grundanweisung ist deutsch → Risiko deutscher Antworten im nativen Weg | ✅ en-GB-Harry (britisch) | ✅ `en-US` (Apple + Chrome unterstützt) | ✅ richtige Antwort + Quelle, kein Deutsch; Überbrückung englisch; „Shall I tell you more about it?“; „yes/sure/please“ erkannt | ⚠️ freigeben, Agent-Anweisung um „Antworte immer auf Englisch.“ ergänzen |
| Französisch (fr) | ✅ „Antworte immer auf Französisch.“, Begrüßung französisch | ✅ fr-FR-Harper | ✅ `fr-FR` | ✅ richtig (NSTEMI, Stent, Quelle Fabry); Überbrückung französisch; „Tu veux que je t’en dise plus ?“; „oui/vas-y/bien sûr“ erkannt | ✅ freigeben |
| Türkisch (tr) | ✅ „Antworte immer auf Türkisch.“, Begrüßung türkisch | ✅ tr-TR-Grant | ✅ `tr-TR` | ✅ richtig, Quelle Fabry; Überbrückung türkisch; „Sana biraz daha anlatayım mı?“; „evet/anlat/devam“ erkannt | ✅ freigeben |
| Arabisch (ar) | ⚠️ „Antworte immer auf Arabisch.“, Begrüßung arabisch – aber Grundanweisung deutsch; die frühere Mischung mit Deutsch ist ohne Video-Sitzung nicht nachprüfbar | ✅ ar-SA-HamedNeural (ältere Stimmen-Generation als die anderen, klingt evtl. anders) | ✅ `ar-SA` (Apple + Chrome unterstützt) | ✅ Antwort arabisch (83 % arabische Schrift, Rest Datum/„NSTEMI“), Quelle Fabry; Überbrückung arabisch; App-Antwort arabisch mit deutschen Knopfnamen in Anführung. ⚠️ „mehr?“: „نعم“ wird erkannt, **„نعم، من فضلك“ (arabisches Komma) und „أخبرني المزيد“ nicht** | ⚠️ freigeben mit Hinweis; vor der Demo eine kurze Sprechprobe |

**Weitere Befunde**
- Die **App-Oberfläche ist nur deutsch** (Knöpfe, Meldungen). Mitano. erklärt die Knöpfe in jeder Sprache mit den deutschen Namen + Übersetzung in Klammern – das funktioniert.
- **Freihand** (Mikro einmal antippen, verbunden) nutzt die Spracherkennung von D-ID im Video-Raum, nicht Apple/Google. Welche Sprache sie erkennt, hängt am Agenten. Ohne Video-Sitzung ist das nicht prüfbar.
- **Mehrere Stimmen** (Harper/Mia/Klaus) gibt es nur auf Deutsch. Bei anderer Sprache zeigt die App „Für diese Sprache gibt es noch keine weiteren Stimmen.“ und nimmt die Standardstimme (siehe Tabelle oben).
- Technik-Notiz: Die „mehr?“-Erkennung (`server.js:MEHR_JA_RE`) endet mit `[\s,.!?]` und kennt kein arabisches Komma „،“ / Fragezeichen „؟“. Die „Nein“-Prüfung mit `\b…لا\b` greift bei arabischer Schrift nie.

**Empfehlung:** Alle fünf Sprachen bleiben freigegeben (de, fr, tr ✅; en, ar ⚠️). Zwei kleine Nachbesserungen vor der Vorführung:
(1) In der D-ID-Anweisung des EN-Agenten die Zeile „Antworte immer auf Englisch.“ ergänzen (wie bei fr/tr/ar).
(2) In `MEHR_JA_RE` arabisches Komma/Fragezeichen zulassen.
Falls Guthaben dafür da ist: je **eine 20-s-Sprechprobe in en und ar** (Smalltalk über den nativen Weg), weil nur das die frühere Deutsch-Mischung sicher ausschließt.
