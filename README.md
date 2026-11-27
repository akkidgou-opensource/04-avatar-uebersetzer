# 04 · Medizinischer Avatar-Übersetzer – „Gesundheits-Kumpel“

> Prototyp für den AKKI Hackathon 2026. Nur synthetische Testdaten, kein Medizinprodukt, kein Ersatz für ein ärztliches Gespräch oder professionelles Dolmetschen.

**Bereich:** Aufnahme und Ambulanz

## Die Idee
Ein freundlicher Avatar begleitet **Patientinnen und Patienten** als Gesundheits-Kumpel. Sie sprechen einfach mit ihm, laden ihre Unterlagen hoch, und er erklärt komplexe medizinische Texte in einfacher Sprache – auf Deutsch, Englisch oder Französisch. Aus vielen Arztbriefen bereitet er die bisherige Krankengeschichte verständlich auf.

## Warum
Sprachbarrieren und Fachvokabular erschweren das Verstehen. Mitgebrachte, oft fremdsprachige oder umfangreiche Unterlagen sind für Patienten schwer zu durchschauen und für Ärzte zeitaufwändig.

## Zielbild (vom Team festgelegt)
| Thema | Entscheidung |
|---|---|
| Nutzer | Die Patientin/der Patient selbst, mit eigenem Konto |
| Anmeldung | Ziel: „Mit Apple anmelden“ (ein Probenutzer reicht). Bis dahin Benutzername/Passwort |
| Gerät | iPhone als echte App (Capacitor), vorher Web-App im Browser |
| Sprachen | Deutsch, Englisch, Französisch – automatisch erkannt |
| Ton | Locker, per Du, warm und empathisch |
| Avatar | Der Patient wählt selbst (4 Avatare mit deutschen Stimmen) |
| Bedienung | Freihändig: einmal starten, danach hört der Avatar nach jeder Antwort wieder zu |
| Haltung | **Nur erklären, nie raten.** Bei Ratfragen Verweis an Ärztin/Arzt. Genaue Regeln liefert das Team |
| Gedächtnis | Über Sitzungen hinweg – nur für Test-Patienten, lokal gespeichert, löschbar |
| Startseite | Direkt der Avatar. Über das Menü: Übersicht im Tagebuch-Stil (Unterlagen, Geschichte, Einstellungen) |
| Design | Ruhig, warm, leicht verspielt, iOS-„Liquid Glass“; nach dem Login bewusst einfach |

## Was am Ende stehen soll
**Basis**
- Gespräch mit dem Avatar per Sprache (freihändig), Antworten gesprochen und als Untertitel
- Unterlagen hochladen: Foto/Scan (Kamera), PDF, Text, Auswahl aus Beispielbriefen
- Komplexe medizinische Texte in einfache Sprache bzw. Englisch/Französisch übertragen
- Patientengeschichte aufbereiten: Zeitstrahl, Zusammenfassung „Was ist bisher passiert?“, Medikamente und Fachbegriffe erklärt, Fragen für den nächsten Arzttermin sammeln
- Platzhalter-Knopf „Mit ePA synchronisieren“ (Demo, ohne echte Anbindung)

**Kür (nach der Basis)**
- Arzttermin-Modus: Der Patient bereitet Fragen vor; sie werden auf Deutsch in großer Schrift angezeigt (max. 80 Zeichen) und vorgelesen. Der Avatar übersetzt die Antwort der Ärztin/des Arztes, die Frage kann abgehakt werden.

**Demo am Pitch-Tag**
1. Patient 1: unterschiedliche Demo-Dokumente werden live abfotografiert (vom Bildschirm oder ausgedruckt) und erklärt.
2. Patient 2: viele synthetische Arztbriefe aus `daten/` → Zeitstrahl, Zusammenfassung, Gespräch.
3. ePA-Knopf als Ausblick.

**Erfolgskriterium:** Der Patient lädt einen Brief hoch, fragt den Avatar per Sprache danach und bekommt eine verständliche, gesprochene Erklärung.

