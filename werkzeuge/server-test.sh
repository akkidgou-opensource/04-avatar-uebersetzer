#!/bin/bash
# Mitano. – Stabilitätstest für server.js (nur ENTWICKLUNG, Port 3210). Nur Testdaten, keine Inhalte im Log.
# Aufruf (im Projektordner):
#   bash werkzeuge/server-test.sh            # alles ohne D-ID (kostet kein D-ID-Guthaben)
#   bash werkzeuge/server-test.sh --did      # zusätzlich: Doppelstart, SSE-Abbruch, Neustart mit offener D-ID-Sitzung
#                                            # (startet 3 D-ID-Sitzungen, alle werden sofort wieder gelöscht;
#                                            #  startet den Entwicklungs-Server dabei neu)
# Passwörter kommen aus .env und werden nie ausgegeben.

set -u
cd "$(dirname "$0")/.." || exit 1
BASIS="${BASIS:-http://localhost:3210}"
LOG="${LOG:-/tmp/akki.log}"
MIT_DID=0; [ "${1:-}" = "--did" ] && MIT_DID=1
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ok=0; fehl=0
declare -a ERGEBNIS=()
pruefe() {  # $1 Name, $2 erwartet, $3 tatsächlich
  if [ "$2" = "$3" ]; then ok=$((ok+1)); ERGEBNIS+=("OK    | $1 | $3")
  else fehl=$((fehl+1)); ERGEBNIS+=("FEHLER| $1 | erwartet $2, bekommen $3"); fi
}
env_wert() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
ADMIN="$(env_wert ADMIN_USER)"; DEMO="$(env_wert DEMO_USER)"
export T_ADMIN_PW="$(env_wert ADMIN_PASSWORD)" T_DEMO_PW="$(env_wert DEMO_PASSWORD)"
H=(-H 'X-Requested-With: akki-app' -H 'Content-Type: application/json')

