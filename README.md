# mitano. – dein Gesundheits-Begleiter mit Avatar

> Prototyp für den AKKI Hackathon 2026 (Projekt 04). **Nur synthetische Testdaten.** Kein Medizinprodukt,
> kein Ersatz für eine ärztliche Beurteilung. Die genutzten Cloud-Dienste sind **nicht DSGVO-konform**.

Stand dieses Dokuments: **28.11.2026**

---

## 1. Worum es geht

**mitano.** ist eine iPhone-App (und Web-App) für **Patientinnen und Patienten**. Ein freundlicher Avatar (ein Otter
namens mitano.) führt ein echtes Gespräch per Sprache. Er:

- erklärt Arztbriefe und Befunde in einfacher Sprache, mit Quellenangabe (welcher Brief, welche Stelle),
- kennt die hochgeladenen Unterlagen und baut daraus einen **Zeitstrahl** der Krankengeschichte,
- merkt sich, was die Person ihm erzählt (**Gedächtnis**: Name, Eckdaten, Allergien, Termine …),
- zeigt auf einem **Dashboard** Termine, einen **Medikamentenplan** aus den Unterlagen und die Erinnerungen,
- spricht **Deutsch, Englisch, Französisch, Türkisch, Arabisch**,
- weist bei **klaren** Anzeichen einer Krise auf Hilfe hin (siehe Abschnitt 9).

---

## 2. Aktueller Stand (was funktioniert)

| Bereich | Stand | Hinweise |
|---|---|---|
| Anmeldung + Einwilligung „nur Testdaten“ | ✅ | Benutzername/Passwort aus `.env`, Sitzungen überleben Server-Neustart |
| Einrichtung (Avatar, Sprache) | ✅ | Nur Sprachen, für die es einen Avatar gibt |
| Dashboard | ✅ | Termine (aus Unterlagen + eigene + im Gespräch erzählte), Medikamentenplan, Erinnerungen, Zeitstrahl-Knopf |
| Gespräch mit dem Avatar (D-ID) | ✅ | Begrüßung mit Namen, freihändig, Wake-Word „mitano“ im Gespräch |
| Antworten aus den Unterlagen (Claude) | ✅ | Wissensspeicher (BM25) + Zitate, Quellen-Knopf |
| Gedächtnis | ✅ | lernt aus Gespräch und Dokumenten, in den Einstellungen und im Dashboard einsehbar/löschbar |
| Unterlagen | ✅ | Scannen (Apple-Dokumentenscanner), Hochladen, Zeitstrahl je Brief, Original/Text/Einfach, Löschen inkl. aller abgeleiteten Einträge |
| App erklärt sich selbst | ✅ | „Erklär mir mal, was du machst“ → App-Erklärung, Knöpfe leuchten |
| Witze, lockerer Ton | ✅ | nie bei ernsten Themen |
| Sprachen | ✅ | de/en/fr/tr/ar; Stimmen geprüft (Übersteuerung gemessen) |
| iPhone-App (Capacitor) | ✅ | Logo, schneller Start, sucht den Server selbst (Wegweiser) |
| **Ton auf dem iPhone über Lautsprecher in der App** | ⚠️ | siehe Abschnitt 10 „Bekannte Probleme“ |

---

## 3. Architektur (vereinfacht)

```
iPhone-App (Capacitor-Hülle, ios-app/)          Browser (Safari/Chrome)
        │  lädt die Web-App vom Server                 │
        └──────────────┬───────────────────────────────┘
                       ▼
          public/index.html  (die ganze Oberfläche: HTML/CSS/JS, kein Build)
                       │  HTTPS (Cloudflare-Tunnel)        LiveKit/WebRTC (Bild + Ton)
                       ▼                                         ▲
          server.js (Node ≥ 20, nur Bordmittel) ─────────────────┤
           ├─ rag.js          Wissensspeicher (BM25 + Claude-Zitate)
           ├─ gedaechtnis.js  Patienten-Gedächtnis (Fakten, Steckbrief)
           ├─ patientendaten.js  Unterlagen, Abschrift, Zeitstrahl
           ├─ dashboard.js    Termine, Medikamentenplan
           ├─ Anthropic API   (Claude Sonnet: Antworten; Haiku: Weiche, Gedächtnis)
           └─ D-ID Agents V2  (Avatar-Sitzung über LiveKit)
          lokal/  (Daten der Test-Patienten, NICHT im Git)
```

