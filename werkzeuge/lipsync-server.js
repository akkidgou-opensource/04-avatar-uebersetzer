// Kleiner Testserver NUR für die Lippensynchronitäts-Messung (nicht Teil der App).
// Start: node --env-file=.env werkzeuge/lipsync-server.js   → http://127.0.0.1:3200/lipsync-test.html
// Legt ohne Login eine D-ID-V2-Sitzung an bzw. löscht sie. Lauscht nur auf 127.0.0.1.
// Der D-ID-Schlüssel bleibt im Server; geloggt werden nur Sitzungs-IDs, keine Inhalte.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = 3200;
const KEY = process.env.DID_API_KEY;
const PUB = join(import.meta.dirname, '..', 'public');
const AGENTEN = new Set(['v2_agt_JFLmlsPR', 'v2_agt_btPSpaIx', 'v2_agt_JQwAQann']);
const offen = new Set();
const TYP = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

async function did(method, pfad, body) {
  const r = await fetch('https://api.d-id.com' + pfad, {
    method, headers: { Authorization: 'Basic ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, j };
}
async function allesLoeschen() {
  for (const id of offen) { await did('DELETE', '/v2/agents/sessions/' + encodeURIComponent(id)).catch(() => {}); console.log('gelöscht', id); }
  offen.clear();
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname.startsWith('/sitzung/')) {
      const agent = url.pathname.split('/')[2];
      if (!AGENTEN.has(agent)) { res.writeHead(400); return res.end('agent?'); }
      const r = await did('POST', `/v2/agents/${agent}/sessions`, {});
      if (r.j?.id) { offen.add(r.j.id); console.log('angelegt', r.j.id); }
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.j?.id ? { id: r.j.id, url: r.j.session_url, token: r.j.session_token } : { fehler: r.j?.kind || r.status }));
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/sitzung/')) {
      const id = url.pathname.split('/')[2];
      const r = await did('DELETE', '/v2/agents/sessions/' + encodeURIComponent(id));
      offen.delete(id); console.log('gelöscht', id, r.status);
      res.writeHead(200); return res.end(String(r.status));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/ergebnis/') && process.env.LIPSYNC_AUS) {
      // Messergebnis der Testseite (Zahlen + Testbilder) in eine Datei schreiben
      const name = url.pathname.split('/')[2].replace(/[^a-z0-9_-]/gi, '');
      const teile = []; for await (const t of req) teile.push(t);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(process.env.LIPSYNC_AUS, name + '.json'), Buffer.concat(teile));
      console.log('ergebnis', name);
      res.writeHead(200); return res.end('ok');
    }
    if (req.method === 'GET' && url.pathname === '/credits') {
      const r = await did('GET', '/credits');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ remaining: r.j?.remaining, total: r.j?.total }));
    }
    const pfad = normalize(url.pathname === '/' ? '/lipsync-test.html' : url.pathname);
    if (req.method === 'GET' && (pfad === '/lipsync-test.html' || pfad.startsWith('/vendor/'))) {
      const daten = await readFile(join(PUB, pfad));
      res.writeHead(200, { 'Content-Type': TYP[extname(pfad)] || 'application/octet-stream' });
      return res.end(daten);
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end('fehler'); }
}).listen(PORT, '127.0.0.1', () => console.log('Lipsync-Testserver: http://127.0.0.1:' + PORT));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await allesLoeschen(); process.exit(0); });