# JSON mit Passwort über stdin (nicht in der Prozessliste sichtbar). $1 Name, $2 Name der Passwort-Variable
login_json() { NAME="$1" PWV="$2" node -e 'process.stdout.write(JSON.stringify({username:process.env.NAME,password:process.env[process.env.PWV]||"",consent:true}))'; }
# $1 Cookie-Datei, $2 Methode, $3 Pfad, [$4 JSON], weitere Argumente an curl → gibt Statuscode aus
anfrage() {
  local jar="$1" m="$2" p="$3" body="${4:-}"; shift 4 2>/dev/null || shift $#
  if [ -n "$body" ]; then
    curl -s -o "$TMP/antwort" -w '%{http_code}' -b "$jar" -c "$jar" -X "$m" "${H[@]}" --data-binary "$body" "$@" "$BASIS$p"
  else
    curl -s -o "$TMP/antwort" -w '%{http_code}' -b "$jar" -c "$jar" -X "$m" "${H[@]}" "$@" "$BASIS$p"
  fi
}
anmelden() {  # $1 Cookie-Datei, $2 Nutzer, $3 Passwort-Variable, [$4 Client-IP für CF-Connecting-IP]
  local extra=(); [ -n "${4:-}" ] && extra=(-H "CF-Connecting-IP: $4")
  login_json "$2" "$3" | curl -s -o /dev/null -w '%{http_code}' -b "$1" -c "$1" -X POST "${H[@]}" ${extra[@]+"${extra[@]}"} --data-binary @- "$BASIS/api/login"
}
server_neu() {
  pkill -f 'node --env-file=.env server.js'; sleep 1
  nohup node --env-file=.env server.js >> "$LOG" 2>&1 &
  for _ in $(seq 1 20); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASIS/api/gesundheit")" = 200 ] && return 0; sleep 0.5; done
  return 1
}
credits() { curl -s --max-time 10 -H "Authorization: Basic $(env_wert DID_API_KEY)" https://api.d-id.com/credits | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).remaining)}catch{console.log("?")}})'; }

echo "Test gegen $BASIS (Log: $LOG)"
A="$TMP/admin.txt"; D="$TMP/demo.txt"; X="$TMP/ohne.txt"; touch "$A" "$D" "$X"

# ---------- 1. Gesundheit ----------
pruefe "GET /api/gesundheit ohne Login" 200 "$(anfrage "$X" GET /api/gesundheit)"
pruefe "Gesundheit: nur ok/version/laufzeit" "laufzeit,ok,version" "$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1]))).sort().join())' "$TMP/antwort")"

# ---------- 2. Anmeldung und Rollen ----------
pruefe "GET /api/me ohne Login → 401" 401 "$(anfrage "$X" GET /api/me)"
pruefe "GET /api/unterlagen ohne Login → 401" 401 "$(anfrage "$X" GET /api/unterlagen)"
pruefe "Login ohne X-Requested-With → 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{}' "$BASIS/api/login")"
pruefe "Login falsches Passwort → 401" 401 "$(login_json "$ADMIN" KEINS | curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H 'CF-Connecting-IP: 198.51.100.7' --data-binary @- "$BASIS/api/login")"
pruefe "Login kaputtes JSON → 400" 400 "$(anfrage "$X" POST /api/login '{kaputt')"
pruefe "Login JSON null → 400" 400 "$(anfrage "$X" POST /api/login 'null')"
pruefe "Login admin" 200 "$(anmelden "$A" "$ADMIN" T_ADMIN_PW)"
pruefe "Login demo" 200 "$(anmelden "$D" "$DEMO" T_DEMO_PW)"
pruefe "GET /api/me admin" 200 "$(anfrage "$A" GET /api/me)"
# Testnutzer mit Rolle „arzt“ (kein Admin) anlegen, prüfen, wieder löschen
export T_TEST_PW="test-$(openssl rand -hex 8)"
T="$TMP/test.txt"; touch "$T"
NEU=$(NAME=stabtest PWV=T_TEST_PW node -e 'process.stdout.write(JSON.stringify({username:process.env.NAME,password:process.env[process.env.PWV],role:"arzt"}))')
anfrage "$A" DELETE /api/nutzer/stabtest >/dev/null
pruefe "Admin legt Testnutzer (arzt) an" 201 "$(anfrage "$A" POST /api/nutzer "$NEU")"
pruefe "Login Testnutzer" 200 "$(anmelden "$T" stabtest T_TEST_PW)"
pruefe "Arzt: GET /api/nutzer → 403" 403 "$(anfrage "$T" GET /api/nutzer)"
pruefe "Arzt: GET /api/admin/patienten → 403" 403 "$(anfrage "$T" GET /api/admin/patienten)"
pruefe "Arzt: Anweisung ändern → 403" 403 "$(anfrage "$T" PUT /api/gespraech/einstellungen '{"systemprompt":"x"}')"
pruefe "Arzt: kein Test-Patient → 404" 404 "$(anfrage "$T" GET /api/unterlagen)"
pruefe "Admin löscht Testnutzer" 200 "$(anfrage "$A" DELETE /api/nutzer/stabtest)"
pruefe "Gelöschter Nutzer ist abgemeldet → 401" 401 "$(anfrage "$T" GET /api/me)"

# ---------- 3. Nur eigener Patient, Pfad-Traversal, 404 ----------
anfrage "$A" GET /api/unterlagen >/dev/null; PA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).patientId)' "$TMP/antwort")
anfrage "$D" GET /api/unterlagen >/dev/null; PD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).patientId)' "$TMP/antwort")
pruefe "admin sieht p2" p2 "$PA"
pruefe "demo sieht p-demo" p-demo "$PD"
ERSTE=$(anfrage "$A" GET /api/unterlagen >/dev/null; node -e 'const u=JSON.parse(require("fs").readFileSync(process.argv[1])).unterlagen;console.log((u[0]||{}).docId||"")' "$TMP/antwort")
[ -n "$ERSTE" ] && pruefe "demo kann Dokument von p2 nicht lesen" 404 "$(anfrage "$D" GET "/api/unterlagen/$ERSTE")"
pruefe "Traversal Unterlagen-ID → 400" 400 "$(anfrage "$A" GET '/api/unterlagen/..%2F..%2Fnutzer')"
pruefe "Traversal Seitenbild → 400" 400 "$(anfrage "$A" GET '/api/unterlagen/..%2Fx/bild/1')"
pruefe "Kaputte %-Folge → 400" 400 "$(anfrage "$A" GET '/api/unterlagen/%E0%A4%A')"
pruefe "Traversal Standbild → 404" 404 "$(anfrage "$A" GET '/api/avatar/standbild/..%2F..%2Fnutzer')"
pruefe "Traversal Patient-Dokument → 400" 400 "$(anfrage "$A" GET '/api/patient/dokument/..%2F..%2Fnutzer')"
pruefe "Statisch: .env nicht erreichbar" 403 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASIS/..%2f.env")"
pruefe "Statisch: kaputte %-Folge → 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$BASIS/%E0%A4%A")"
pruefe "Unbekannte API-Route → 404" 404 "$(anfrage "$A" GET /api/gibtsnicht)"

