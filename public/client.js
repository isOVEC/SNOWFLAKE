/* global S */
'use strict';

// =================================================================== setup
const cv = document.getElementById('game');
let ctx = cv.getContext('2d');
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAng = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let W = 0, H = 0, DPR = 1, PXS = 3;
const cam = { x: S.SPAWN.x, y: S.SPAWN.y, scale: 1 };
const buf = document.createElement('canvas');
let g = buf.getContext('2d');
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  // integer screen pixels per art pixel keeps every pixel the same size
  PXS = Math.max(2, Math.round(Math.max(W / 1700, H / 1000) * PIX.ART * DPR + 0.15));
  cam.scale = PXS / PIX.ART / DPR;
  buf.width = Math.ceil(cv.width / PXS) + 2;
  buf.height = Math.ceil(cv.height / PXS) + 2;
  sendView();
}
window.addEventListener('resize', resize);

// =================================================================== state
let ws = null;
let myId = 0;
let joined = false;
let token = null;
try { token = localStorage.getItem('ef_token'); } catch (e) { /* ignore */ }
let selCls = 'warrior';
const snaps = [];
let timeOffset = null;
const INTERP = 110;
let statics = [];
const staticById = new Map();
let pf = null; // profile data
let me = null; // my hero data
let info = { names: {}, lb: [], bosses: [], ths: [], allies: [], online: 0 };
const pred = { x: S.SPAWN.x, y: S.SPAWN.y };
const vis = { x: 0, y: 0 };
let pending = [];
let seq = 0;
let accum = 0;
let dead = false;
let deathInfo = null;
let myAim = 0;
let lastAtkN = {};
const atkAnim = new Map(); // unit id -> time of last attack
const hurtFlash = new Map();
const lastHp = new Map();
let buildMode = null;
let hovered = null;
let demolishArm = 0;
let chatting = false;
let lastInput = null;

const keys = {};
const mouse = { x: 0, y: 0, down: false, right: false, wx: 0, wy: 0 };

// =================================================================== world data (local)
const TN = S.W / S.TILE;
const biomeGrid = new Uint8Array(TN * TN);
for (let ty = 0; ty < TN; ty++) for (let tx = 0; tx < TN; tx++) biomeGrid[ty * TN + tx] = S.biomeAt((tx + 0.5) * S.TILE, (ty + 0.5) * S.TILE);
const biomeAtTile = (tx, ty) => biomeGrid[clamp(ty, 0, TN - 1) * TN + clamp(tx, 0, TN - 1)];
const biomeAtPos = (x, y) => biomeAtTile(Math.floor(x / S.TILE), Math.floor(y / S.TILE));

// ---- ground chunks (pixel art, generated on demand and cached)
const chunkCache = new Map();
function getChunk(cx, cy) {
  const k = cx * 1000 + cy;
  let c = chunkCache.get(k);
  if (c) { chunkCache.delete(k); chunkCache.set(k, c); return c; }
  c = PIX.groundChunk(cx, cy, biomeAtPos);
  chunkCache.set(k, c);
  if (chunkCache.size > 40) chunkCache.delete(chunkCache.keys().next().value);
  return c;
}

// ---- minimap background
const mmBg = document.createElement('canvas');
mmBg.width = mmBg.height = 200;
(function () {
  const g = mmBg.getContext('2d');
  const img = g.createImageData(200, 200);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    const b = biomeAtPos((x + 0.5) * S.W / 200, (y + 0.5) * S.H / 200);
    const c = S.BIOME_COLORS[b][0];
    const i = (y * 200 + x) * 4;
    img.data[i] = parseInt(c.slice(1, 3), 16) * 0.8;
    img.data[i + 1] = parseInt(c.slice(3, 5), 16) * 0.8;
    img.data[i + 2] = parseInt(c.slice(5, 7), 16) * 0.8;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
})();

// =================================================================== network
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  $('conn').textContent = 'Подключение к миру…';
  $('play').disabled = true;
  ws.onopen = () => {
    $('conn').textContent = 'Мир ждёт тебя';
    $('play').disabled = false;
    if (joined) join();
  };
  ws.onclose = () => {
    $('conn').textContent = 'Связь потеряна. Переподключение…';
    $('play').disabled = true;
    snaps.length = 0;
    timeOffset = null;
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function sendView() {
  if (!joined) return;
  send({ t: 'view', w: W / cam.scale / 2, h: H / cam.scale / 2 });
}

function join() {
  const name = $('name').value.trim() || 'Странник';
  const clan = $('clan').value.trim();
  try { localStorage.setItem('ef_name', name); localStorage.setItem('ef_clan', clan); localStorage.setItem('ef_cls', selCls); } catch (e) { /* ignore */ }
  send({ t: 'join', name, clan, cls: selCls, token });
}

function onMsg(m) {
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      token = m.token;
      try { localStorage.setItem('ef_token', token); } catch (e) { /* ignore */ }
      joined = true;
      dead = false;
      pending = [];
      $('menu').classList.add('hidden');
      $('death').classList.add('hidden');
      $('hud').classList.remove('hidden');
      resize();
      break;
    case 's': onSnap(m); break;
    case 'info':
      info = m;
      renderLeaderboard();
      break;
    case 'dead':
      dead = true;
      deathInfo = { by: m.by, lost: m.lost, until: performance.now() + m.wait * 1000 };
      showDeath();
      break;
    case 'feed': addFeed(m.m, m.big); break;
    case 'chat': addChat(m); break;
  }
}

function onSnap(m) {
  const now = performance.now();
  const off = now - m.tm;
  if (timeOffset === null || off < timeOffset) timeOffset = off;
  else timeOffset += (off - timeOffset) * 0.002;

  const units = new Map();
  for (const u of m.u) units.set(u[0], u);
  const projs = new Map();
  for (const p of m.p) projs.set(p[0], p);
  snaps.push({ tm: m.tm, units, projs });
  while (snaps.length > 30) snaps.shift();

  // attack animations & hurt flashes
  for (const u of m.u) {
    const id = u[0];
    const a = u[8];
    if (lastAtkN[id] !== undefined && a !== lastAtkN[id] && u[1] !== 'B') atkAnim.set(id, now);
    lastAtkN[id] = a;
    const prev = lastHp.get(id);
    if (prev !== undefined && u[6] < prev) hurtFlash.set(id, now);
    lastHp.set(id, u[6]);
  }

  if (m.st) {
    statics = m.st.map((s) => s[1] === 'n'
      ? { id: s[0], k: 'n', type: s[2], x: s[3], y: s[4], r: s[5], hp: s[6], biome: s[7], v: s[8] }
      : { id: s[0], k: 'b', type: s[2], x: s[3], y: s[4], hs: S.BUILDINGS[s[2]].size / 2, lvl: s[5], hp: s[6], rel: s[7], pid: s[8], aim: s[9] });
    staticById.clear();
    for (const s of statics) staticById.set(s.id, s);
  }
  pf = Object.assign(pf || {}, m.pf);
  for (const f of m.fx) spawnFx(f);
  if (m.ev) for (const e of m.ev) onEvent(e);

  if (m.me) {
    me = m.me;
    if (!me.dead) {
      if (dead) { dead = false; }
      // reconcile prediction
      const oldX = pred.x + vis.x, oldY = pred.y + vis.y;
      pred.x = me.x; pred.y = me.y;
      pending = pending.filter((i) => i.s > me.ack);
      const list = nearStatics(pred.x, pred.y, 400);
      for (const inp of pending) S.moveHero(pred, inp, me.spd, myRadius(), list, canPass);
      vis.x = oldX - pred.x; vis.y = oldY - pred.y;
      if (Math.hypot(vis.x, vis.y) > 250) vis.x = vis.y = 0;
    }
  }
}

function myRadius() { return pf ? S.CLASSES[pf.cls].r : 22; }
function canPass(s) { return s.type === 'wall' && (s.rel === 0 || s.rel === 1); }
function nearStatics(x, y, r) {
  const out = [];
  for (const s of statics) {
    const e = s.k === 'b' ? s.hs : s.r;
    if (Math.abs(s.x - x) < r + e && Math.abs(s.y - y) < r + e) out.push(s);
  }
  return out;
}

