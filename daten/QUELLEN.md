# Datenquellen und Bausteine Avatar-Übersetzer

## Beispieltexte

| Quelle | Inhalt | Lizenz laut Anbieter | Liegt im Repo |
|---|---|---|---|
| [GraSCCo (Zenodo 10.5281/zenodo.6539131)](https://doi.org/10.5281/zenodo.6539131) | 62 synthetische deutsche Arztbriefe, alle Namen und Daten frei erfunden | CC BY 4.0 | ja, in `grascco/` |
| [MultiGraSCCo (Zenodo 10.5281/zenodo.19489040)](https://doi.org/10.5281/zenodo.19489040) | Dieselben Briefe in 9 Sprachen übersetzt, darunter Englisch, Arabisch, Türkisch, Ukrainisch und Russisch | CC BY 4.0 | nein (3 MB, bei Bedarf laden) |

**Wichtig zu GraSCCo:** Die Texte bilden die Sprache echter Arztbriefe nach, sind aber medizinisch nicht immer plausibel. Für Übersetzung und Vereinfachung ist das unproblematisch.

**Wofür MultiGraSCCo gut ist:** als Vergleichsübersetzung. Eure KI-Übersetzung lässt sich neben eine vorhandene Übersetzung desselben Briefs legen.

## Avatar-Bausteine (Open Source)

| Baustein | Was er kann | Aufwand |
|---|---|---|
| Sprachausgabe des Browsers (`speechSynthesis`) | Liest Text in vielen Sprachen vor, ohne Schlüssel und ohne Installation | gering, im Spickzettel Block 5 |
| [TalkingHead](https://github.com/met4citizen/TalkingHead) | 3D-Avatar im Browser, der in Echtzeit spricht und die Lippen bewegt | mittel bis hoch |
| [HeadTTS](https://github.com/met4citizen/HeadTTS) | Freie Sprachausgabe mit Zeitmarken für die Lippenbewegung, läuft im Browser oder lokal | mittel |
| [HeadAudio](https://github.com/met4citizen/HeadAudio) | Erkennt Mundbewegungen direkt aus dem Ton | mittel |

Lizenzen bitte vor Verwendung auf der jeweiligen Projektseite prüfen.

### So bindet man TalkingHead an (in einfachen Worten)
1. TalkingHead ist eine fertige JavaScript-Datei, die eure Seite aus dem Internet nachlädt. Installiert wird nichts.
2. Dazu kommt eine Avatar-Datei (Format GLB), also die 3D-Figur.
3. Eure Seite übergibt dem Avatar den Text und die Tonausgabe, der Avatar bewegt dazu den Mund.

Prompt für Claude Code:
```
Ersetze die gezeichnete Figur durch einen 3D-Avatar mit der Open-Source-Bibliothek TalkingHead (github.com/met4citizen/TalkingHead). Lies zuerst deren README, erkläre mir in fünf Sätzen, was dafür nötig ist und welche Sprachen die Lippenbewegung unterstützt, und warte auf meine Freigabe.
```
Beachtet: Die eingebaute Lippenbewegung deckt laut Projektseite nur wenige Sprachen ab. Für andere Sprachen braucht es einen zusätzlichen Sprachdienst. Deshalb erst die einfache Variante fertig bauen.

## Bei Verwendung angeben
Modersohn L, Schulz S, Lohr C, Hahn U. GRASCCO – The First Publicly Shareable, Multiply-Alienated German Clinical Text Corpus. Stud Health Technol Inform. 2022;296:66-72.
