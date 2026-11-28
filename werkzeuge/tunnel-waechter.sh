#!/bin/bash
# Mitano. – Wächter für Server und Cloudflare-Tunnel (nur für die Demo-/Entwicklungsphase).
# Prüft alle 30 s: Demo-Server (3000), Entwicklungs-Server (3210) und beide Tunnel.
# Fällt ein Tunnel aus (z. B. nach Netz-Aussetzer „Tunnel not found“), wird er neu gestartet
# und die neue Adresse ins geheime GitHub-Gist geschrieben. Die App liest das Gist beim Start.
# Start:  nohup bash werkzeuge/tunnel-waechter.sh > /tmp/akki-waechter.log 2>&1 &
# Es werden nur Adressen und Statuscodes protokolliert – keine Inhalte, keine Schlüssel.

GIST_ID="5cc71a70c848b196d5252d18a7939313"
GIST_DATEI="/tmp/mitano-adresse.json"
PROJEKT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO_ORDNER="$(cd "$PROJEKT/../04-avatar-uebersetzer-demo" 2>/dev/null && pwd)"

zeit() { date '+%H:%M:%S'; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }

server_pruefen() {  # $1 Port, $2 Ordner, $3 Startbefehl-Datei, $4 Log
  # Zuerst die Gesundheits-Route (prüft, ob der Server wirklich antwortet); ältere Stände ohne diese Route → Startseite.
  [ "$(code "http://localhost:$1/api/gesundheit")" = "200" ] && return
  [ "$(code "http://localhost:$1/")" = "200" ] && return
  echo "$(zeit) Server $1 antwortet nicht – starte neu"
  (cd "$2" && nohup node --env-file=.env "$3" > "$4" 2>&1 &)
  sleep 3
}

tunnel_starten() {  # $1 Port, $2 Log, $3 Adressdatei
  pkill -f "cloudflared tunnel --no-autoupdate --url http://localhost:$1" 2>/dev/null
  sleep 1
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$1" > "$2" 2>&1 &
  local u=""
  for i in $(seq 1 40); do
    u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$2" | head -1)
    [ -n "$u" ] && break; sleep 1
  done
  [ -n "$u" ] && echo "$u" > "$3" && echo "$(zeit) Tunnel $1 neu: $u"
  sleep 5
}

gist_aktualisieren() {
  printf '{"demo":"%s","dev":"%s","stand":"%s"}\n' "$(cat /tmp/akki-tunnel-url.txt 2>/dev/null)" \
    "$(cat /tmp/akki-tunnel-dev-url.txt 2>/dev/null)" "$(date -u +%FT%TZ)" > "$GIST_DATEI"
  cp "$GIST_DATEI" /tmp/mitano-adresse-upload.json
  if gh gist edit "$GIST_ID" -f mitano-adresse.json /tmp/mitano-adresse-upload.json >/dev/null 2>&1; then
    echo "$(zeit) Wegweiser (Gist) aktualisiert"
  else
    echo "$(zeit) Wegweiser konnte nicht aktualisiert werden – nächster Versuch in 30 s"; return 1
  fi
}

fehler_3000=0; fehler_3210=0
gist_offen=0
echo "$(zeit) Wächter gestartet (Projekt: $PROJEKT)"
while true; do
  [ -n "$DEMO_ORDNER" ] && server_pruefen 3000 "$DEMO_ORDNER" ./server.js /tmp/akki-demo.log
  server_pruefen 3210 "$PROJEKT" server.js /tmp/akki.log
  for p in 3000 3210; do
    if [ "$p" = 3000 ]; then f=/tmp/akki-tunnel-url.txt; l=/tmp/akki-tunnel.log; else f=/tmp/akki-tunnel-dev-url.txt; l=/tmp/akki-tunnel-dev.log; fi
    u=$(cat "$f" 2>/dev/null)
    if [ -n "$u" ] && [ "$(code "$u/")" = "200" ]; then eval "fehler_$p=0"; continue; fi
    eval "n=\$(( fehler_$p + 1 ))"; eval "fehler_$p=$n"
    echo "$(zeit) Tunnel $p nicht erreichbar (${n}x)"
    if [ "$n" -ge 2 ]; then tunnel_starten "$p" "$l" "$f"; eval "fehler_$p=0"; gist_offen=1; fi
  done
  if [ "$gist_offen" = 1 ]; then gist_aktualisieren && gist_offen=0; fi
  sleep 30
done
