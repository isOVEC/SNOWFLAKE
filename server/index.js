// HTTP static server + WebSocket game server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Game = require('./game');
const S = require('../public/shared.js');

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SAVE_FILE = path.join(DATA_DIR, 'world.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const game = new Game();
let saved = null;
try {
  saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  console.log(`Loaded world: ${saved.profiles.length} players, ${saved.buildings.length} buildings`);
} catch (e) { /* fresh world */ }
game.init(saved);

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVE_FILE + '.tmp', JSON.stringify(game.serialize()));
    fs.renameSync(SAVE_FILE + '.tmp', SAVE_FILE);
  } catch (e) { console.error('save failed', e.message); }
}
setInterval(save, 20000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

const wss = new WebSocketServer({ server, perMessageDeflate: { threshold: 512 }, maxPayload: 4096 });
wss.on('connection', (ws) => {
  const client = {
    ws, pid: 0, prof: null, hero: null, inputs: [], events: [],
    sendRaw(s) { if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(s); },
    send(o) { this.sendRaw(JSON.stringify(o)); },
  };
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    try { game.onMessage(client, msg); } catch (e) { console.error(e); }
  });
  ws.on('close', () => game.leave(client));
  ws.on('error', () => {});
});

// fixed-step loop
let last = process.hrtime.bigint();
let acc = 0;
const stepNs = 1e9 / S.TICK;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Number(now - last);
  last = now;
  let n = 0;
  while (acc >= stepNs && n < 5) {
    try { game.tick(); } catch (e) { console.error(e); }
    acc -= stepNs;
    n++;
  }
  if (n === 5) acc = 0;
}, 5);

server.listen(PORT, () => console.log(`Emberfall running on http://localhost:${PORT}`));