function onEvent(e) {
  if (e.k === 'msg') toast(e.m);
  else if (e.k === 'res') {
    if (e.v > 0) floatText(e.x, e.y, `+${e.v >= 10 ? Math.round(e.v) : e.v.toFixed(1)} ${S.RES_ICON[e.r]}`, e.r === 'gold' ? '#ffd76a' : e.r === 'wood' ? '#d7f59a' : '#e4e4e4', 1.1);
    else if (e.full) floatText(e.x, e.y, 'Склад полон!', '#ff9d7a', 1.2);
  }
}

// =================================================================== fx
const particles = [];
const texts = [];
const rings = [];
function floatText(x, y, s, color, life, size) {
  texts.push({ x: x + (Math.random() - 0.5) * 16, y, s, color, t: 0, life: life || 0.9, size: size || 16 });
  if (texts.length > 120) texts.shift();
}
function burst(x, y, n, colors, speed, life, size) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, v = speed * (0.3 + Math.random() * 0.7);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + Math.random() * 0.6),
      c: colors[(Math.random() * colors.length) | 0], s: size * (0.6 + Math.random() * 0.8) });
  }
  if (particles.length > 900) particles.splice(0, particles.length - 900);
}
const HIT_COLORS = [['#ffffff', '#ffe0c0'], ['#6bbf4a', '#3e8a2f', '#8c5a2b'], ['#9a948a', '#c8c2b8', '#6d6860'], ['#ffd34a', '#fff1a0', '#b88a1a'], ['#b8a48a', '#8a7a64', '#ffcc88']];
function spawnFx(f) {
  const [k, x, y, a, b] = f;
  switch (k) {
    case 'hit':
      burst(x, y, 5, HIT_COLORS[b] || HIT_COLORS[0], 160, 0.35, 4);
      if (a > 0) floatText(x, y, String(a), b === 4 ? '#ffb070' : '#ffffff', 0.7, 15);
      break;
    case 'death': {
      const cols = [['#ff5a4a', '#ffffff', '#ffd0a0'], ['#6bbf4a', '#3e8a2f', '#8c5a2b'], ['#9a948a', '#c8c2b8'], ['#8a7a64', '#b8a48a', '#5a4a3a', '#ff9a3d'], ['#ffd34a', '#fff1a0'], ['#c9c0b0', '#8a8070', '#ff8060']][a] || ['#fff'];
      burst(x, y, a === 3 ? 40 : 18, cols, a === 3 ? 260 : 200, 0.7, a === 3 ? 7 : 5);
      break;
    }
    case 'boom':
      rings.push({ x, y, r0: 10, r1: a, t: 0, life: 0.35, c: b ? '#c08cff' : '#ff9a3d', fill: true });
      burst(x, y, 16, b ? ['#e2c8ff', '#9b5cff', '#ffffff'] : ['#ffd070', '#ff7a2d', '#ffec9a', '#ff4a1a'], 260, 0.45, 6);
      break;
    case 'nova':
      rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.45, c: '#9ee8ff', fill: true });
      burst(x, y, 40, ['#d9f7ff', '#8fdcff', '#ffffff'], 420, 0.5, 5);
      break;
    case 'slam':
      rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.4, c: '#d9b48a', fill: true });
      burst(x, y, 24, ['#b09070', '#806040', '#d8c0a0'], 300, 0.5, 7);
      break;
    case 'dash': burst(x, y, 14, ['#ffffff', '#dfe8ff'], 180, 0.35, 5); break;
    case 'blink': rings.push({ x, y, r0: 60, r1: 5, t: 0, life: 0.4, c: '#b48cff' }); burst(x, y, 20, ['#d8c0ff', '#8a5cff', '#fff'], 220, 0.5, 5); break;
    case 'lvl': rings.push({ x, y, r0: a, r1: a + 70, t: 0, life: 0.7, c: '#ffd76a' }); burst(x, y, 26, ['#ffe89a', '#ffd76a', '#fff'], 200, 0.8, 5); break;
    case 'build': rings.push({ x, y, r0: a * 0.3, r1: a * 0.9, t: 0, life: 0.45, c: '#fff2c8' }); burst(x, y, 18, ['#c8b08a', '#8a7050', '#fff'], 200, 0.5, 6); break;
    case 'bossdeath':
      for (let i = 0; i < 3; i++) rings.push({ x, y, r0: a, r1: a * 4 + i * 120, t: -i * 0.15, life: 0.9, c: '#ffd76a' });
      burst(x, y, 90, ['#ffd76a', '#ff7a3d', '#ffffff', '#ff4a1a'], 500, 1.2, 8);
      break;
  }
}

// =================================================================== input
window.addEventListener('keydown', (e) => {
  if (!joined) { if (e.key === 'Enter' && document.activeElement !== $('chatin')) startGame(); return; }
  if (chatting) {
    if (e.key === 'Enter') {
      const v = $('chatin').value.trim();
      if (v) send({ t: 'chat', m: v });
      $('chatin').value = '';
      $('chatin').blur();
    } else if (e.key === 'Escape') { $('chatin').blur(); }
    return;
  }
  if (e.key === 'Enter') { $('chatin').focus(); e.preventDefault(); return; }
  keys[e.code] = true;
  if (e.code.startsWith('Digit')) {
    const i = +e.code.slice(5) - 1;
    if (i >= 0 && i < S.BUILD_ORDER.length) selectBuild(S.BUILD_ORDER[i]);
  }
  if (e.code === 'Escape') { buildMode = null; closeHelp(); renderBuildBar(); }
  if (e.code === 'KeyH' || e.code === 'F1') { e.preventDefault(); toggleHelp(); }
  if (e.code === 'KeyE' && hovered && hovered.k === 'b' && hovered.rel === 0) send({ t: 'up', id: hovered.id });
  if (e.code === 'KeyX' && hovered && hovered.k === 'b' && hovered.rel === 0 && hovered.type !== 'townhall') {
    if (demolishArm && performance.now() - demolishArm < 1500) { send({ t: 'del', id: hovered.id }); demolishArm = 0; }
    else { demolishArm = performance.now(); toast('Нажмите X ещё раз, чтобы снести'); }
  }
  if (e.code === 'KeyR') send({ t: 'recall' });
  if (e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = mouse.right = false; });
cv.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
cv.addEventListener('mousedown', (e) => {
  if (e.button === 0) {
    mouse.down = true;
    if (buildMode) placeBuilding();
  } else if (e.button === 2) {
    if (buildMode) { buildMode = null; renderBuildBar(); } else mouse.right = true;
  }
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; if (e.button === 2) mouse.right = false; });
cv.addEventListener('contextmenu', (e) => e.preventDefault());
$('chatin').addEventListener('focus', () => { chatting = true; });
$('chatin').addEventListener('blur', () => { chatting = false; });

let lastWallCell = '';
function placeBuilding() {
  if (!buildMode) return;
  const x = S.snap(buildMode, mouse.wx), y = S.snap(buildMode, mouse.wy);
  lastWallCell = x + ',' + y;
  send({ t: 'build', type: buildMode, x, y });
  if (buildMode !== 'wall' && !keys.ShiftLeft && !keys.ShiftRight) { buildMode = null; renderBuildBar(); }
}

function selectBuild(type) {
  buildMode = buildMode === type ? null : type;
  renderBuildBar();
}

// =================================================================== fixed-step input + prediction
function inputStep() {
  let mx = 0, my = 0;
  if (!chatting) {
    if (keys.KeyW || keys.ArrowUp) my -= 1;
    if (keys.KeyS || keys.ArrowDown) my += 1;
    if (keys.KeyA || keys.ArrowLeft) mx -= 1;
    if (keys.KeyD || keys.ArrowRight) mx += 1;
  }
  const inp = {
    t: 'i', s: ++seq, mx, my, a: Math.round(myAim * 1000) / 1000,
    f: mouse.down && !buildMode ? 1 : 0,
    ab: (mouse.right || (keys.Space && !chatting)) ? 1 : 0,
  };
  send(inp);
  if (me && !me.dead && !dead) {
    pending.push(inp);
    if (pending.length > 120) pending.shift();
    S.moveHero(pred, inp, me.spd, myRadius(), nearStatics(pred.x, pred.y, 300), canPass);
  }
  lastInput = inp;
}

// =================================================================== interpolation
function sampleWorld(now) {
  if (!snaps.length || timeOffset === null) return null;
  const rt = now - timeOffset - INTERP;
  let a = snaps[0], b = snaps[0];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].tm <= rt) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
  }
  if (rt < snaps[0].tm) { a = b = snaps[0]; }
  const t = b.tm > a.tm ? clamp((rt - a.tm) / (b.tm - a.tm), 0, 1) : 0;
  const units = [];
  for (const [id, ub] of b.units) {
    const ua = a.units.get(id);
    if (!ua) { units.push({ row: ub, x: ub[3], y: ub[4], aim: ub[5], mv: false }); continue; }
    units.push({ row: ub, x: lerp(ua[3], ub[3], t), y: lerp(ua[4], ub[4], t), aim: lerpAng(ua[5], ub[5], t), mv: Math.abs(ub[3] - ua[3]) + Math.abs(ub[4] - ua[4]) > 1 });
  }
  const projs = [];
  for (const [id, pb] of b.projs) {
    const pa = a.projs.get(id);
    if (!pa) continue; // appear from the next frame to avoid popping at the muzzle
    projs.push({ row: pb, x: lerp(pa[2], pb[2], t), y: lerp(pa[3], pb[3], t), a: pb[4] });
  }
  return { units, projs };
}

