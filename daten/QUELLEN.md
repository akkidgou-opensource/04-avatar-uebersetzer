# Datenquellen und Bausteine Avatar-Übersetzer

## Im Repo
| Ordner | Inhalt | Herkunft und Lizenz |
|---|---|---|
| `grascco/` | 62 synthetische deutsche Arztbriefe, alle Namen und Daten frei erfunden | [GraSCCo, Zenodo 10.5281/zenodo.6539131](https://doi.org/10.5281/zenodo.6539131), CC BY 4.0 |
| `multigrascco/` | Dieselben Briefe (63 je Sprache) in 10 Sprachen, ein Unterordner je Sprache: Arabisch, Deutsch, Englisch, Französisch, Italienisch, Persisch, Polnisch, Russisch, Türkisch, Ukrainisch | [MultiGraSCCo, Zenodo 10.5281/zenodo.19489040](https://doi.org/10.5281/zenodo.19489040), CC BY 4.0 |

Die Ordner in `multigrascco/` tragen die englischen Sprachnamen des Datensatzes (z. B. `Turkish`, `Ukrainian`). Derselbe Brief hat in jeder Sprache denselben Dateinamen, z. B. `Sudeck.txt`.

**Wichtig:**
- Die Texte bilden die Sprache echter Arztbriefe nach, sind aber medizinisch nicht immer plausibel. Für Übersetzung und Vereinfachung ist das unproblematisch.
- Die Übersetzungen in MultiGraSCCo sind maschinell erzeugt. Sie sind eine Vergleichshilfe, kein Goldstandard.
- Namen und Daten in MultiGraSCCo können von den Texten in `grascco/` abweichen.

**Wofür MultiGraSCCo gut ist:** Eure KI-Übersetzung lässt sich neben eine vorhandene Übersetzung desselben Briefs legen.

## Avatar-Bausteine (Open Source)
| Baustein | Was er kann | Lizenz | Aufwand |
|---|---|---|---|
| Sprachausgabe des Browsers (`speechSynthesis`) | Liest Text in vielen Sprachen vor, ohne Schlüssel und ohne Installation | im Browser eingebaut | gering |
| [TalkingHead](https://github.com/met4citizen/TalkingHead) | 3D-Avatar im Browser, der in Echtzeit spricht und die Lippen bewegt | MIT | mittel bis hoch |
| [HeadTTS](https://github.com/met4citizen/HeadTTS) | Freie Sprachausgabe mit Zeitmarken für die Lippenbewegung, läuft im Browser oder lokal | siehe Projektseite | mittel |
| [HeadAudio](https://github.com/met4citizen/HeadAudio) | Erkennt Mundbewegungen direkt aus dem Ton | MIT | mittel |

### So bindet man TalkingHead an (in einfachen Worten)
1. TalkingHead ist eine fertige JavaScript-Datei, die eure Seite aus dem Internet nachlädt. Installiert wird nichts.
2. Dazu kommt eine Avatar-Datei (Format GLB), also die 3D-Figur.
3. Eure Seite übergibt dem Avatar den Text und die Tonausgabe, der Avatar bewegt dazu den Mund.

Prompt für den Coding-Agenten:
```
Ersetze die gezeichnete Figur durch einen 3D-Avatar mit der Open-Source-Bibliothek TalkingHead (github.com/met4citizen/TalkingHead). Lies zuerst deren README, erkläre mir in fünf Sätzen, was dafür nötig ist und welche Sprachen die Lippenbewegung unterstützt, und warte auf meine Freigabe.
```
Beachtet: Die eingebaute Lippenbewegung deckt laut Projektseite nur wenige Sprachen ab. Für andere Sprachen braucht es einen zusätzlichen Sprachdienst. Deshalb erst die einfache Variante fertig bauen.

## Bei Verwendung angeben
Modersohn L, Schulz S, Lohr C, Hahn U. GRASCCO – The First Publicly Shareable, Multiply-Alienated German Clinical Text Corpus. Stud Health Technol Inform. 2022;296:66-72. Für die Übersetzungen zusätzlich: MultiGraSCCo, Zenodo, doi:10.5281/zenodo.19489040.