# ---------- 4. Zu große Anfragen ----------
GROSS="{\"x\":\"$(head -c 30000 /dev/zero | tr '\0' a)\"}"
pruefe "Profil mit 30 KB → 413" 413 "$(anfrage "$A" PUT /api/profil "$GROSS")"
# Angekündigte Größe 13 MB (Content-Length) – der Server lehnt ab, bevor er liest (kein Plattenplatz nötig).
pruefe "Kontext mit angekündigten 13 MB → 413" 413 "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -b "$A" "${H[@]}" -H 'Content-Length: 13000000' -d '{}' "$BASIS/api/kontext")"
# Tatsächlich gesendete 2 MB an eine Route mit 20 KB Grenze (Abbruch während des Lesens)
pruefe "Login mit 2 MB → 413" 413 "$(head -c 2000000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '%{http_code}' "${H[@]}" --data-binary @- "$BASIS/api/login")"
pruefe "Server lebt nach 413" 200 "$(anfrage "$X" GET /api/gesundheit)"

# ---------- 5. Cookie Secure hinter https-Tunnel ----------
SC=$(login_json "$DEMO" T_DEMO_PW | curl -s -D - -o /dev/null "${H[@]}" -H 'X-Forwarded-Proto: https' --data-binary @- "$BASIS/api/login" | grep -i '^set-cookie' | grep -c 'Secure')
pruefe "Cookie hat Secure bei X-Forwarded-Proto https" 1 "$SC"
SC=$(login_json "$DEMO" T_DEMO_PW | curl -s -D - -o /dev/null "${H[@]}" --data-binary @- "$BASIS/api/login" | grep -i '^set-cookie' | grep -c 'Secure')
pruefe "Cookie ohne Secure bei http (lokal)" 0 "$SC"
pruefe "CSP-Kopfzeile vorhanden" 1 "$(curl -s -D - -o /dev/null "$BASIS/" | grep -ci '^content-security-policy: default-src')"
pruefe "Kein Framing (X-Frame-Options)" 1 "$(curl -s -D - -o /dev/null "$BASIS/" | grep -ci '^x-frame-options: DENY')"

# ---------- 6. Gleichzeitige Anfragen (20 parallel) ----------
declare -a PIDS=()
for i in $(seq 1 20); do
  ( c=$(curl -s -o /dev/null -w '%{http_code}' -b "$A" "${H[@]}" "$BASIS/api/unterlagen"); echo "$c" > "$TMP/par-get-$i" ) & PIDS+=($!)
  ( c=$(curl -s -o /dev/null -w '%{http_code}' -b "$A" -X PUT "${H[@]}" -d '{"sprache":"de"}' "$BASIS/api/profil"); echo "$c" > "$TMP/par-put-$i" ) & PIDS+=($!)
done
wait "${PIDS[@]}"
pruefe "20 parallele GET /api/unterlagen alle 200" 20 "$(cat "$TMP"/par-get-* | grep -c '^200$')"
pruefe "20 parallele PUT /api/profil alle 200" 20 "$(cat "$TMP"/par-put-* | grep -c '^200$')"
pruefe "lokal/profile.json ist gültiges JSON" ja "$(node -e 'try{JSON.parse(require("fs").readFileSync("lokal/profile.json","utf8"));console.log("ja")}catch{console.log("nein")}')"
pruefe "Keine liegengebliebenen .tmp-Dateien in lokal/" 0 "$(find lokal -maxdepth 1 -name '*.tmp' | wc -l | tr -d ' ')"

# ---------- 7. Bremse (429) je Client-IP ----------
declare -a CODES=()
for i in $(seq 1 25); do CODES+=("$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H 'CF-Connecting-IP: 203.0.113.9' -d '{"username":"niemand","password":"x","consent":true}' "$BASIS/api/login")"); done
pruefe "Login-Bremse: 25 Versuche → letzter 429" 429 "${CODES[24]}"
pruefe "Login-Bremse: andere IP nicht betroffen" 200 "$(anmelden "$TMP/ip2.txt" "$DEMO" T_DEMO_PW 203.0.113.10)"
for i in $(seq 1 5); do login_json "$DEMO" KEINS | curl -s -o /dev/null "${H[@]}" -H 'CF-Connecting-IP: 203.0.113.11' --data-binary @- "$BASIS/api/login"; done
pruefe "5 Fehlversuche → Sperre (429) für diese IP" 429 "$(anmelden "$TMP/ip3.txt" "$DEMO" T_DEMO_PW 203.0.113.11)"
pruefe "Sperre gilt nicht für andere IP" 200 "$(anmelden "$TMP/ip4.txt" "$DEMO" T_DEMO_PW 203.0.113.12)"
LAN=$(ipconfig getifaddr en0 2>/dev/null)
if [ -n "$LAN" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$LAN:3210/api/gesundheit")" = 200 ]; then
  # Über die LAN-Adresse ist die Verbindung NICHT von 127.0.0.1 → CF-Connecting-IP muss ignoriert werden.
  for i in $(seq 1 21); do c=$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H "CF-Connecting-IP: 192.0.2.$i" -d '{"username":"niemand","password":"x","consent":true}' "http://$LAN:3210/api/login"); done
  pruefe "Gefälschte CF-Connecting-IP von außen wird ignoriert" 429 "$c"