**Gesprächsweg („Weiche“):** Jede Frage wird in Millisekunden eingeordnet:
- Smalltalk → D-IDs eigene KI antwortet direkt (schnell),
- Fragen zu Unterlagen, Gedächtnis, App, Gefühlen, Krisen → **Claude** mit Wissensspeicher; mitano. sagt sofort
  einen Überbrückungssatz („Moment, ich schau kurz nach …“), dann die Antwort satzweise.

---

## 4. Voraussetzungen

- macOS mit **Node.js ≥ 20**
- **Anthropic-API-Schlüssel** und **D-ID-API-Schlüssel** (Agents V2)
- Für die iPhone-App: **Xcode** (getestet mit iOS-27-SDK), Apple-ID (kostenloses Team reicht: App läuft 7 Tage)
- Für den Zugriff vom iPhone: **cloudflared** (Cloudflare Quick Tunnel), optional **gh** (GitHub CLI) für den Wegweiser

---

## 5. Einrichten (`.env`)

`.env.example` nach `.env` kopieren und **im Texteditor** ausfüllen (Schlüssel nie in Chat, Code oder Log).
`.env`, `.env.*` (Sicherungen) und `lokal/` sind in `.gitignore`.

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `ANTHROPIC_API_KEY` | ja | Claude |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_GESPRAECH` | – | Standard `claude-sonnet-5-5` |
| `ADMIN_USER`, `ADMIN_PASSWORD` | ja | Admin (Test-Patient mit 15 Briefen) |
| `DEMO_USER`, `DEMO_PASSWORD` | ja | Demo-Nutzer (leer, wird beim Login zurückgesetzt) |
| `DID_API_KEY` | ja | D-ID (Format `benutzer:passwort` bzw. Basic-Schlüssel) |
| `DID_AVATARE` | ja | Avatare/Stimmen/Sprachen: `gruppe[.stimme]=AGENT_ID:sprache,…` (z. B. `mitano=v2_agt_…:de,mitano=v2_agt_…:en,mitano.mia=v2_agt_…:de`) |
| `DID_AVATAR_STANDARD` | – | Standard-Agent |
| `HOST`, `PORT` | – | z. B. `0.0.0.0` / `3000` |
| Feineinstellungen | – | `SPEKULATIV`, `GESPRAECH_EFFORT`, `GESPRAECH_MAX_TOKENS`, `SATZBREMSE`, `UEBERSETZEN_EFFORT`, `WEG_TIMEOUT_MS` … (Standardwerte im Code) |

Passwörter nach Änderung: `node --env-file=.env werkzeuge/passwoerter-setzen.js` (der Server übernimmt sie auch beim Start).

---

## 6. Starten (lokal)

```bash
node --env-file=.env server.js          # http://localhost:3000 (bzw. PORT)
```

Wir betreiben zwei Kopien nebeneinander:

| Umgebung | Ordner | Port | Zweck |
|---|---|---|---|
| **Entwicklung** | dieses Repo | 3210 (`PORT=3210` in `.env`) | hier wird gebaut und getestet |
| **Demo/Live** | `../04-avatar-uebersetzer-demo` (Kopie ohne Git) | 3000 | was die App und das Publikum sehen |

**Übernahme Entwicklung → Demo** (immer erst testen, dann sichern, dann kopieren):
```bash
bash werkzeuge/server-test.sh                      # 48 Prüfungen (startet den Dev-Server neu)
node werkzeuge/gedaechtnis-test.js --ohne-ki       # 14 Prüfungen
# Sicherung der Demo anlegen, dann:
cp server.js rag.js gedaechtnis.js patientendaten.js dashboard.js ../04-avatar-uebersetzer-demo/
rsync -a public/ prompt/ werkzeuge/ → jeweils in den Demo-Ordner
# Demo-Server neu starten (nur nötig, wenn sich .js-Dateien geändert haben; index.html wird bei jedem Aufruf frisch gelesen)
```

---

## 7. Erreichbarkeit vom iPhone (Tunnel + Wegweiser)

Das iPhone erreicht den Mac oft nicht im WLAN (isolierte Netze). Deshalb:

1. **Cloudflare Quick Tunnel** je Port: `nohup cloudflared tunnel --no-autoupdate --url http://localhost:3000 &`
2. **Wächter** `werkzeuge/tunnel-waechter.sh` (mit `nohup bash werkzeuge/tunnel-waechter.sh &`): prüft alle 30 s
   Server und Tunnel, startet sie bei Ausfall neu und schreibt die aktuelle Adresse in ein geheimes GitHub-Gist
   („Wegweiser“, Datei `mitano-adresse.json`). Log: `/tmp/akki-waechter.log`.