// =================================================================== pixel drawing helpers
// The world is drawn into a low-res buffer `g` in art-pixel coordinates (1 art px = 3 world
// units) and then blown up with nearest-neighbour scaling. Text is drawn afterwards in screen space.
const ART = PIX.ART;
const A = (v) => Math.round(v / ART);
const REL_COLORS = ['#3d9df3', '#45c46a', '#e8514a', '#a0a0a0'];
const VIEW = { ox: 0, oy: 0 };
const scrX = (wx) => (wx / ART - VIEW.ox) * PXS / DPR;
const scrY = (wy) => (wy / ART - VIEW.oy) * PXS / DPR;
function spr(s, x, y, alpha) {
  if (alpha !== undefined) g.globalAlpha = alpha;
  g.drawImage(s.c, x - s.ax, y - s.ay);
  if (alpha !== undefined) g.globalAlpha = 1;
}
function sprRot(s, x, y, a) {
  g.save(); g.translate(x, y); g.rotate(a); g.drawImage(s.c, -s.ax, -s.ay); g.restore();
}
function pdisc(x, y, r, col) {
  g.fillStyle = col;
  if (r < 0.8) { g.fillRect(x, y, 1, 1); return; }
  const R = Math.floor(r);
  for (let dy = -R; dy <= R; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5);
    g.fillRect(x - w, y + dy, w * 2 + 1, 1);
  }
}
function pell(x, y, rx, ry, col) {
  g.fillStyle = col;
  for (let dy = -ry; dy <= ry; dy++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy * dy) / ((ry + 0.5) * (ry + 0.5)))));
    g.fillRect(x - w, y + dy, w * 2 + 1, 1);
  }
}
function pring(x, y, r, col, dash) {
  g.fillStyle = col;
  const n = Math.max(8, Math.ceil(r * TAU));
  for (let i = 0; i < n; i++) {
    if (dash && i % (dash * 2) >= dash) continue;
    const a = (i / n) * TAU;
    g.fillRect(Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r), 1, 1);
  }
}
function shadow(x, y, rx) {
  g.globalAlpha = 0.28;
  pell(x, y, rx, Math.max(1, Math.round(rx * 0.35)), '#000');
  g.globalAlpha = 1;
}
function bar(x, y, w, pct, col) {
  const x0 = x - (w >> 1);
  g.fillStyle = '#1b1420'; g.fillRect(x0 - 1, y - 1, w + 2, 4);
  g.fillStyle = '#4a2a2a'; g.fillRect(x0, y, w, 2);
  g.fillStyle = col; g.fillRect(x0, y, Math.max(0, Math.round((w * pct) / 100)), 2);
}
function label(s, x, y, size, color) {
  ctx.font = `${size}px Tiny5, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 4; ctx.strokeStyle = '#1b1420'; ctx.lineJoin = 'round';
  ctx.strokeText(s, Math.round(x), Math.round(y));
  ctx.fillStyle = color; ctx.fillText(s, Math.round(x), Math.round(y));
}

// =================================================================== world drawing
function drawNode(s) {
  const sp = PIX.node(s);
  const x = A(s.x), y = A(s.y + s.r * (s.type === 'tree' ? 0.45 : 0.55));
  shadow(x, y, Math.round((s.r / ART) * (s.type === 'tree' ? 0.8 : 1)));
  spr(sp, x, y);
  if (s.hp < 100) bar(x, y + 3, 12, s.hp, '#e8c95a');
}

function buildingTop(s) { return s.y + s.hs - PIX.building(s.type, s.rel).ay * ART; }
function drawBuilding(s, t, alpha) {
  const sp = PIX.building(s.type, s.rel);
  const x = A(s.x), y = A(s.y + s.hs);
  const hsA = Math.round(s.hs / ART);
  g.globalAlpha = 0.25 * (alpha === undefined ? 1 : alpha);
  g.fillStyle = '#000'; g.fillRect(x - hsA + 2, y - 1, hsA * 2 + 1, 3);
  g.globalAlpha = 1;
  spr(sp, x, y, alpha);
  const top = y - sp.ay;
  if (s.type === 'magetower') {
    const oy = top - 3 + Math.round(Math.sin(t * 3 + s.x) * 1.5);
    g.globalAlpha = 0.3; pdisc(x, oy, 5, '#9b5cff'); g.globalAlpha = 1;
    pdisc(x, oy, 2.5, '#c8a0ff'); pdisc(x, oy, 1, '#ffffff');
  } else if (s.type === 'shrine') {
    const pulse = (Math.sin(t * 2.5) + 1) / 2;
    if (alpha === undefined) pring(x, A(s.y), Math.round(S.BUILDINGS.shrine.range / ART), s.rel <= 1 ? 'rgba(125,255,176,0.35)' : 'rgba(255,140,140,0.35)', 3);
    g.fillStyle = `rgba(190,255,215,${0.5 + pulse * 0.5})`;
    for (let i = 0; i < 4; i++) {
      const a = t * 1.5 + (i / 4) * TAU;
      g.fillRect(x + Math.round(Math.cos(a) * 6), top + 8 + Math.round(Math.sin(a) * 3), 1, 1);
    }
  } else if (s.type === 'sawmill' && Math.floor(t * 6) % 2) {
    g.fillStyle = '#e8ecf2'; g.fillRect(x - Math.round(sp.w / 2) + 11, top + 10, 1, 1);
  }
  if (s.type !== 'wall' && alpha === undefined) {
    const st = PIX.star();
    for (let i = 0; i < s.lvl; i++) spr(st, x - (s.lvl - 1) * 2 + i * 4, y + 2);
  }
  if (s.hp < 100) bar(x, top - 3, clamp(hsA * 2, 10, 30), s.hp, s.rel === 2 ? '#e8514a' : s.rel === 1 ? '#45c46a' : '#3d9df3');
}

function drawWeapon(cls, x, y, aim, anim, left) {
  const dir = left ? -1 : 1;
  if (cls === 'warrior') {
    let a = aim + 0.7 * dir;
    if (anim < 1) {
      const e = 1 - Math.pow(1 - anim, 3);
      a = aim - 1.5 * dir + 3 * dir * e;
      if (anim < 0.5) {
        g.fillStyle = `rgba(255,255,255,${0.8 * (1 - anim * 2)})`;
        for (let k = 0; k <= 12; k++) {
          const ang = lerp(aim - 1.5 * dir, a, k / 12);
          g.fillRect(Math.round(x + Math.cos(ang) * 13), Math.round(y + Math.sin(ang) * 13), 1, 1);
          g.fillRect(Math.round(x + Math.cos(ang) * 12), Math.round(y + Math.sin(ang) * 12), 1, 1);
        }
      }
    }
    sprRot(PIX.weapon('warrior'), x, y, a);
  } else if (cls === 'ranger') {
    sprRot(PIX.weapon('ranger'), x + Math.round(Math.cos(aim) * 2), y + Math.round(Math.sin(aim) * 2), aim);
    if (anim > 0.6) {
      g.fillStyle = '#d8c090';
      for (let k = 0; k < 7; k++) g.fillRect(Math.round(x + Math.cos(aim) * (k - 2)), Math.round(y + Math.sin(aim) * (k - 2)), 1, 1);
    }
  } else {
    sprRot(PIX.weapon('mage'), x, y + 1, aim);
    if (anim < 1) {
      const tx = Math.round(x + Math.cos(aim) * 12), ty = Math.round(y + 1 + Math.sin(aim) * 12);
      g.globalAlpha = (1 - anim) * 0.6; pdisc(tx, ty, 3 + (1 - anim) * 2, '#ffb040'); g.globalAlpha = 1;
    }
  }
}

function drawHero(wx, wy, cls, aim, rel, anim, flags, t, flash, moving) {
  const x = A(wx), y = A(wy) + 6;
  const left = Math.cos(aim) < 0;
  const frame = moving ? Math.floor(t * 9) % 2 : 0;
  const bob = moving && frame ? 1 : 0;
  shadow(x, y, 5);
  if (flags.recall) pring(x, y - 7, 11 + Math.round(Math.sin(t * 6) * 2), '#9fd4ff', 2);
  let body = PIX.hero(cls, rel, frame);
  if (left) body = PIX.flip(body);
  const hx = x + (left ? -3 : 3), hy = y - 7 - bob;
  const behind = Math.sin(aim) < -0.35;
  if (behind) drawWeapon(cls, hx, hy, aim, anim, left);
  spr(body, x, y - bob, flags.invuln && Math.floor(t * 10) % 2 ? 0.5 : undefined);
  if (flash > 0) spr(PIX.tint(body, '#ffffff'), x, y - bob, flash);
  if (!behind) drawWeapon(cls, hx, hy, aim, anim, left);
  if (flags.slow) {
    g.fillStyle = '#8fdcff';
    for (let i = 0; i < 4; i++) g.fillRect(x - 6 + i * 4, y - 1 - (Math.floor(t * 10 + i) % 3), 1, 1);
  }
}

function drawMob(wx, wy, type, aim, anim, t, flash, id, moving) {
  const d = S.MOBS[type];
  const x = A(wx), y = A(wy) + Math.round((d.r / ART) * 0.8);
  const left = Math.cos(aim) < 0;
  const frame = type === 'slime' ? Math.floor(t * 3 + id) % 2 : moving ? Math.floor(t * 8 + id) % 2 : 0;
  let s = PIX.mob(type, frame);
  if (left) s = PIX.flip(s);
  const lunge = anim < 0.3 ? Math.round(Math.sin((anim / 0.3) * Math.PI) * 3) : 0;
  const lx = x + Math.round(Math.cos(aim) * lunge), ly = y + Math.round(Math.sin(aim) * lunge);
  shadow(x, y, Math.round(d.r / ART));
  if (type === 'imp') { g.globalAlpha = 0.15; pdisc(lx, ly - 5, 8, '#ff6a1a'); g.globalAlpha = 1; }
  spr(s, lx, ly);
  if (flash > 0) spr(PIX.tint(s, '#ffffff'), lx, ly, flash * 0.8);
}

function drawKnight(wx, wy, aim, rel, anim, flash, t, moving) {
  const x = A(wx), y = A(wy) + 5;
  const left = Math.cos(aim) < 0;
  const frame = moving ? Math.floor(t * 9) % 2 : 0;
  let s = PIX.knight(rel, frame);
  if (left) s = PIX.flip(s);
  shadow(x, y, 5);
  spr(s, x, y);
  if (flash > 0) spr(PIX.tint(s, '#ffffff'), x, y, flash * 0.8);
  const dir = left ? -1 : 1;
  const a = anim < 0.4 ? aim - dir + 2 * dir * (anim / 0.4) : aim + 0.8 * dir;
  sprRot(PIX.weapon('knight'), x + 3 * dir, y - 6, a);
}

function drawBoss(wx, wy, key, aim, enraged, t, flash) {
  const def = S.BOSSES.find((b) => b.key === key);
  const x = A(wx);
  let y = A(wy) + Math.round((def.r / ART) * 0.7);
  const left = Math.cos(aim) < 0;
  let s = PIX.boss(key, Math.floor(t * 5) % 4);
  if (left) s = PIX.flip(s);
  shadow(x, y, Math.round(def.r / ART));
  if (key === 'lich') y -= 4 + Math.round(Math.sin(t * 2) * 2);
  if (enraged) { g.globalAlpha = 0.18 + 0.08 * Math.sin(t * 8); pdisc(x, y - (s.ay >> 1), (def.r / ART) * 1.3, '#ff3a1a'); g.globalAlpha = 1; }
  spr(s, x, y);
  if (enraged) spr(PIX.tint(s, '#ff3a1a'), x, y, 0.15 + 0.1 * Math.sin(t * 8));
  if (flash > 0) spr(PIX.tint(s, '#ffffff'), x, y, flash * 0.6);
  if (key === 'lich') {
    for (let i = 0; i < 4; i++) {
      const a = t * 1.5 + (i / 4) * TAU;
      const ox = x + Math.round(Math.cos(a) * 24), oy = y - 24 + Math.round(Math.sin(a) * 9);
      g.globalAlpha = 0.35; pdisc(ox, oy, 3.5, '#3aa8ff'); g.globalAlpha = 1;
      pdisc(ox, oy, 1.5, '#c8f4ff');
    }
  }
}

const ORB = {
  fire: ['#c03a10', '#ff7a2d', '#ffd070', '#fff6d0'],
  magic: ['#4a2a90', '#9b5cff', '#d8b8ff', '#ffffff'],
  bolt: ['#1a4a8a', '#3aa8ff', '#c8f4ff', '#ffffff'],
  poison: ['#2a5a10', '#6ab82a', '#c8f07a', '#ffffff'],
};
function orb(x, y, r, pal) {
  g.globalAlpha = 0.35; pdisc(x, y, r + 1.5, pal[0]); g.globalAlpha = 1;
  pdisc(x, y, r, pal[1]);
  if (r > 1.5) pdisc(x - 1, y - 1, r - 1.5, pal[2]);
  g.fillStyle = pal[3]; g.fillRect(x - 1, y - 1, 1, 1);
}
function drawProj(p, t) {
  const type = p.row[1], mine = p.row[5];
  const x = A(p.x), y = A(p.y);
  switch (type) {
    case 'arrow': case 'tarrow': case 'gob': sprRot(PIX.arrow(mine ? 1 : 0), x, y, p.a); break;
    case 'fire': case 'imp': case 'fireball': case 'flame': {
      const r = type === 'fireball' ? 5 : type === 'imp' ? 2 : type === 'flame' ? 3 + (Math.floor(t * 20 + x) % 2) : 3;
      orb(x, y, r, ORB.fire);
      if (Math.random() < 0.4) particles.push({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 30, t: 0, life: 0.35, c: Math.random() < 0.5 ? '#ff9a3d' : '#ffd070', s: 3 });
      break;
    }
    case 'magic': orb(x, y, 4, ORB.magic); break;
    case 'bolt': orb(x, y, 4, ORB.bolt); break;
    case 'poison': orb(x, y, 3, ORB.poison); break;
    case 'seed': spr(PIX.seed(), x, y); break;
    case 'shock': sprRot(PIX.rockProj(false), x, y, t * 8); break;
    case 'rock': sprRot(PIX.rockProj(true), x, y, t * 5); break;
    default: g.fillStyle = '#fff'; g.fillRect(x, y, 2, 2);
  }
}

let plaza = null;
function makePlaza() {
  // round cobblestone plaza: voronoi cells on a jittered grid
  const r = 80, cell = 6;
  const c = document.createElement('canvas');
  c.width = c.height = r * 2 + 3;
  const pg = c.getContext('2d');
  const cols = ['#b8a88a', '#a8987a', '#c4b494', '#9c8c70', '#b0a080'];
  const site = (i, j) => [i * cell + S.hash2(i, j, 11) * cell, j * cell + S.hash2(i, j, 12) * cell];
  for (let y = -r - 1; y <= r + 1; y++) for (let x = -r - 1; x <= r + 1; x++) {
    const d = Math.hypot(x, y);
    if (d > r + 1) continue;
    const px = x + 200, py = y + 200;
    const ci = Math.floor(px / cell), cj = Math.floor(py / cell);
    let d1 = 1e9, d2 = 1e9, id = 0;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const [sx, sy] = site(i, j);
      const dd = Math.hypot(px - sx, py - sy);
      if (dd < d1) { d2 = d1; d1 = dd; id = i * 7919 + j; } else if (dd < d2) d2 = dd;
    }
    let col = cols[Math.floor(S.hash2(id, 3, 5) * cols.length)];
    if (d2 - d1 < 1.1) col = '#6f604a';
    else if (d2 - d1 < 2 && (x + y) % 2 === 0) col = '#8a7a5e';
    if (d > r - 3) col = d > r ? '#1b1420' : (x + y) % 3 ? '#7a6a52' : '#8a7a62';
    pg.fillStyle = col;
    pg.fillRect(x + r + 1, y + r + 1, 1, 1);
  }
  return c;
}

// =================================================================== main render
let lastFrame = performance.now();
let menuT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  if (joined) {
    myAim = Math.atan2(mouse.y - H / 2, mouse.x - W / 2);
    accum += dt;
    while (accum >= S.DT) { accum -= S.DT; inputStep(); }
    vis.x *= Math.pow(0.001, dt); vis.y *= Math.pow(0.001, dt);
  }
  const world = joined ? sampleWorld(now) : null;
  if (joined && me && !dead) { cam.x = pred.x + vis.x; cam.y = pred.y + vis.y; }
  else if (!joined) { menuT += dt; cam.x = S.SPAWN.x + Math.cos(menuT * 0.05) * 1400; cam.y = S.SPAWN.y + Math.sin(menuT * 0.07) * 1100; }

  const bw = buf.width, bh = buf.height;
  const ox = cam.x / ART - bw / 2, oy = cam.y / ART - bh / 2;
  const ax0 = Math.floor(ox), ay0 = Math.floor(oy);
  VIEW.ox = ox; VIEW.oy = oy;
  g.setTransform(1, 0, 0, 1, -ax0, -ay0);
  g.imageSmoothingEnabled = false;
  g.globalAlpha = 1;
  const vx0 = ox * ART, vy0 = oy * ART, vx1 = (ox + bw) * ART, vy1 = (oy + bh) * ART;
  mouse.wx = ((mouse.x * DPR) / PXS + ox) * ART;
  mouse.wy = ((mouse.y * DPR) / PXS + oy) * ART;

  // ground
  const CH = PIX.CH;
  for (let cx = Math.floor(ax0 / CH); cx <= Math.floor((ax0 + bw) / CH); cx++) {
    for (let cy = Math.floor(ay0 / CH); cy <= Math.floor((ay0 + bh) / CH); cy++) {
      if (cx < 0 || cy < 0 || cx * CH * ART >= S.W || cy * CH * ART >= S.H) continue;
      g.drawImage(getChunk(cx, cy), cx * CH, cy * CH);
    }
  }
  const WA = Math.round(S.W / ART), HA = Math.round(S.H / ART);
  g.fillStyle = '#120e14';
  if (ax0 < 0) g.fillRect(ax0, ay0, -ax0, bh);
  if (ax0 + bw > WA) g.fillRect(WA, ay0, ax0 + bw - WA, bh);
  if (ay0 < 0) g.fillRect(ax0, ay0, bw, -ay0);
  if (ay0 + bh > HA) g.fillRect(ax0, HA, bw, ay0 + bh - HA);

  // boss lairs
  for (const b of S.BOSSES) {
    if (b.x < vx0 - 700 || b.x > vx1 + 700 || b.y < vy0 - 700 || b.y > vy1 + 700) continue;
    const x = A(b.x), y = A(b.y);
    pring(x, y, 207, '#8a1a10', 4);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + 0.3;
      const bx = x + Math.round(Math.cos(a) * 92), by = y + Math.round(Math.sin(a) * 92);
      g.fillStyle = '#e9e4d6';
      if (i % 3 === 0) { pdisc(bx, by, 1.6, '#e9e4d6'); g.fillStyle = '#1b1420'; g.fillRect(bx - 1, by, 1, 1); g.fillRect(bx + 1, by, 1, 1); }
      else { g.fillRect(bx - 2, by, 5, 1); g.fillRect(bx - 2, by - 1, 1, 1); g.fillRect(bx + 2, by + 1, 1, 1); }
    }
  }
  // spawn plaza
  if (Math.abs(S.SPAWN.x - cam.x) < vx1 - vx0 && Math.abs(S.SPAWN.y - cam.y) < vy1 - vy0) {
    if (!plaza) plaza = makePlaza();
    const x = A(S.SPAWN.x), y = A(S.SPAWN.y);
    g.drawImage(plaza, x - (plaza.width >> 1), y - (plaza.height >> 1));
    g.fillStyle = '#5e564b'; g.fillRect(x - 4, y - 1, 9, 4); g.fillStyle = '#8a8070'; g.fillRect(x - 4, y - 1, 9, 1);
    orb(x, y - 3 - (Math.floor(t * 8) % 2), 3, ORB.fire);
    if (Math.random() < 0.3) particles.push({ x: S.SPAWN.x + (Math.random() - 0.5) * 9, y: S.SPAWN.y - 12, vx: 0, vy: -40, t: 0, life: 0.5, c: '#ffb040', s: 3 });
  }

  // my base radius
  if (pf && pf.th && (buildMode || (hovered && hovered.k === 'b' && hovered.rel === 0))) {
    pring(A(pf.th[0]), A(pf.th[1]), Math.round(S.thRadius(pf.th[2]) / ART), '#6cc0ff', 3);
  }

  // hovered building (uses the full sprite height, not just the footprint)
  hovered = null;
  if (joined) {
    for (const s of statics) {
      if (s.k !== 'b') continue;
      if (Math.abs(mouse.wx - s.x) < s.hs && mouse.wy < s.y + s.hs && mouse.wy > buildingTop(s)) { hovered = s; break; }
    }
  }

  // collect & depth-sort drawables
  const draw = [];
  for (const s of statics) {
    const e = s.k === 'b' ? s.hs + 200 : s.r * 3;
    if (s.x + e < vx0 || s.x - e > vx1 || s.y - e > vy1 || s.y + e < vy0) continue;
    draw.push({ y: s.y + (s.k === 'b' ? 0 : s.r * 0.3), s });
  }
  let nearBoss = null;
  if (world) {
    for (const u of world.units) {
      if (u.row[0] === myId && u.row[1] === 'h') continue;
      draw.push({ y: u.y, u });
      if (u.row[1] === 'B') {
        const d = Math.hypot(u.x - cam.x, u.y - cam.y);
        if (!nearBoss || d < nearBoss.d) nearBoss = { d, u };
      }
    }
  }
  if (joined && me && !dead) draw.push({ y: cam.y, self: true });
  draw.sort((a, b) => a.y - b.y);

  const names = [];
  for (const d of draw) {
    if (d.s) { if (d.s.k === 'n') drawNode(d.s); else drawBuilding(d.s, t); continue; }
    if (d.self) {
      const anim = atkAnim.has(myId) ? (now - atkAnim.get(myId)) / (pf.cls === 'warrior' ? 280 : 350) : 9;
      const myRow = world && findMyRow(world);
      const flags = { invuln: myRow && myRow[9], slow: myRow && myRow[10], recall: me.rc > 0 };
      const fl = hurtFlash.has(myId) ? Math.max(0, 1 - (now - hurtFlash.get(myId)) / 150) : 0;
      const moving = !!(lastInput && (lastInput.mx || lastInput.my));
      drawHero(cam.x, cam.y, pf.cls, myAim, 0, anim, flags, t, fl, moving);
      bar(A(cam.x), A(cam.y) + 9, 14, Math.round((me.hp / me.mhp) * 100), '#5fd16f');
      names.push({ x: cam.x, y: cam.y - 52, rel: 0, id: myId });
      continue;
    }
    const u = d.u, row = u.row;
    const id = row[0];
    const anim = atkAnim.has(id) ? (now - atkAnim.get(id)) / 300 : 9;
    const fl = hurtFlash.has(id) ? Math.max(0, 1 - (now - hurtFlash.get(id)) / 150) : 0;
    if (row[1] === 'h') {
      drawHero(u.x, u.y, row[2], u.aim, row[7], anim, { invuln: row[9], slow: row[10], recall: row[11] }, t, fl, u.mv);
      bar(A(u.x), A(u.y) + 9, 14, row[6], row[7] === 2 ? '#e8514a' : '#5fd16f');
      names.push({ x: u.x, y: u.y - 52, rel: row[7], id });
    } else if (row[1] === 'm') {
      drawMob(u.x, u.y, row[2], u.aim, anim, t, fl, id, u.mv);
      if (row[6] < 100) bar(A(u.x), A(u.y) + Math.round(S.MOBS[row[2]].r / ART) + 3, 10, row[6], '#e0a040');
    } else if (row[1] === 'k') {
      drawKnight(u.x, u.y, u.aim, row[7], anim, fl, t, u.mv);
      if (row[6] < 100) bar(A(u.x), A(u.y) + 8, 10, row[6], row[7] === 2 ? '#e8514a' : '#5fd16f');
    } else if (row[1] === 'B') {
      drawBoss(u.x, u.y, row[2], u.aim, row[8], t, fl);
    }
  }
  if (world) for (const p of world.projs) drawProj(p, t);

  // build ghost
  let ghostErr = null;
  if (joined && buildMode && pf) ghostErr = drawGhost(t);

  // fx
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    if (r.t > r.life) { rings.splice(i, 1); continue; }
    if (r.t < 0) continue;
    const k = r.t / r.life;
    const rad = lerp(r.r0, r.r1, 1 - Math.pow(1 - k, 2)) / ART;
    g.globalAlpha = 1 - k;
    pring(A(r.x), A(r.y), rad, r.c);
    if (r.fill) pring(A(r.x), A(r.y), rad - 1, r.c);
    if (r.fill && k < 0.5) { g.globalAlpha = (0.5 - k) * 0.4; pdisc(A(r.x), A(r.y), rad, r.c); }
    g.globalAlpha = 1;
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t > p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
    g.globalAlpha = Math.min(1, 2 * (1 - p.t / p.life));
    g.fillStyle = p.c;
    const s = p.s > 5 ? 2 : 1;
    g.fillRect(A(p.x), A(p.y), s, s);
  }
  g.globalAlpha = 1;

  // blit the low-res buffer to the screen with hard pixels
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf, Math.round((ax0 - ox) * PXS), Math.round((ay0 - oy) * PXS), bw * PXS, bh * PXS);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // screen-space text
  for (const n of names) {
    const nm = info.names[n.id];
    if (!nm) continue;
    const col = n.rel === 0 ? '#8fd0ff' : n.rel === 1 ? '#8ff0a8' : '#ff9a90';
    const sx = scrX(n.x), sy = scrY(n.y);
    const txt = `${nm[1] ? `[${nm[1]}] ` : ''}${nm[0]}`;
    label(txt, sx, sy, 16, col);
    ctx.font = '16px Tiny5, monospace';
    const w = ctx.measureText(txt).width;
    label(String(nm[2]), sx - w / 2 - 10, sy, 16, '#ffd76a');
    if (bubbles.has(n.id)) {
      const b = bubbles.get(n.id);
      if (now - b.t > 5000) bubbles.delete(n.id);
      else drawBubble(sx, sy - 20, b.m);
    }
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const f = texts[i];
    f.t += dt;
    if (f.t > f.life) { texts.splice(i, 1); continue; }
    const k = f.t / f.life;
    ctx.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1;
    label(f.s, scrX(f.x), scrY(f.y) - Math.round(k * 12) * 3, f.size, f.color);
  }
  ctx.globalAlpha = 1;
  if (ghostErr) label(ghostErr.m, scrX(ghostErr.x), scrY(ghostErr.y), 16, '#ffb0a0');

  if (joined && me && !dead && me.hp / me.mhp < 0.3) {
    const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    gr.addColorStop(0, 'rgba(160,0,0,0)'); gr.addColorStop(1, `rgba(160,0,0,${0.35 + Math.sin(t * 6) * 0.1})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
  if (joined) {
    updateBossBar(nearBoss);
    drawMinimap();
    updateTooltip();
    if (now - lastHud > 100) { lastHud = now; updateHud(); }
  }
}
let lastHud = 0;
function findMyRow(world) {
  for (const u of world.units) if (u.row[0] === myId && u.row[1] === 'h') return u.row;
  return null;
}