## Aktueller Stand
- Web-App mit Anmeldung, Rollen (`admin`, `arzt`), Sicherheitsebenen (Passwort-Hashes, Sitzungsablauf, Sperre nach Fehlversuchen, strenge CSP)
- Glas-Oberfläche: Anmeldung → Avatar-Auswahl → Gesprächsansicht mit Zurück, Einstellungen, Mikrofon, Stopp, Kontext
- D-ID-Avatar in Echtzeit (WebRTC), 4 Avatare, spricht genau den übergebenen Text
- Gespräch per Spracheingabe des Browsers; ohne Anthropic-Schlüssel bzw. Gesprächsregeln läuft ein Echo-Test
- Übersetzen in einfache Sprache (braucht Schlüssel und Regeln in `prompt/system.md`)
- iOS: Xcode und Simulator (iPhone 18 Pro) eingerichtet, Capacitor folgt – siehe `IOS_ANLEITUNG.md`

## So startet ihr
1. `.env.example` zu `.env` kopieren und Schlüssel im Texteditor eintragen (nie über den Chat).
2. Im Projektordner: `node --env-file=.env server.js`
3. Im Browser http://localhost:3000 öffnen, mit dem Testnutzer aus `.env` anmelden.
4. Zwischenstände hochladen: siehe `GITHUB_ANLEITUNG.md`.

## Was in diesem Repo liegt
| Datei | Wofür |
|---|---|
| `server.js` | Server: Anmeldung, Sicherheit, KI-, D-ID- und Gesprächs-Schnittstellen |
| `public/index.html` | Die ganze Oberfläche (HTML, CSS, JavaScript in einer Datei) |
| `prompt/system.md`, `prompt/gespraech.md` | Regeln für KI-Übersetzung und Gespräch – **füllt das Team**, bis dahin Platzhalter |
| `CLAUDE.md`, `AGENTS.md` | Dieselben Regeln für den Coding-Agenten (Claude Code liest die erste, Codex die zweite Datei) |
| `.claude/agents/` | Rollen des Agenten-Teams: Design, Backend/Auth, Avatar/D-ID, Dialog/Agentik, Test |
| `IOS_ANLEITUNG.md` | iPhone-App Schritt für Schritt |
| `GITHUB_ANLEITUNG.md` | Arbeit auf GitHub bringen, ohne Git-Kenntnisse |
| `daten/QUELLEN.md` | Beispieltexte, Übersetzungen und Avatar-Bausteine mit Lizenz |
| `daten/grascco/` | 62 synthetische deutsche Arztbriefe |
| `daten/multigrascco/` | Dieselben Briefe in 10 Sprachen als Vergleichsübersetzung |

## Offene Punkte
- **Inhalte vom Team:** Gesprächs- und Übersetzungsregeln (`prompt/*.md`), Grenzen des Avatars, ggf. Warnzeichen-Liste.
- **Anthropic-Schlüssel** in `.env` eintragen (bis dahin Echo-Test).
- **Mit Apple anmelden** braucht das kostenpflichtige Apple Developer Program und für die Web-Variante eine echte Internet-Adresse mit HTTPS.
- **Automatische Spracherkennung** (DE/EN/FR) und **Spracheingabe in der iOS-App** brauchen einen Sprache-zu-Text-Dienst bzw. ein iOS-Plugin; die Browser-Spracherkennung reicht dafür nicht.
- **Datenschutz:** Anthropic (USA), D-ID (Israel/USA) und die Spracherkennung (Google/Apple) sind nicht DSGVO-konform – nur Testdaten.

## Stolpersteine
- Medizinische Genauigkeit sicherstellen: Englisch und Französisch muss jemand im Team prüfen können
- Keine echten Patientendaten verwenden
- Der Avatar ist Verpackung: erst muss der Text stimmen, dann kommt das Gesicht

## Quellen
Siehe `daten/QUELLEN.md` (GraSCCo, MultiGraSCCo, CC BY 4.0).
