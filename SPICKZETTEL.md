# Spickzettel Avatar-Übersetzer · 8 Stunden

Acht Blöcke. Jeden Prompt in Claude Code kopieren, das Ergebnis prüfen, dann weiter. Wer schneller ist, baut frei, die „Fertig, wenn“-Punkte gelten trotzdem.

| Block | Zeit | Thema |
|---|---|---|
| 1 | 30 Min. | Setup |
| 2 | 45 Min. | Vorgaben: Zielsprache, Regeln, Beispieltexte |
| 3 | 45 Min. | Texteingabe und Anzeige |
| 4 | 60 Min. | Übersetzen und Vereinfachen |
| 5 | 75 Min. | Avatar spricht |
| 6 | 75 Min. | Qualität prüfen |
| 7 | 60 Min. | Unterlagen per Foto zusammenfassen |
| 8 | 60 Min. | Ergebnis, Demo, Pitch |

Bleiben 30 Minuten Puffer.

## Block 1 · Setup
Schlüssel eintragen: `.env.example` zu `.env` kopieren und den ausgehändigten Schlüssel eintragen (im Texteditor, nicht über Claude Code).
```
Lies README.md und CLAUDE.md. Prüfe, ob Node.js ab Version 20 installiert ist, und lege die leeren Ordner prompt und ergebnisse an. Sag mir in drei Sätzen, was als Nächstes kommt.
```
**Fertig, wenn:** Node passt und `.env` existiert.

## Block 2 · Vorgaben (ohne Code)
In `spec.md` festlegen:
- **Eine** Zielsprache, die jemand im Team sicher beherrscht
- Regeln für einfache Sprache: kurze Sätze, keine Fachwörter ohne Erklärung, nichts weglassen, nichts hinzufügen
- Was nie passieren darf: Diagnosen ändern, Dosierungen umrechnen, eigene Ratschläge ergänzen
- Drei Beispieltexte aus `daten/grascco/` auswählen, einen davon als Blind-Text beiseitelegen

**Fertig, wenn:** `spec.md` von zwei Personen gegengelesen ist.

## Block 3 · Texteingabe und Anzeige
```
Baue die Grundversion: server.js und public/index.html. Ein großes Textfeld für den Originaltext, eine Auswahl „Einfache Sprache“ oder „[Zielsprache aus spec.md]“, ein Button „Übersetzen“ und daneben ein Ausgabefeld. Original und Ergebnis stehen nebeneinander, auf dem Handy untereinander. Der Hinweis aus CLAUDE.md ist immer sichtbar.
```
**Fertig, wenn:** die Seite auf Laptop und Handy läuft (noch ohne KI).

## Block 4 · Übersetzen und Vereinfachen
```
Binde die KI an: Endpunkt POST /api/uebersetzen, der Text und Modus an die Anthropic Messages API schickt. Der System-Prompt wird bei jeder Anfrage frisch aus prompt/system.md gelesen. Übernimm die Regeln WORTGETREU aus spec.md in diese Datei. Die Antwort ist JSON mit den Feldern: text, nicht_uebersetzbare_stellen, hinweise. Schlüssel und Modell kommen nur aus .env. Fehler erscheinen als kurze deutsche Meldung.
```
**Fertig, wenn:** ein Beispieltext in beiden Modi ein Ergebnis liefert.

## Block 5 · Avatar spricht
Einfacher Weg zuerst, der 3D-Avatar ist die Kür.
```
Ergänze einen Avatar-Bereich: eine einfache gezeichnete Figur (SVG) mit Mund, der sich beim Sprechen bewegt. Der Button „Vorlesen“ liest das Ergebnis mit der Sprachausgabe des Browsers (speechSynthesis) in der passenden Sprache vor, der aktuell gesprochene Satz wird hervorgehoben. Buttons für Pause und Stopp. Wenn der Browser keine passende Stimme hat, erscheint ein verständlicher Hinweis.
```
**Fertig, wenn:** der Avatar das Ergebnis auf mindestens einem Gerät vorliest.

## Block 6 · Qualität prüfen
```
Ergänze eine Kontrollfunktion „Rückübersetzung“: Das Ergebnis wird in einer zweiten, unabhängigen Anfrage zurück ins Deutsche übersetzt und unter dem Original angezeigt, damit wir Abweichungen sehen. Markiere nichts automatisch als richtig oder falsch.
```
Jeden Beispieltext prüfen: Stimmen Diagnosen, Zahlen, Seitenangaben, Medikamente? Funde in einer Tabelle notieren, pro Durchlauf **eine** Prompt-Änderung.

**Fertig, wenn:** zwei Beispieltexte dokumentiert geprüft sind.

## Block 7 · Unterlagen per Foto zusammenfassen
```
Ergänze einen Button „Unterlage fotografieren / Bild wählen“. Das Bild wird im Browser verkleinert und an einen neuen Endpunkt /api/zusammenfassen geschickt. Die KI liefert eine Kurzzusammenfassung in höchstens fünf Punkten in einfacher Sprache und nennt, was unleserlich war. Das Bild wird nicht gespeichert.
```
**Fertig, wenn:** ein ausgedruckter Beispielbrief vom Foto zusammengefasst wird.

## Block 8 · Ergebnis, Demo, Pitch
- Blind-Text **einmal** laufen lassen, Ergebnis nicht nachbessern
- `ergebnis.md`: was geprüft wurde, gefundene Fehler, Limitationen (ein Sprachpaar, synthetische Texte, keine Prüfung durch Dolmetschende)
- Demo zweimal durchspielen, Screenshots als Backup
- Pitch: Problem, Live-Demo, wie geprüft, nächste Schritte