const bubbles = new Map();
function drawBubble(x, y, m) {
  ctx.font = '16px Tiny5, monospace';
  const s = m.length > 40 ? m.slice(0, 40) + '…' : m;
  const w = Math.round(ctx.measureText(s).width + 14);
  const bx = Math.round(x - w / 2), by = Math.round(y - 22);
  ctx.fillStyle = '#1b1420'; ctx.fillRect(bx - 2, by - 2, w + 4, 26);
  ctx.fillStyle = '#f4f1e8'; ctx.fillRect(bx, by, w, 22);
  ctx.fillStyle = '#1b1420'; ctx.fillRect(Math.round(x) - 3, by + 24, 6, 2); ctx.fillRect(Math.round(x) - 1, by + 26, 2, 2);
  ctx.fillStyle = '#2a2018'; ctx.textAlign = 'center'; ctx.fillText(s, Math.round(x), by + 16);
}

function ghostError(type, x, y) {
  if (!pf) return 'Нет данных';
  const def = S.BUILDINGS[type];
  const hs = def.size / 2;
  if (type === 'townhall') {
    if (pf.th) return 'Ратуша уже есть';
    for (const t of info.ths || []) if (Math.hypot(t[1] - x, t[2] - y) < 1100) return 'Слишком близко к чужой ратуше';
    for (const b of S.BOSSES) if (Math.hypot(b.x - x, b.y - y) < 1000) return 'Слишком близко к логову босса';
    if (Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y) < 450) return 'Площадь возрождения';
    const cost = pf.thLvl > 0 ? S.thRebuildCost(pf.thLvl) : {};
    if (!S.canAfford(resObj(), cost)) return 'Не хватает ресурсов';
  } else {
    if (!pf.th) return 'Сначала ратуша (1)';
    if (Math.hypot(pf.th[0] - x, pf.th[1] - y) > S.thRadius(pf.th[2]) - hs * 0.5) return 'Вне радиуса базы';
    const cap = S.CAPS[type][pf.th[2] - 1];
    if (((pf.counts || {})[type] || 0) >= cap) return cap ? 'Лимит — улучшите ратушу' : 'Нужна ратуша выше уровнем';
    if (!S.canAfford(resObj(), def.cost)) return 'Не хватает ресурсов';
  }
  for (const s of nearStatics(x, y, hs + 50)) {
    if (s.k === 'n' && Math.abs(s.x - x) < hs + s.r - 4 && Math.abs(s.y - y) < hs + s.r - 4) return 'Мешает ресурс';
    if (s.k === 'b' && Math.abs(s.x - x) < hs + s.hs - 1 && Math.abs(s.y - y) < hs + s.hs - 1) return 'Место занято';
  }
  return null;
}
function resObj() { return { wood: pf.res[0], stone: pf.res[1], gold: pf.res[2] }; }
function drawGhost(t) {
  const type = buildMode;
  const def = S.BUILDINGS[type];
  const x = S.snap(type, mouse.wx), y = S.snap(type, mouse.wy);
  const err = ghostError(type, x, y);
  const hs = def.size / 2;
  if (type === 'tower' || type === 'magetower' || type === 'shrine') pring(A(x), A(y), Math.round(def.range / ART), 'rgba(255,255,255,0.5)', 3);
  if (type === 'townhall') pring(A(x), A(y), Math.round(S.thRadius(Math.max(1, pf.thLvl)) / ART), 'rgba(255,255,255,0.5)', 3);
  drawBuilding({ type, x, y, hs, lvl: 1, hp: 100, rel: 0, aim: 0 }, t, 0.6);
  const x0 = A(x - hs), y0 = A(y - hs), s = A(hs * 2);
  g.globalAlpha = 0.25; g.fillStyle = err ? '#ff3a28' : '#50ff78'; g.fillRect(x0, y0, s, s); g.globalAlpha = 1;
  g.fillStyle = err ? '#ff5a4a' : '#5aff8a';
  g.fillRect(x0, y0, s, 1); g.fillRect(x0, y0 + s - 1, s, 1); g.fillRect(x0, y0, 1, s); g.fillRect(x0 + s - 1, y0, 1, s);
  // continuous wall painting
  if (type === 'wall' && mouse.down && !err && lastWallCell !== x + ',' + y) {
    lastWallCell = x + ',' + y;
    send({ t: 'build', type, x, y });
  }
  return err ? { m: err, x, y: y - hs - 90 } : null;
}