3. Die **App-Startseite** (`ios-app/www/index.html`) liest den Wegweiser und die zuletzt genutzte Adresse,
   prüft beide parallel (10 s Zeitlimit, 3 Versuche) und öffnet die erste erreichbare.
   Manuell: **Langdruck auf das Logo** → Adresse eingeben. In der App: Einstellungen → „Server wechseln“.

Nach einem Mac-Neustart: Server, Tunnel und Wächter neu starten.

---

## 8. iPhone-App bauen und installieren

```bash
cd ios-app
npm install            # wendet auch den Patch in ios-app/patches/ an (patch-package)
npx cap sync ios       # nur nötig, wenn www/ oder Plugins geändert wurden
# Gerät (ID mit: xcrun devicectl list devices)
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination id=<GERAETE-ID> -derivedDataPath build/dev -allowProvisioningUpdates build
xcrun devicectl device install app --device <GERAETE-ID> build/dev/Build/Products/Debug-iphoneos/App.app
# Simulator
xcodebuild … -destination id=<SIMULATOR-ID> -derivedDataPath build/sim build
xcrun simctl install <SIMULATOR-ID> build/sim/Build/Products/Debug-iphonesimulator/App.app
```

- App-ID `de.akki.kumpel.coso`, Name **mitano.**, Symbol aus `design/app-icon-1024.png`.
- Plugins: Dokumentenscanner (VisionKit), Haptik, App-Lebenszyklus, Spracherkennung (siehe unten, in der App derzeit aus).
- Die Web-Oberfläche kommt immer vom Server – **für Änderungen an `public/index.html` ist kein neuer App-Build nötig**,
  nur die App einmal ganz schließen (wegwischen) und neu öffnen.
- Alternative ohne Build: Safari → Adresse öffnen → Teilen → „Zum Home-Bildschirm“ (läuft im Vollbild mit mitano.-Symbol).

Ausführlich: `IOS_ANLEITUNG.md`.

---

## 9. Inhalte, Haltung und Sicherheit

- **Haltung des Avatars** (Team-Entscheid 27./28.11.): Unterstützungsassistent für medizinische Fragen ohne
  inhaltliche Einschränkung, Antworten auf Basis der Unterlagen mit Quellen, locker per Du, gelegentlich Witze
  (nie bei ernsten Themen). Text: `prompt/gespraech.md` (**vom Team gegenlesen**). App-Wissen: `prompt/app-wissen.md`.