fi

# ---------- 8. Sitzung überlebt Neustart ----------
if [ "$MIT_DID" = 0 ]; then
  server_neu || echo "Server startet nicht!"
  pruefe "Nach Neustart noch angemeldet (admin)" 200 "$(anfrage "$A" GET /api/me)"
fi

# ---------- 9. D-ID: Doppelstart, SSE-Abbruch, Neustart mit offener Sitzung ----------
if [ "$MIT_DID" = 1 ]; then
  echo "D-ID-Guthaben vorher: $(credits)"
  # a) Doppelstart: zwei gleichzeitige Starts derselben Sitzung → einer 200, einer 409 (überholt, sofort gelöscht)
  ( anfrage "$A" POST /api/avatar/start '{}' > "$TMP/start1"; cp "$TMP/antwort" "$TMP/start1.json" ) &
  p1=$!; sleep 0.05
  ( curl -s -o "$TMP/start2.json" -w '%{http_code}' -b "$A" -X POST "${H[@]}" -d '{}' "$BASIS/api/avatar/start" > "$TMP/start2" ) &
  wait $p1 $!
  pruefe "Doppelstart: Codes" "200 409" "$(sort <(cat "$TMP/start1") <(cat "$TMP/start2") | tr '\n' ' ' | sed 's/ $//')"
  pruefe "Log: überholte D-ID-Sitzung gelöscht" 1 "$(tail -30 "$LOG" | grep -c 'überholter Verbindungsaufbau')"
  # b) SSE-Strom nach 2 s abbrechen (wie Unterbrechen im freihändigen Gespräch)
  curl -s -o /dev/null --max-time 2 -b "$A" -X POST "${H[@]}" -d '{"nachricht":"Welche Medikamente nehme ich laut meinen Briefen und warum?","strom":true}' "$BASIS/api/avatar/gespraech"
  sleep 8
  pruefe "Log: SSE-Abbruch sauber beendet" 1 "$(tail -20 "$LOG" | grep -c 'vom Browser abgebrochen')"
  pruefe "Gedächtnis: Abbruch ohne Doppel-Eintrag" ok "$(anfrage "$A" GET /api/gespraech/protokoll >/dev/null; node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1])).eintraege;console.log(e.length%2===0?"ok":"ungerade:"+e.length)' "$TMP/antwort")"
  # c) Neustart (SIGTERM) mit offener D-ID-Sitzung → Sitzung wird gelöscht
  pkill -TERM -f 'node --env-file=.env server.js'; sleep 4
  pruefe "Log: SIGTERM löscht offene D-ID-Sitzung" 1 "$(tail -5 "$LOG" | grep -c 'Beenden: 1 von 1 D-ID-Sitzung(en) gelöscht')"
  server_neu || echo "Server startet nicht!"
  pruefe "Nach Neustart noch angemeldet (admin)" 200 "$(anfrage "$A" GET /api/me)"
  pruefe "Nach Neustart: Gespräch meldet nicht_verbunden (409)" 409 "$(anfrage "$A" POST /api/avatar/gespraech '{"nachricht":"Hallo"}')"
  # d) Start + Abmelden → D-ID-Sitzung wird gelöscht
  pruefe "Avatar-Start" 200 "$(anfrage "$A" POST /api/avatar/start '{}')"
  pruefe "Abmelden" 200 "$(anfrage "$A" POST /api/logout '{}')"
  sleep 3
  echo "D-ID-Guthaben nachher: $(credits)"
fi

echo
printf '%s\n' "${ERGEBNIS[@]}"
echo
echo "Ergebnis: $ok bestanden, $fehl fehlgeschlagen."
[ "$fehl" = 0 ]