// =================================================================== minimap
const mm = $('minimap').getContext('2d');
function drawMinimap() {
  const k = 200 / S.W;
  mm.drawImage(mmBg, 0, 0);
  // lairs
  for (const b of info.bosses || []) {
    const def = S.BOSSES.find((d) => d.key === b[0]);
    mm.font = '13px serif'; mm.textAlign = 'center'; mm.textBaseline = 'middle';
    mm.globalAlpha = b[1] ? 1 : 0.35;
    mm.fillText(b[0] === 'dragon' ? '🐉' : '💀', def.x * k, def.y * k);
    mm.globalAlpha = 1;
  }
  for (const th of info.ths || []) {
    mm.fillStyle = REL_COLORS[th[3]];
    mm.strokeStyle = '#000'; mm.lineWidth = 1;
    mm.fillRect(th[1] * k - 3.5, th[2] * k - 3.5, 7, 7); mm.strokeRect(th[1] * k - 3.5, th[2] * k - 3.5, 7, 7);
  }
  mm.fillStyle = '#7de89a';
  for (const a of info.allies || []) { mm.beginPath(); mm.arc(a[0] * k, a[1] * k, 2.5, 0, TAU); mm.fill(); }
  // spawn
  mm.fillStyle = '#ffe0a0'; mm.beginPath(); mm.arc(S.SPAWN.x * k, S.SPAWN.y * k, 2, 0, TAU); mm.fill();
  // view rect & me
  const vw = W / cam.scale, vh = H / cam.scale;
  mm.strokeStyle = 'rgba(255,255,255,0.5)'; mm.lineWidth = 1;
  mm.strokeRect((cam.x - vw / 2) * k, (cam.y - vh / 2) * k, vw * k, vh * k);
  mm.fillStyle = '#fff'; mm.strokeStyle = '#000';
  mm.beginPath(); mm.arc(cam.x * k, cam.y * k, 3.5, 0, TAU); mm.fill(); mm.stroke();
}