- **Krisenhinweise nur bei klaren Anzeichen** (Nutzerentscheid 28.11., Team prüft Wortlaut/Nummern):
  seelisch (Suizidalität, schwere Depression, seelisches Trauma) → TelefonSeelsorge **116 123** + **112**;
  körperlich (nur bei eindeutigen Notfall-Formulierungen) → ärztlicher Bereitschaftsdienst **116 117** + **112**.
  Nicht blockierende Hilfekarte mit Anruf-Knöpfen, niemals erzwungen.
- **Datenschutz:** Nur synthetische Daten (`daten/grascco`, `daten/multigrascco`, `daten/grascco-2027`).
  Inhalte (Texte, Bilder, Ton, Gespräche) werden **nie geloggt** – das Server-Log enthält nur technische Codes.
  Daten der Test-Patienten liegen in `lokal/` (nicht im Git), jederzeit löschbar („Demo zurücksetzen“, „Alles vergessen“).
- **Server-Sicherheit:** Passwort-Hashes, Sperre nach Fehlversuchen (echte Client-IP hinter dem Tunnel), strenge CSP
  mit Nonce, `X-Requested-With`-Prüfung, Größenlimits, atomares Schreiben, D-ID-Sitzungen werden bei Logout/Neustart beendet.
- **Bewusst offen:** Der Demo-Nutzer hat Admin-Rechte; Passwörter aus `.env` dürfen kurz sein (siehe Abschnitt 11).

---

## 10. Bekannte Probleme

### Ton knackt auf dem iPhone in der App über den Lautsprecher
- **Befund (gemessen):** Der empfangene Ton ist sauber (WebRTC-Statistik: keine Lücken, keine Verluste).
  In **Safari** auf demselben iPhone und **mit Kopfhörern** in der App ist der Ton sauber. Das Knacken entsteht also
  im Wiedergabeweg der App-Hülle (WKWebView + iOS-Audio-Sitzung), wenn gleichzeitig das Mikrofon mit
  Echo-Unterdrückung läuft und über den Lautsprecher abgespielt wird.
- **Bereits umgesetzt:** Apple-Spracherkennungs-Plugin in der App aus (stellte die Audio-Sitzung um), kein Web-Audio
  in der App, Mikro wird vor der Begrüßung „vorgewärmt“, App-Modus `app`: Mikro **ohne** iOS-Echoverarbeitung und
  **stumm, solange mitano. spricht** (Gespräch im Wechsel, Unterbrechen per Stopp-Knopf), AppDelegate setzt die
  Audio-Sitzung auf „Videoanruf über Lautsprecher“.
- **Umgehung für Vorführungen:** Kopfhörer/AirPods **oder** die Home-Bildschirm-Variante über Safari.
- **Test-Schalter** (an die Adresse anhängen, wird gemerkt): `?ab=normal|app|ohneecho|ohnepegel|mikrozu`,
  `?plugin=1` (Apple-Spracherkennung wieder an), `?vorab=1` (Vorab-Verbinden auf dem Dashboard).
  Diagnose-Codes landen im Server-Log als `sprache:g=<Gerät> p=ios|sim|… ab=… ton hc=… sc=…`.
- **Nächster Schritt:** Wiedergabe in der App über einen eigenen nativen Audio-Weg oder ein `SFSafariViewController`
  bzw. die WebKit-Audio-Sitzung gezielt verwalten – siehe `werkzeuge/FUNKTIONSSTAND.md`.

### Weitere
- Stimme **Harper** (de) übersteuert bereits in der D-ID-Quelle → ausgeblendet; FR nutzt jetzt **Denise**.
- „In einfache Sprache übersetzen“ dauert ~25 s (langer Text, Denkaufwand „low“).
- D-ID kostet ca. **6–7 Credits pro Gesprächsminute** – vor Vorführungen Guthaben prüfen.
- Wake-Word „mitano“ wirkt nur im Gespräch (über die Avatar-Verbindung), nicht auf dem Dashboard.

---

## 11. Vom Prototyp zum echten Einsatz (Ausblick)

