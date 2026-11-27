# Projektregeln für Claude Code

Lies zuerst `README.md`. Dort steht, was in diesem Projekt gebaut wird (Zielbild „Gesundheits-Kumpel“).

- **Rahmen:** Prototyp für den AKKI Hackathon 2026. Das Team besteht aus Ärztinnen und Ärzten, viele ohne IT-Kenntnisse.
- **Nutzer der App:** Die **Patientin bzw. der Patient** ist die Hauptnutzerin bzw. der Hauptnutzer. Die App ist ein Gesundheits-Kumpel: Avatar-Gespräch, Unterlagen hochladen, medizinische Texte verständlich erklären und übersetzen, Patientengeschichte aufbereiten. Live-Dolmetschen ist nicht der Schwerpunkt.
- **Sprache:** Antworte immer auf Deutsch, in einfachen Worten, ohne Fachjargon. Erkläre nach jeder Änderung in höchstens 3 Sätzen, was du getan hast und wie ich es prüfe.
- **Technik:** Node.js (ab Version 20), eine Datei `public/index.html` (HTML, CSS, JavaScript) und eine Datei `server.js`, nur Node-Bordmittel. Kein React, kein Build-Schritt für die Web-App. Start mit `node --env-file=.env server.js`. Ausnahme (vom Team gewünscht): Für die iOS-App darf Capacitor samt nötiger Plugins per npm genutzt werden – nur für die App-Hülle.
- **Sicherheit:** API-Schlüssel stehen nur in `.env` und werden nur im Server verwendet, nie im Browser- oder App-Code, nie im Terminal-Log. `.env` und `lokal/` gehören in `.gitignore`. Inhalte (Texte, Bilder, Tonaufnahmen, Gespräche) werden nie geloggt.
- **Speichern (vom Team so entschieden):** Für das Gedächtnis über Sitzungen hinweg dürfen Daten von **Test-Patienten** (synthetische Unterlagen, Zeitstrahl, Gesprächsnotizen) lokal in `lokal/` gespeichert werden. Nur synthetische Daten, nie ins Git, jederzeit löschbar. Echte Patientendaten werden nie gespeichert.
- **Daten:** Es werden nur öffentliche oder synthetische Testdaten verwendet (`daten/grascco`, `daten/multigrascco`), niemals echte Patientendaten.
- **Cloud-Dienste:** Für die Demo nutzen wir Anbieter, die nicht DSGVO-konform sind (Anthropic, D-ID, Spracherkennung von Google/Apple). Das muss in der App immer sichtbar erklärt werden, mit Bestätigung „nur Testdaten“.
- **Medizinische Inhalte** (Systemprompt, Gesprächsregeln, Ampel-Definitionen, Schwellenwerte, Algorithmen, Warnzeichen) niemals eigenmächtig ändern oder ergänzen. Nur wortgetreu übernehmen oder auf ausdrückliche Anweisung ändern. Fehlt etwas, Platzhalter mit `<!-- PLATZHALTER` anlegen. Grundhaltung des Avatars (vom Team festgelegt): **nur erklären, nie raten** – bei Ratfragen an Ärztin/Arzt verweisen.
- **Arbeitsweise:** Vor größeren Änderungen kurz sagen, was du vorhast. Nach Änderungen die App selbst starten und prüfen, ob sie läuft.
- **Agenten-Team:** Die Rollen stehen in `.claude/agents/` (Design, Backend/Auth, Avatar/D-ID, Dialog/Agentik, Test). Jede Rolle ändert nur ihre Dateien bzw. Abschnitte; die Koordination liegt beim Haupt-Agenten.
- **Hinweis in der App:** Jederzeit sichtbar muss stehen: „Prototyp – nur Testdaten. Kein Ersatz für ärztliche Beurteilung.“