// =================================================================== HUD (DOM)
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function costStr(cost) {
  const parts = [];
  for (const k of S.RES) if (cost[k]) parts.push(`${cost[k]}${S.RES_ICON[k]}`);
  return parts.join(' ') || 'бесплатно';
}

// build bar
function renderBuildBar() {
  const bar = $('buildbar');
  if (!bar.children.length) {
    S.BUILD_ORDER.forEach((type, i) => {
      const d = S.BUILDINGS[type];
      const b = el('div', 'bslot');
      b.dataset.type = type;
      b.innerHTML = `<span class="k">${i + 1}</span><span class="c"></span>${d.icon}<span class="cost"></span>`;
      b.onclick = () => selectBuild(type);
      b.onmouseenter = () => { buildHover = type; };
      b.onmouseleave = () => { buildHover = null; };
      bar.appendChild(b);
    });
  }
  for (const b of bar.children) {
    const type = b.dataset.type;
    b.classList.toggle('sel', buildMode === type);
    if (!pf) continue;
    let cost = S.BUILDINGS[type].cost;
    let cnt = '';
    let ok = true;
    if (type === 'townhall') {
      cost = pf.thLvl > 0 ? S.thRebuildCost(pf.thLvl) : {};
      ok = !pf.th;
      cnt = pf.th ? '✓' : '';
    } else {
      const cap = pf.th ? S.CAPS[type][pf.th[2] - 1] : 0;
      const n = (pf.counts || {})[type] || 0;
      cnt = pf.th ? `${n}/${cap}` : '';
      ok = !!pf.th && n < cap;
    }
    ok = ok && S.canAfford(resObj(), cost);
    b.classList.toggle('no', !ok);
    b.querySelector('.c').textContent = cnt;
    b.querySelector('.cost').textContent = type === 'townhall' && pf.th ? 'построена' : costStr(cost);
  }
}
let buildHover = null;

