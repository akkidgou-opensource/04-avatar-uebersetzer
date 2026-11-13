# 04 · Medizinischer Avatar-Übersetzer

> Prototyp für den AKKI Hackathon 2026. Nur Beispieltexte, kein Medizinprodukt, kein Ersatz für ein ärztliches Gespräch oder professionelles Dolmetschen.

**Bereich:** Aufnahme und Ambulanz

**Idee:** Ein Avatar übersetzt medizinische Inhalte in andere Sprachen oder in einfache Sprache und fasst mitgebrachte Unterlagen kurz zusammen.

**Vorschlag zur Eingrenzung:** Ein Arztbrief wird in einfache Sprache und in **eine** Zielsprache übertragen und vom Avatar vorgelesen.

## Warum
Sprachbarrieren und Fachvokabular erschweren die Aufklärung. Mitgebrachte, oft fremdsprachige oder umfangreiche Unterlagen sind zeitaufwändig zu sichten.

## Was am Ende stehen soll
- Übersetzung eines Befund- oder Aufklärungstexts in Zielsprache oder einfache Sprache
- Kurzzusammenfassung mitgebrachter Unterlagen (Text, Foto oder Scan)
- Avatar- oder Chat-Oberfläche für die Interaktion

**Erfolgskriterium:** Die Demo übersetzt oder fasst mindestens einen Beispieltext erfolgreich zusammen.

## So startet ihr
1. Oben auf **Code → Download ZIP** klicken und entpacken.
2. Im entpackten Ordner ein Terminal öffnen und `claude` eingeben.
3. `SPICKZETTEL.md` öffnen und mit Block 1 beginnen.
4. Zwischenstände hochladen: siehe `GITHUB_ANLEITUNG.md`.

## Was in diesem Repo liegt
| Datei | Wofür |
|---|---|
| `SPICKZETTEL.md` | Umsetzungsplan für 8 Stunden, Block für Block |
| `CLAUDE.md`, `AGENTS.md` | Dieselben Regeln für den Coding-Agenten (Claude Code liest die erste, Codex die zweite Datei) |
| `GITHUB_ANLEITUNG.md` | Eure Arbeit auf GitHub bringen, ohne Git-Kenntnisse |
| `daten/QUELLEN.md` | Beispieltexte, Übersetzungen und Avatar-Bausteine mit Lizenz |
| `daten/grascco/` | 62 synthetische deutsche Arztbriefe als Beispieltexte |
| `daten/multigrascco/` | Dieselben Briefe in 10 Sprachen als Vergleichsübersetzung |

## Stolpersteine
- Medizinische Genauigkeit der Übersetzung sicherstellen: Wählt eine Zielsprache, die jemand im Team prüfen kann
- Keine echten Patientendaten verwenden
- Auf ein Sprachpaar oder einen Dokumenttyp begrenzen
- Der Avatar ist Verpackung: erst muss der Text stimmen, dann kommt das Gesicht

## Für Erfahrene
- 3D-Avatar mit Lippenbewegung einbinden (siehe `daten/QUELLEN.md`)
- Rückübersetzung als Qualitätskontrolle: Zielsprache zurück ins Deutsche und mit dem Original vergleichen
- Spracheingabe für Rückfragen der Patientin oder des Patienten