1. **Pilot:** Server in einem deutschen Rechenzentrum (fester Domainname statt Quick Tunnel, TLS), TestFlight statt
   7-Tage-Signatur, echte Benutzerverwaltung (eigene Rollen, kein Admin für Demo, Passwortregeln, „Mit Apple anmelden“).
2. **Datenschutz:** EU-Anbieter bzw. Verträge zur Auftragsverarbeitung für KI, Avatar und Spracherkennung,
   Verschlüsselung der Patientendaten, Lösch- und Auskunftsprozesse, DSFA.
3. **Medizin & Regulatorik:** Inhalte, Krisenregeln und Grenzen vom ärztlichen Team freigeben lassen; Einordnung
   nach MDR prüfen (ein erklärender Begleiter kann Medizinprodukt sein).
4. **Technik:** ePA-Anbindung, Termin-Erinnerungen, Ton-Problem der App-Hülle endgültig lösen (Abschnitt 10).

---

## 12. Was in diesem Repo liegt

| Pfad | Wofür |
|---|---|
| `server.js` | Server: Anmeldung, Sicherheit, Weiche, Claude-/D-ID-Schnittstellen, Unterlagen, Gedächtnis, Dashboard-Routen |
| `rag.js` | Wissensspeicher (BM25, Suchbegriffe per Haiku, Zitate über Anthropic-Citations) |
| `gedaechtnis.js` | Patienten-Gedächtnis: Fakten aus Gespräch und Dokumenten, Steckbrief, Vergessen |
| `patientendaten.js` | Unterlagen, Abschrift (Text/PDF/Foto), Zeitstrahl-Extraktion, Onboarding |
| `dashboard.js` | Termine (eigene + abgeleitete) und Medikamentenplan aus dem neuesten Brief |
| `public/index.html` | Die ganze Oberfläche; `public/vendor/` (LiveKit, Inter-Schrift), `public/avatar/` (Standbilder, Zuhör-Geste) |
| `prompt/gespraech.md`, `prompt/app-wissen.md`, `prompt/system.md` | Gesprächsregeln, App-Wissen, Übersetzungsregeln (Platzhalter fürs Team) |
| `ios-app/` | Capacitor-Hülle: `www/` (Startseite mit Wegweiser), `ios/` (Xcode-Projekt), `patches/` |
| `design/` | App-Symbol, Icons, Team-Designvorlagen (`vorlagen-team-28-11/`) |
| `werkzeuge/` | Tests (`server-test.sh`, `gedaechtnis-test.js`, `rag-test.js`, `patientendaten-test.js`), Import (`patient-import.js`), Tunnel-Wächter, Berichte (`FUNKTIONSSTAND.md`, `QA_NACHT.md`, Schnittstellen) |
| `daten/` | Synthetische Arztbriefe (GraSCCo, MultiGraSCCo, `grascco-2027` = datierte Fassung), Quellen in `daten/QUELLEN.md` |
| `CLAUDE.md`, `AGENTS.md`, `.claude/agents/` | Regeln und Rollen für die Coding-Agenten |
| `IOS_ANLEITUNG.md`, `GITHUB_ANLEITUNG.md` | Schritt-für-Schritt-Anleitungen |

---

## 13. Tests

```bash
bash werkzeuge/server-test.sh                  # Login, Rollen, Limits, Sitzungen, Neustart (48 Prüfungen)
node werkzeuge/gedaechtnis-test.js --ohne-ki   # Gedächtnis ohne KI-Kosten (14 Prüfungen)
node --env-file=.env werkzeuge/rag-test.js     # Wissensspeicher (kostet Claude-Aufrufe)
```
Oberflächen-Prüfungen liefen mit Chrome headless (402×874, 375×667) und im iOS-Simulator; Berichte in `werkzeuge/`.

## Quellen
Siehe `daten/QUELLEN.md` (GraSCCo, MultiGraSCCo, CC BY 4.0).