function renderStats() {
  const box = $('stats');
  if (!pf) return;
  const key = pf.pts + ':' + pf.st.join(',');
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  box.classList.toggle('nopts', pf.pts <= 0);
  box.appendChild(el('div', 'pts', pf.pts > 0 ? `Очки навыков: ${pf.pts}` : `Навыки · ${pf.st.reduce((a, b) => a + b, 0)}`));
  S.STATS.forEach((s, i) => {
    const row = el('div', 'srow');
    row.appendChild(el('span', 'sname', s.name));
    const bar = el('div', 'sbar');
    for (let j = 0; j < S.STAT_MAX; j++) { const c = el('i'); if (j < pf.st[i]) c.style.background = s.color; bar.appendChild(c); }
    row.appendChild(bar);
    const btn = el('button', '', '+');
    btn.disabled = pf.pts <= 0 || pf.st[i] >= S.STAT_MAX;
    btn.onclick = () => send({ t: 'stat', i });
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function updateHud() {
  if (!pf) return;
  const cap = pf.cap;
  $('res').innerHTML = S.RES.map((r, i) => `<div class="r ${pf.res[i] >= cap ? 'full' : ''}">${S.RES_ICON[r]} ${pf.res[i]}</div>`).join('') +
    `<div class="cap">склад ${cap}</div><div class="r glory">✦ ${pf.glory}</div>`;
  const xpPct = pf.lvl >= S.MAX_LVL ? 100 : (pf.xp / pf.xpn) * 100;
  $('xpfill').style.width = xpPct + '%';
  $('xptext').textContent = `Ур. ${pf.lvl} · ${S.CLASSES[pf.cls].name}` + (pf.lvl < S.MAX_LVL ? ` · ${pf.xp}/${pf.xpn}` : ' · МАКС');
  renderStats();
  renderBuildBar();
  if (me) {
    const k = me.cd / me.cdm;
    $('ability').querySelector('.ab-cd').style.background = k > 0 ? `linear-gradient(to top, transparent ${(1 - k) * 100}%, rgba(10,6,14,0.7) 0)` : 'transparent';
    $('ability').style.borderColor = k > 0 ? '#1b1420' : '#ffd34a';
    $('ability').title = `${S.CLASSES[pf.cls].ability.name} (Пробел / ПКМ)`;
  }
  const icon = { warrior: '💨', ranger: '🏹', mage: '❄️' }[pf.cls];
  if ($('ability').dataset.cls !== pf.cls) {
    $('ability').dataset.cls = pf.cls;
    $('ability').innerHTML = `<div class="ab-cd"></div>${icon}<span class="ab-key">␣</span>`;
  }
  $('recall').style.opacity = pf.th ? 1 : 0.35;
  $('biome').textContent = S.BIOME_NAMES[biomeAtPos(cam.x, cam.y)];
}
$('recall').onclick = () => send({ t: 'recall' });

function renderLeaderboard() {
  const list = $('lb-list');
  list.innerHTML = '';
  info.lb.forEach((r, i) => {
    const row = el('div', `lb-row ${r[5] === myId ? 'me' : ''} ${r[4] ? '' : 'off'}`);
    row.innerHTML = `<span>${i + 1}.</span><span class="n">${r[1] ? `[${esc(r[1])}] ` : ''}${esc(r[0])} <small>ур.${r[2]}</small></span><span class="g">${r[3]}</span>`;
    list.appendChild(row);
  });
  $('online').textContent = `Онлайн: ${info.online}`;
}

function updateBossBar(nb) {
  const bar = $('bossbar');
  if (!nb || nb.d > 1300) { bar.classList.add('hidden'); return; }
  const row = nb.u.row;
  const def = S.BOSSES.find((b) => b.key === row[2]);
  bar.classList.remove('hidden');
  bar.querySelector('.boss-name').textContent = def.name + (row[8] ? ' — ЯРОСТЬ' : '');
  bar.querySelector('.boss-fill').style.width = row[6] + '%';
}

function updateTooltip() {
  const tt = $('tooltip');
  let html = null;
  if (buildHover) {
    const d = S.BUILDINGS[buildHover];
    const cost = buildHover === 'townhall' ? (pf && pf.thLvl > 0 ? S.thRebuildCost(pf.thLvl) : {}) : d.cost;
    html = `<div class="tt-t">${d.icon} ${d.name}</div><div>${d.desc}</div><div class="tt-k">${costStr(cost)}</div>`;
    const r = document.querySelector(`.bslot[data-type="${buildHover}"]`).getBoundingClientRect();
    tt.style.left = Math.min(W - 290, r.left) + 'px';
    tt.style.top = (r.top - 90) + 'px';
  } else if (hovered && !buildMode) {
    const s = hovered;
    const d = S.BUILDINGS[s.type];
    const owner = info.names[s.pid];
    html = `<div class="tt-t">${d.icon} ${d.name} · ур. ${s.lvl}</div>`;
    if (s.rel === 0) {
      let up;
      if (s.type === 'townhall') up = s.lvl < S.TH_MAX ? S.thUpgradeCost(s.lvl + 1) : null;
      else up = s.lvl < S.BLD_MAX ? S.bldUpgradeCost(s.type, s.lvl + 1) : null;
      const blocked = s.type !== 'townhall' && pf && pf.th && s.lvl >= pf.th[2];
      html += up ? `<div><span class="tt-k">[E]</span> улучшить: ${costStr(up)}${blocked ? ' <span class="tt-m">(нужна ратуша выше)</span>' : ''}</div>` : '<div class="tt-m">Максимальный уровень</div>';
      if (s.type !== 'townhall') html += '<div><span class="tt-k">[X×2]</span> снести (вернёт 50%)</div>';
      if (s.type === 'townhall') html += `<div class="tt-m">Радиус базы ${S.thRadius(s.lvl)}, склад ${S.resCap(s.lvl)}</div>`;
    } else {
      html += `<div class="tt-m">${s.rel === 1 ? 'Союзник' : 'Враг'}: ${owner ? esc(owner[0]) : '???'}</div>`;
    }
    tt.style.left = Math.min(W - 290, mouse.x + 18) + 'px';
    tt.style.top = (mouse.y + 18) + 'px';
  }
  if (html) { tt.innerHTML = html; tt.classList.remove('hidden'); } else tt.classList.add('hidden');
}

let toastT = 0;
function toast(m) {
  const t = $('toast');
  t.textContent = m;
  t.style.opacity = 1;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.style.opacity = 0; }, 1800);
}
function addFeed(m, big) {
  const wrap = el('div', 'feed-wrap');
  const it = el('div', 'feed-item' + (big ? ' big' : ''));
  it.textContent = m;
  wrap.appendChild(it);
  const feed = $('feed');
  feed.appendChild(wrap);
  while (feed.children.length > 5) feed.removeChild(feed.firstChild);
  setTimeout(() => { it.style.opacity = 0; }, big ? 7000 : 4500);
  setTimeout(() => wrap.remove(), big ? 7700 : 5200);
}
function addChat(m) {
  const log = $('chatlog');
  const it = el('div', 'cmsg');
  it.innerHTML = `<b>${m.c ? `[${esc(m.c)}] ` : ''}${esc(m.n)}:</b> ${esc(m.m)}`;
  log.appendChild(it);
  while (log.children.length > 8) log.removeChild(log.firstChild);
  setTimeout(() => { it.style.opacity = 0.35; }, 15000);
  bubbles.set(m.id, { m: m.m, t: performance.now() });
}

// =================================================================== menus
function classCard(cls, container, onPick) {
  const c = S.CLASSES[cls];
  const card = el('div', 'cls');
  const pc = document.createElement('canvas');
  pc.width = 120; pc.height = 84;
  card.appendChild(pc);
  card.appendChild(el('b', '', c.name));
  card.appendChild(el('span', '', c.desc));
  card.onclick = () => onPick(cls);
  card.dataset.cls = cls;
  container.appendChild(card);
  return pc;
}
const previews = [];
function buildClassPickers() {
  for (const [id, onPick] of [['classes', (c) => { selCls = c; markSel(); }], ['classes2', (c) => { selCls = c; markSel(); }]]) {
    for (const cls of Object.keys(S.CLASSES)) previews.push({ cv: classCard(cls, $(id), onPick), cls });
  }
  markSel();
}
function markSel() {
  document.querySelectorAll('.cls').forEach((e) => e.classList.toggle('sel', e.dataset.cls === selCls));
}
const pvBuf = document.createElement('canvas');
pvBuf.width = 40; pvBuf.height = 28;
function drawPreviews(t) {
  for (const p of previews) {
    if (!p.cv.offsetParent) continue;
    const bg = pvBuf.getContext('2d');
    bg.setTransform(1, 0, 0, 1, 0, 0);
    bg.clearRect(0, 0, pvBuf.width, pvBuf.height);
    const real = g;
    g = bg;
    drawHero(17 * PIX.ART, 14 * PIX.ART, p.cls, Math.sin(t * 1.5) * 0.5, 0, (t * 1000 % 1400) / 350, {}, t, 0, true);
    g = real;
    const pg = p.cv.getContext('2d');
    pg.imageSmoothingEnabled = false;
    pg.clearRect(0, 0, p.cv.width, p.cv.height);
    pg.drawImage(pvBuf, 0, 0, pvBuf.width, pvBuf.height, 0, 0, pvBuf.width * 3, pvBuf.height * 3);
  }
}

function startGame() {
  if (!ws || ws.readyState !== 1) return;
  joined = true;
  join();
}
$('play').onclick = startGame;
$('respawn').onclick = () => {
  if (deathInfo && performance.now() < deathInfo.until) return;
  send({ t: 'respawn', cls: selCls });
  $('death').classList.add('hidden');
  dead = false;
  pending = [];
};
function showDeath() {
  $('death').classList.remove('hidden');
  $('deathby').textContent = `Убийца: ${deathInfo.by}` + (deathInfo.lost ? ` · потеряно ${deathInfo.lost}🪙` : '');
  markSel();
  const btn = $('respawn');
  const tick = () => {
    const left = Math.ceil((deathInfo.until - performance.now()) / 1000);
    if (left > 0) { btn.disabled = true; btn.textContent = `Возродиться (${left})`; setTimeout(tick, 200); }
    else { btn.disabled = false; btn.textContent = 'Возродиться'; }
  };
  tick();
}
function toggleHelp() { $('help').classList.toggle('hidden'); }
function closeHelp() { $('help').classList.add('hidden'); }
$('helpclose').onclick = closeHelp;
$('hint').onclick = toggleHelp;

// =================================================================== boot
try {
  $('name').value = localStorage.getItem('ef_name') || '';
  $('clan').value = localStorage.getItem('ef_clan') || '';
  selCls = localStorage.getItem('ef_cls') || 'warrior';
  if (!S.CLASSES[selCls]) selCls = 'warrior';
} catch (e) { /* ignore */ }
buildClassPickers();
resize();
connect();
requestAnimationFrame(frame);
setInterval(() => { if (!joined || $('menu').offsetParent || !$('death').classList.contains('hidden')) drawPreviews(performance.now() / 1000); }, 50);
