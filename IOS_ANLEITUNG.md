# iOS-App entwickeln: Schritt für Schritt

Diese Anleitung ist für alle, die zum ersten Mal eine iPhone-App bauen. Es werden nur Testdaten verwendet.

## Der Weg in einem Satz
Wir bauen die Web-App und packen sie mit **Capacitor** in eine iOS-App. Capacitor ist ein Hilfsprogramm, das eine Webseite in eine echte iPhone-App verpackt. So brauchen wir keine neue Programmiersprache.

> Hinweis: Capacitor ist ein zusätzliches npm-Paket. Das Team hat es für die iOS-App-Hülle freigegeben (siehe `CLAUDE.md`).
>
> Stand: Xcode 27.2 und der iOS-Simulator (iPhone 18 Pro) sind auf dem Entwicklungs-Mac bereits eingerichtet.

## Schritt 1 · Xcode installieren (einmalig, ca. 1 Stunde)
Xcode ist das Apple-Programm, ohne das keine iPhone-App entsteht.
1. App Store am Mac öffnen, nach **Xcode** suchen, **Laden** klicken (über 10 GB, braucht Zeit und mindestens 30 GB freien Platz).
2. Xcode einmal öffnen und „Install“ bzw. „Agree“ klicken, wenn zusätzliche Komponenten angeboten werden.
3. Beim ersten Start unter **Settings → Components** (bzw. „Platforms“) den **iOS Simulator** laden. Der Simulator ist ein virtuelles iPhone auf dem Mac.

## Schritt 2 · Mac auf Xcode umstellen
Im Terminal nacheinander eingeben (der Mac fragt nach dem Passwort):
```
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -version
```
**Fertig, wenn:** bei der letzten Zeile „Xcode 2x.x“ erscheint.

## Schritt 3 · Apple-ID in Xcode eintragen
1. Xcode öffnen → **Settings → Accounts → „+“ → Apple ID**.
2. Mit der Apple-ID anmelden. Eine kostenlose Apple-ID reicht, um die App auf dem eigenen iPhone zu testen (die App läuft dann 7 Tage, danach neu installieren).
3. Für TestFlight oder den App Store braucht es später das Apple Developer Program (99 US-Dollar pro Jahr). Für den Hackathon nicht nötig.

## Schritt 4 · Erst im Simulator testen
Der Simulator ist der einfachste Start, ohne iPhone und ohne Kabel. Das Projekt wird in Schritt 6 angelegt, dann in Xcode oben ein iPhone-Modell wählen und auf **▶** drücken.

## Schritt 5 · Eigenes iPhone verbinden (optional)
1. iPhone per Kabel anschließen, am iPhone „Diesem Computer vertrauen“ bestätigen.
2. Am iPhone: **Einstellungen → Datenschutz & Sicherheit → Entwicklermodus** einschalten, iPhone startet neu.
3. In Xcode das iPhone oben als Ziel wählen.
4. Beim ersten Start am iPhone: **Einstellungen → Allgemein → VPN & Geräteverwaltung** → eigene Apple-ID → „Vertrauen“.

## Schritt 6 · iOS-Projekt anlegen (macht Claude Code)
Erst wenn Schritt 1 bis 3 erledigt sind, diesen Prompt in Claude Code einfügen:
```
Lies CLAUDE.md und IOS_ANLEITUNG.md. Richte Capacitor ein, sodass public/index.html als iOS-App läuft. Sag mir vorher kurz, was du installierst, und warte auf meine Freigabe. Danach öffne das Projekt in Xcode und erkläre mir in drei Sätzen, wie ich es im Simulator starte.
```

## Wichtig für die Sicherheit
Der API-Schlüssel darf **nie in die App**. Die App ruft nur unseren `server.js` auf, und der spricht mit der KI. Das heißt:
- Beim Entwickeln läuft `server.js` auf dem Mac, die App im Simulator erreicht ihn über `http://localhost:3000` (Port ggf. anpassen).
- Ein echtes iPhone erreicht den Mac nur im selben WLAN über dessen Adresse (z. B. `http://192.168.x.x:3000`).
- Für die Demo kann der Server später im Internet laufen. Das entscheidet das Team.

## Häufige Stolpersteine
| Problem | Lösung |
|---|---|
| `xcodebuild` meldet „requires Xcode“ | Schritt 2 wiederholen |
| „Signing for … requires a development team“ | In Xcode beim Projekt unter **Signing & Capabilities** die eigene Apple-ID als Team wählen |
| Mikrofon oder Kamera funktioniert nicht | In der App-Einstellung (Info.plist) braucht es einen Erklärtext, Claude Code ergänzt ihn auf Anfrage |
| Sprachausgabe klingt schlecht | Am iPhone unter **Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen** bessere Stimmen laden |
