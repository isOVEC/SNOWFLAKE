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

let W = 0, H = 0, DPR = 1;
const cam = { x: S.SPAWN.x, y: S.SPAWN.y, scale: 1 };
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cam.scale = Math.max(W / 1700, H / 1000);
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

// ---- ground chunks, pre-rendered and cached
const CHUNK = 640;
const chunkCache = new Map();
function hashf(x, y, s) { return S.hash2(x | 0, y | 0, s); }
function renderChunk(cx, cy) {
  const c = document.createElement('canvas');
  c.width = CHUNK; c.height = CHUNK;
  const g = c.getContext('2d');
  const x0 = cx * CHUNK, y0 = cy * CHUNK;
  const T = S.TILE;
  const tx0 = Math.floor(x0 / T) - 1, ty0 = Math.floor(y0 / T) - 1;
  const n = CHUNK / T + 2;
  // base squares
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    const b = biomeAtTile(tx, ty);
    g.fillStyle = S.BIOME_COLORS[b][0];
    g.fillRect(tx * T - x0, ty * T - y0, T + 1, T + 1);
  }
  // organic blobs for soft, wavy borders
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    const b = biomeAtTile(tx, ty);
    for (let k = 0; k < 3; k++) {
      const h1 = hashf(tx, ty, 10 + k), h2 = hashf(tx, ty, 20 + k), h3 = hashf(tx, ty, 30 + k);
      g.fillStyle = S.BIOME_COLORS[b][1 + (k % 2)];
      g.beginPath();
      g.arc(tx * T - x0 + h1 * T, ty * T - y0 + h2 * T, T * (0.35 + h3 * 0.4), 0, TAU);
      g.fill();
    }
  }
  // decorations
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    const b = biomeAtTile(tx, ty);
    for (let k = 0; k < 4; k++) {
      const h = hashf(tx, ty, 40 + k);
      const px = tx * T - x0 + hashf(tx, ty, 50 + k) * T, py = ty * T - y0 + hashf(tx, ty, 60 + k) * T;
      drawDecor(g, b, h, px, py, hashf(tx, ty, 70 + k));
    }
  }
  return c;
}
function drawDecor(g, b, h, x, y, h2) {
  if (b === S.B.MEADOW || b === S.B.FOREST) {
    if (h < 0.45) { // grass tuft
      g.strokeStyle = b === S.B.FOREST ? 'rgba(20,60,20,0.35)' : 'rgba(40,90,30,0.35)';
      g.lineWidth = 2; g.beginPath();
      for (let i = -1; i <= 1; i++) { g.moveTo(x + i * 3, y); g.lineTo(x + i * 5, y - 7 - h2 * 5); }
      g.stroke();
    } else if (h < 0.53 && b === S.B.MEADOW) { // flower
      const cols = ['#fff3a8', '#ff9fbf', '#ffffff', '#a8d4ff'];
      g.fillStyle = cols[(h2 * 4) | 0];
      for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(x + Math.cos(i * 1.26) * 3, y + Math.sin(i * 1.26) * 3, 2.2, 0, TAU); g.fill(); }
      g.fillStyle = '#e8a93a'; g.beginPath(); g.arc(x, y, 1.6, 0, TAU); g.fill();
    } else if (h < 0.58 && b === S.B.FOREST) { // mushroom
      g.fillStyle = '#e8dcc0'; g.fillRect(x - 1.5, y - 2, 3, 5);
      g.fillStyle = '#c9423a'; g.beginPath(); g.arc(x, y - 2, 4.5, Math.PI, 0); g.fill();
    }
  } else if (b === S.B.MOUNTAIN) {
    if (h < 0.4) { g.fillStyle = 'rgba(80,74,66,0.45)'; g.beginPath(); g.arc(x, y, 2 + h2 * 4, 0, TAU); g.fill(); }
    else if (h < 0.5) { g.strokeStyle = 'rgba(70,64,58,0.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 10, y + 5 * h2); g.lineTo(x + 16, y - 3); g.stroke(); }
  } else if (b === S.B.SNOW) {
    if (h < 0.35) { g.fillStyle = 'rgba(170,195,215,0.45)'; g.beginPath(); g.ellipse(x, y, 8 + h2 * 8, 3 + h2 * 2, 0, 0, TAU); g.fill(); }
    else if (h < 0.45) { g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(x, y, 1.5, 0, TAU); g.fill(); }
  } else if (b === S.B.SWAMP) {
    if (h < 0.18) { g.fillStyle = 'rgba(40,70,60,0.55)'; g.beginPath(); g.ellipse(x, y, 14 + h2 * 16, 8 + h2 * 8, h2 * 3, 0, TAU); g.fill(); }
    else if (h < 0.3) { g.fillStyle = '#6f9a4a'; g.beginPath(); g.arc(x, y, 5, 0.3, TAU - 0.3); g.lineTo(x, y); g.fill(); }
    else if (h < 0.5) { g.strokeStyle = 'rgba(30,50,25,0.45)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 2, y - 10); g.moveTo(x + 3, y); g.lineTo(x + 4, y - 12); g.stroke(); }
  } else if (b === S.B.VOLCANO) {
    if (h < 0.14) {
      g.strokeStyle = 'rgba(255,110,40,0.7)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y);
      g.lineTo(x + 8, y + 6 * h2); g.lineTo(x + 14, y - 2); g.lineTo(x + 22, y + 4); g.stroke();
    } else if (h < 0.35) { g.fillStyle = 'rgba(25,15,15,0.5)'; g.beginPath(); g.arc(x, y, 2 + h2 * 4, 0, TAU); g.fill(); }
  }
}
function getChunk(cx, cy) {
  const k = cx * 1000 + cy;
  let c = chunkCache.get(k);
  if (c) { chunkCache.delete(k); chunkCache.set(k, c); return c; }
  c = renderChunk(cx, cy);
  chunkCache.set(k, c);
  if (chunkCache.size > 30) chunkCache.delete(chunkCache.keys().next().value);
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
    if (!ua) { units.push({ row: ub, x: ub[3], y: ub[4], aim: ub[5] }); continue; }
    units.push({ row: ub, x: lerp(ua[3], ub[3], t), y: lerp(ua[4], ub[4], t), aim: lerpAng(ua[5], ub[5], t) });
  }
  const projs = [];
  for (const [id, pb] of b.projs) {
    const pa = a.projs.get(id);
    if (!pa) continue; // appear from the next frame to avoid popping at the muzzle
    projs.push({ row: pb, x: lerp(pa[2], pb[2], t), y: lerp(pa[3], pb[3], t), a: pb[4] });
  }
  return { units, projs };
}

// =================================================================== drawing helpers
function circle(x, y, r, fill, stroke, lw) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 3; ctx.stroke(); }
}
function shadow(x, y, r, a) {
  ctx.fillStyle = `rgba(0,0,0,${a || 0.22})`;
  ctx.beginPath(); ctx.ellipse(x + r * 0.12, y + r * 0.35, r * 1.05, r * 0.6, 0, 0, TAU); ctx.fill();
}
function darker(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) * f, g = ((n >> 8) & 255) * f, b = (n & 255) * f;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}
const REL_COLORS = ['#3d9df3', '#45c46a', '#e8514a', '#a0a0a0'];
function polyRand(x, y, r, seed, n, jitter) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + S.hash2(seed, i, 3) * 0.4;
    const rr = r * (1 - jitter + S.hash2(seed, i, 7) * jitter);
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
}
function hpBar(x, y, w, pct, color) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(x - w / 2 - 1.5, y - 1.5, w + 3, 8, 4); ctx.fill();
  ctx.fillStyle = color;
  roundRect(x - w / 2, y, Math.max(0, w * pct / 100), 5, 2.5); ctx.fill();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function label(s, x, y, size, color, bold) {
  ctx.font = `${bold ? '700 ' : ''}${size}px Trebuchet MS, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.lineJoin = 'round';
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color; ctx.fillText(s, x, y);
}

// =================================================================== static drawing
function drawNode(s, t) {
  const { x, y, r } = s;
  if (s.type === 'tree') {
    shadow(x, y + r * 0.2, r * 1.1, 0.25);
    const b = s.biome;
    const sway = Math.sin(t * 1.3 + s.v) * 1.5;
    if (b === S.B.SNOW) {
      for (let i = 0; i < 3; i++) {
        const rr = r * (1.25 - i * 0.32);
        ctx.fillStyle = ['#2f5d45', '#3a6d52', '#467e5f'][i];
        polyRand(x + sway * i * 0.3, y - i * 6, rr, s.v + i, 8, 0.25); ctx.fill();
        ctx.strokeStyle = '#1f3d2d'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      polyRand(x - r * 0.15 + sway, y - r * 0.2 - 12, r * 0.45, s.v + 9, 7, 0.3); ctx.fill();
    } else if (b === S.B.VOLCANO) {
      ctx.strokeStyle = '#2a1a14'; ctx.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + s.v;
        ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 1.1, y + Math.sin(a) * r * 1.1 - 6); ctx.stroke();
        ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7 - 4);
        ctx.lineTo(x + Math.cos(a + 0.5) * r * 1.2, y + Math.sin(a + 0.5) * r * 1.2 - 6); ctx.stroke();
      }
      circle(x, y, r * 0.35, '#3a261c', '#1a100c', 3);
      ctx.lineCap = 'butt';
    } else {
      const swamp = b === S.B.SWAMP;
      const cols = swamp ? ['#3f5a32', '#4a6a3a', '#57794a'] : b === S.B.FOREST ? ['#2e6b2e', '#3b8038', '#4c9444'] : ['#3f8a3a', '#4d9c44', '#62b155'];
      const out = swamp ? '#26381f' : '#1f4a1f';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + s.v;
        circle(x + Math.cos(a) * r * 0.55 + sway, y + Math.sin(a) * r * 0.55 - 6, r * 0.62, cols[0], out, 2.5);
      }
      circle(x + sway, y - 6, r * 0.78, cols[1]);
      circle(x - r * 0.2 + sway, y - r * 0.25 - 6, r * 0.45, cols[2]);
      if (swamp) {
        ctx.strokeStyle = 'rgba(40,60,30,0.8)'; ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r - 6); ctx.lineTo(x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r + 10); ctx.stroke(); }
      }
    }
  } else if (s.type === 'rock') {
    shadow(x, y, r, 0.25);
    const b = s.biome;
    const base = b === S.B.VOLCANO ? '#2e2530' : b === S.B.SNOW ? '#8d98a3' : '#8a857c';
    const hi = b === S.B.VOLCANO ? '#4a3d52' : b === S.B.SNOW ? '#b8c3cc' : '#aaa59b';
    ctx.fillStyle = base; polyRand(x, y, r, s.v, 8, 0.28); ctx.fill();
    ctx.strokeStyle = darker(b === S.B.VOLCANO ? '#2e2530' : '#8a857c', 0.55); ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = hi; polyRand(x - r * 0.18, y - r * 0.2, r * 0.55, s.v + 1, 6, 0.3); ctx.fill();
    if (b === S.B.SNOW) { ctx.fillStyle = 'rgba(255,255,255,0.9)'; polyRand(x - r * 0.2, y - r * 0.35, r * 0.4, s.v + 2, 6, 0.3); ctx.fill(); }
    if (b === S.B.VOLCANO) { ctx.strokeStyle = 'rgba(255,100,40,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - r * 0.4, y + r * 0.1); ctx.lineTo(x, y + r * 0.3); ctx.lineTo(x + r * 0.3, y); ctx.stroke(); }
  } else {
    shadow(x, y, r, 0.25);
    ctx.fillStyle = '#5a4f47'; polyRand(x, y, r, s.v, 7, 0.25); ctx.fill();
    ctx.strokeStyle = '#2f2823'; ctx.lineWidth = 3; ctx.stroke();
    const glint = (Math.sin(t * 3 + s.v) + 1) / 2;
    for (let i = 0; i < 3; i++) {
      const a = s.v + i * 2.1;
      const cx = x + Math.cos(a) * r * 0.35, cy = y + Math.sin(a) * r * 0.35 - 4;
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a * 0.3 - 0.4);
      ctx.fillStyle = i === 0 ? '#ffe27a' : '#f2c040';
      ctx.beginPath(); ctx.moveTo(0, -r * 0.55); ctx.lineTo(r * 0.22, 0); ctx.lineTo(0, r * 0.3); ctx.lineTo(-r * 0.22, 0); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#9a6a10'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
    ctx.globalAlpha = glint * 0.8;
    circle(x - r * 0.1, y - r * 0.4, 3, '#ffffff');
    ctx.globalAlpha = 1;
  }
  if (s.hp < 100) hpBar(x, y + r + 8, 40, s.hp, '#e8c95a');
}

function teamFlag(x, y, rel, t, scale) {
  const col = REL_COLORS[rel];
  const sc = scale || 1;
  ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 3 * sc;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 34 * sc); ctx.stroke();
  const w = Math.sin(t * 5 + x) * 3 * sc;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(x, y - 34 * sc); ctx.quadraticCurveTo(x + 12 * sc, y - 36 * sc + w, x + 24 * sc, y - 30 * sc + w);
  ctx.lineTo(x + 24 * sc, y - 22 * sc + w); ctx.quadraticCurveTo(x + 12 * sc, y - 24 * sc + w, x, y - 20 * sc); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = darker(col, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
}

function drawBuilding(s, t) {
  const { x, y, hs } = s;
  const col = REL_COLORS[s.rel];
  const dcol = darker(col, 0.6);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  roundRect(x - hs + 6, y - hs + 10, hs * 2, hs * 2, 8); ctx.fill();
  const stone = '#9c9282', stoneD = '#5e564b', stoneL = '#b7ae9e';
  switch (s.type) {
    case 'townhall': {
      ctx.fillStyle = stone; roundRect(x - hs, y - hs, hs * 2, hs * 2, 10); ctx.fill();
      ctx.strokeStyle = stoneD; ctx.lineWidth = 4; ctx.stroke();
      // courtyard
      ctx.fillStyle = '#b3a58c'; roundRect(x - hs + 16, y - hs + 16, hs * 2 - 32, hs * 2 - 32, 6); ctx.fill();
      // keep
      ctx.fillStyle = dcol; roundRect(x - 34, y - 40, 68, 68, 6); ctx.fill();
      ctx.fillStyle = col; roundRect(x - 28, y - 46, 56, 56, 6); ctx.fill();
      ctx.strokeStyle = dcol; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.moveTo(x - 28, y - 46); ctx.lineTo(x, y - 18); ctx.lineTo(x + 28, y - 46); ctx.closePath(); ctx.fill();
      // corner towers
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const tx = x + dx * (hs - 8), ty = y + dy * (hs - 8);
        circle(tx, ty, 22, stoneL, stoneD, 3);
        for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.fillStyle = stoneD; ctx.fillRect(tx + Math.cos(a) * 17 - 3, ty + Math.sin(a) * 17 - 3, 6, 6); }
        circle(tx, ty, 11, dcol);
      }
      teamFlag(x, y - 30, s.rel, t, 1.3);
      break;
    }
    case 'wall': {
      ctx.fillStyle = stone; roundRect(x - hs, y - hs, hs * 2, hs * 2, 4); ctx.fill();
      ctx.strokeStyle = stoneD; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = 'rgba(60,54,46,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - hs, y); ctx.lineTo(x + hs, y);
      ctx.moveTo(x - hs * 0.3, y - hs); ctx.lineTo(x - hs * 0.3, y);
      ctx.moveTo(x + hs * 0.4, y); ctx.lineTo(x + hs * 0.4, y + hs);
      ctx.stroke();
      ctx.fillStyle = col; ctx.globalAlpha = 0.5; ctx.fillRect(x - hs + 3, y - hs + 3, hs * 2 - 6, 4); ctx.globalAlpha = 1;
      break;
    }
    case 'tower':
    case 'magetower': {
      const mage = s.type === 'magetower';
      circle(x, y, hs, mage ? '#8a8298' : stone, stoneD, 4);
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; ctx.fillStyle = mage ? '#5a526a' : stoneD; ctx.fillRect(x + Math.cos(a) * (hs - 6) - 4, y + Math.sin(a) * (hs - 6) - 4, 8, 8); }
      circle(x, y, hs * 0.6, mage ? '#6b3fa0' : dcol);
      circle(x, y - 3, hs * 0.55, mage ? '#8e5cd0' : col, mage ? '#4a2a70' : dcol, 2);
      if (mage) {
        const bob = Math.sin(t * 3 + x) * 4;
        const g = ctx.createRadialGradient(x, y - 14 + bob, 2, x, y - 14 + bob, 26);
        g.addColorStop(0, 'rgba(230,200,255,1)'); g.addColorStop(0.4, 'rgba(170,110,255,0.8)'); g.addColorStop(1, 'rgba(120,60,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 14 + bob, 26, 0, TAU); ctx.fill();
        circle(x, y - 14 + bob, 7, '#f3e6ff');
      } else {
        // archer
        const a = s.aim || 0;
        circle(x, y - 6, 9, '#c9a57a', '#6a4a2a', 2);
        ctx.strokeStyle = '#6a4a2a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * 8, y - 6 + Math.sin(a) * 8, 12, a - 1.2, a + 1.2); ctx.stroke();
      }
      break;
    }
    case 'sawmill': {
      ctx.fillStyle = '#9a6a3a'; roundRect(x - hs, y - hs, hs * 2, hs * 2, 6); ctx.fill();
      ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = 'rgba(70,40,15,0.5)'; ctx.lineWidth = 2;
      for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x - hs, y - hs + i * hs * 0.4); ctx.lineTo(x + hs, y - hs + i * hs * 0.4); ctx.stroke(); }
      for (let i = 0; i < 3; i++) { circle(x - hs * 0.45, y + hs * 0.2 + i * 10 - 10, 7, '#c08a50', '#6a4220', 2); circle(x - hs * 0.45 + 14, y + hs * 0.2 + i * 10 - 10, 7, '#c08a50', '#6a4220', 2); }
      ctx.save(); ctx.translate(x + hs * 0.35, y - hs * 0.25); ctx.rotate(t * 4);
      circle(0, 0, 14, '#cfd4da', '#6a7078', 2);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.fillStyle = '#6a7078'; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 14, Math.sin(a) * 14); ctx.lineTo(Math.cos(a + 0.3) * 18, Math.sin(a + 0.3) * 18); ctx.lineTo(Math.cos(a + 0.4) * 13, Math.sin(a + 0.4) * 13); ctx.fill(); }
      circle(0, 0, 4, '#6a7078');
      ctx.restore();
      teamFlag(x + hs - 8, y + hs - 8, s.rel, t, 0.8);
      break;
    }
    case 'quarry': {
      ctx.fillStyle = '#7d766b'; roundRect(x - hs, y - hs, hs * 2, hs * 2, 12); ctx.fill();
      ctx.strokeStyle = stoneD; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#5f594f'; ctx.beginPath(); ctx.ellipse(x, y, hs * 0.65, hs * 0.5, 0, 0, TAU); ctx.fill();
      for (let i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? '#b5ada0' : '#9d958a'; polyRand(x - 18 + (i % 3) * 16, y - 8 + ((i / 3) | 0) * 16, 10, i + 3, 6, 0.3); ctx.fill(); ctx.strokeStyle = stoneD; ctx.lineWidth = 1.5; ctx.stroke(); }
      const sw = Math.sin(t * 5) * 0.5;
      ctx.save(); ctx.translate(x + hs * 0.45, y - hs * 0.45); ctx.rotate(sw);
      ctx.strokeStyle = '#6a4a2a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 22); ctx.stroke();
      ctx.strokeStyle = '#cfd4da'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 12, 14, -2.4, -0.7); ctx.stroke();
      ctx.restore();
      teamFlag(x - hs + 10, y + hs - 8, s.rel, t, 0.8);
      break;
    }
    case 'mine': {
      ctx.fillStyle = '#6b5f52'; roundRect(x - hs, y - hs, hs * 2, hs * 2, 14); ctx.fill();
      ctx.strokeStyle = '#3e352c'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#1b1510'; ctx.beginPath(); ctx.arc(x, y + 6, hs * 0.5, Math.PI, 0); ctx.lineTo(x + hs * 0.5, y + 14); ctx.lineTo(x - hs * 0.5, y + 14); ctx.fill();
      ctx.strokeStyle = '#8a5a2a'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x - hs * 0.55, y + 16); ctx.lineTo(x - hs * 0.55, y - hs * 0.25); ctx.lineTo(x + hs * 0.55, y - hs * 0.25); ctx.lineTo(x + hs * 0.55, y + 16); ctx.stroke();
      for (let i = 0; i < 4; i++) circle(x - 16 + i * 11, y + hs * 0.6, 5, '#ffd34a', '#a87a10', 1.5);
      teamFlag(x + hs - 10, y - hs + 36, s.rel, t, 0.8);
      break;
    }
    case 'barracks': {
      ctx.fillStyle = '#8a7a64'; roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.fill();
      ctx.strokeStyle = '#4a3f32'; ctx.lineWidth = 3; ctx.stroke();
      // tent
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x - hs * 0.7, y + hs * 0.5); ctx.lineTo(x, y - hs * 0.7); ctx.lineTo(x + hs * 0.7, y + hs * 0.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = dcol; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = dcol; ctx.beginPath(); ctx.moveTo(x - 10, y + hs * 0.5); ctx.lineTo(x, y + 2); ctx.lineTo(x + 10, y + hs * 0.5); ctx.fill();
      // crossed swords
      ctx.strokeStyle = '#e6e9ee'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - hs + 10, y - hs + 10); ctx.lineTo(x - hs + 30, y - hs + 30); ctx.moveTo(x - hs + 30, y - hs + 10); ctx.lineTo(x - hs + 10, y - hs + 30); ctx.stroke();
      break;
    }
    case 'shrine': {
      const pulse = (Math.sin(t * 2.5) + 1) / 2;
      ctx.globalAlpha = 0.05 + pulse * 0.05;
      circle(x, y, S.BUILDINGS.shrine.range, s.rel <= 1 ? '#7dffb0' : '#ff9a9a');
      ctx.globalAlpha = 1;
      circle(x, y, hs, '#d8d2c4', '#8a8374', 3);
      ctx.strokeStyle = `rgba(90,255,160,${0.5 + pulse * 0.5})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, hs * 0.7, 0, TAU); ctx.stroke();
      for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + t * 0.5; circle(x + Math.cos(a) * hs * 0.7, y + Math.sin(a) * hs * 0.7, 3, '#bfffd8'); }
      circle(x, y - 6, 10, '#f4f1e8', '#8a8374', 2);
      const g = ctx.createRadialGradient(x, y - 12, 1, x, y - 12, 20);
      g.addColorStop(0, 'rgba(200,255,220,0.9)'); g.addColorStop(1, 'rgba(100,255,160,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y - 12, 20, 0, TAU); ctx.fill();
      teamFlag(x + hs - 6, y + hs - 4, s.rel, t, 0.7);
      break;
    }
  }
  // level pips
  if (s.type !== 'wall') {
    for (let i = 0; i < s.lvl; i++) {
      ctx.fillStyle = '#ffd76a'; ctx.strokeStyle = '#6a4a10'; ctx.lineWidth = 1.5;
      star(x - (s.lvl - 1) * 7 + i * 14, y + hs - 6, 5);
    }
  }
  if (s.hp < 100) hpBar(x, y - hs - 14, Math.min(90, hs * 1.4), s.hp, s.rel === 2 ? '#e8514a' : s.rel === 1 ? '#45c46a' : '#3d9df3');
}
function star(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// =================================================================== unit drawing
function drawHero(x, y, cls, aim, rel, anim, flags, t, flash) {
  const c = S.CLASSES[cls];
  const r = c.r;
  const col = REL_COLORS[rel];
  shadow(x, y, r);
  if (flags.recall) {
    ctx.strokeStyle = `rgba(160,220,255,${0.4 + Math.sin(t * 12) * 0.3})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 14 + Math.sin(t * 6) * 4, 0, TAU); ctx.stroke();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aim);
  // weapon
  if (cls === 'warrior') {
    const sw = anim < 1 ? lerp(-1.3, 1.3, 1 - Math.pow(1 - anim, 3)) : 0.9;
    if (anim < 0.6) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - anim / 0.6)})`; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(0, 0, c.range - 10, -1.2, lerp(-1.2, 1.2, Math.min(1, anim * 2.5))); ctx.stroke();
    }
    ctx.save(); ctx.rotate(sw);
    ctx.fillStyle = '#e8ecf2'; ctx.strokeStyle = '#4a4f58'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(r + 2, -4); ctx.lineTo(r + 50, -3); ctx.lineTo(r + 58, 0); ctx.lineTo(r + 50, 3); ctx.lineTo(r + 2, 4); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c9a040'; ctx.fillRect(r - 2, -10, 5, 20);
    ctx.fillStyle = '#6a4220'; ctx.fillRect(r - 12, -3, 11, 6);
    ctx.restore();
    // shield
    ctx.fillStyle = darker(col, 0.8); ctx.strokeStyle = '#c9a040'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(r * 0.35, -r * 0.85, 12, 8, 0.3, 0, TAU); ctx.fill(); ctx.stroke();
  } else if (cls === 'ranger') {
    const pull = anim < 1 ? Math.max(0, 1 - anim * 3) : 0;
    ctx.strokeStyle = '#7a4a1e'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(r * 0.3, 0, r + 4, -1.05, 1.05); ctx.stroke();
    const bx = r * 0.3 + Math.cos(1.05) * (r + 4), by = Math.sin(1.05) * (r + 4);
    const sx = r * 0.3 + 2 - pull * 10 - (anim >= 1 ? 8 : 0);
    ctx.strokeStyle = '#eee'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(bx, -by); ctx.lineTo(sx, 0); ctx.lineTo(bx, by); ctx.stroke();
    if (anim > 0.35) { ctx.strokeStyle = '#d8c090'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(r + 22, 0); ctx.stroke(); }
  } else {
    ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.85); ctx.lineTo(r + 20, r * 0.85); ctx.stroke(); ctx.lineCap = 'butt';
    const glow = anim < 1 ? 1 - anim : 0;
    const g = ctx.createRadialGradient(r + 22, r * 0.85, 1, r + 22, r * 0.85, 14 + glow * 10);
    g.addColorStop(0, '#fff3d0'); g.addColorStop(0.35, '#ff9a3d'); g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(r + 22, r * 0.85, 14 + glow * 10, 0, TAU); ctx.fill();
  }
  ctx.restore();
  // body
  circle(x, y, r, col, darker(col, 0.55), 3.5);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, TAU); ctx.fill();
  // class headgear (top-down)
  ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
  if (cls === 'warrior') {
    circle(0, 0, r * 0.62, '#b8bec8', '#5a606a', 2.5);
    ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(r * 0.1, -r * 0.4); ctx.lineTo(r * 0.1, r * 0.4); ctx.stroke();
    ctx.fillStyle = '#efe6d0';
    ctx.beginPath(); ctx.moveTo(-r * 0.1, -r * 0.55); ctx.lineTo(-r * 0.45, -r * 1.05); ctx.lineTo(r * 0.15, -r * 0.6); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-r * 0.1, r * 0.55); ctx.lineTo(-r * 0.45, r * 1.05); ctx.lineTo(r * 0.15, r * 0.6); ctx.fill();
  } else if (cls === 'ranger') {
    ctx.fillStyle = '#3f6e2e'; ctx.strokeStyle = '#243f1a'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(-r * 0.05, 0, r * 0.66, 0.9, TAU - 0.9); ctx.lineTo(-r * 0.95, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f1d3b0'; ctx.beginPath(); ctx.arc(r * 0.25, 0, r * 0.3, -1.2, 1.2); ctx.fill();
  } else {
    ctx.fillStyle = '#5a3a9a'; ctx.strokeStyle = '#321f5c'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.75, r * 0.7, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7a52c8'; ctx.beginPath(); ctx.moveTo(r * 0.3, 0); ctx.lineTo(-r * 0.9, -r * 0.3); ctx.lineTo(-r * 0.9, r * 0.3); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd76a'; star(r * 0.05, 0, 5);
  }
  ctx.restore();
  if (flash) { ctx.globalAlpha = flash * 0.6; circle(x, y, r + 1, '#ffffff'); ctx.globalAlpha = 1; }
  if (flags.invuln) { ctx.strokeStyle = `rgba(255,240,180,${0.5 + Math.sin(t * 10) * 0.3})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 7, 0, TAU); ctx.stroke(); }
  if (flags.slow) { ctx.strokeStyle = 'rgba(150,220,255,0.8)'; ctx.lineWidth = 3; ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
}

const MOB_COL = { wolf: '#8a8c90', goblin: '#6fae4a', slime: '#5ecb6a', skeleton: '#e9e4d6', imp: '#d8483a', golem: '#8a7a68' };
function drawMob(x, y, type, aim, anim, t, tier, flash, id) {
  const d = S.MOBS[type];
  const r = d.r * (tier > 1.5 ? 1.12 : 1);
  const col = MOB_COL[type];
  shadow(x, y, r);
  ctx.save(); ctx.translate(x, y);
  const lunge = anim < 0.3 ? Math.sin((anim / 0.3) * Math.PI) * 8 : 0;
  switch (type) {
    case 'wolf': {
      ctx.rotate(aim);
      ctx.translate(lunge, 0);
      ctx.strokeStyle = '#5a5c60'; ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.9, 0); ctx.quadraticCurveTo(-r * 1.5, Math.sin(t * 8 + id) * 8, -r * 1.8, 0); ctx.stroke(); ctx.lineCap = 'butt';
      ctx.fillStyle = col; ctx.strokeStyle = '#4a4c50'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(-r * 0.15, 0, r * 1.05, r * 0.7, 0, 0, TAU); ctx.fill(); ctx.stroke();
      circle(r * 0.75, 0, r * 0.55, '#9a9ca0', '#4a4c50', 3);
      ctx.fillStyle = '#4a4c50';
      ctx.beginPath(); ctx.moveTo(r * 0.6, -r * 0.35); ctx.lineTo(r * 0.45, -r * 0.8); ctx.lineTo(r * 0.9, -r * 0.4); ctx.fill();
      ctx.beginPath(); ctx.moveTo(r * 0.6, r * 0.35); ctx.lineTo(r * 0.45, r * 0.8); ctx.lineTo(r * 0.9, r * 0.4); ctx.fill();
      circle(r * 1.0, -r * 0.2, 2.5, '#ffdd55'); circle(r * 1.0, r * 0.2, 2.5, '#ffdd55');
      break;
    }
    case 'goblin': {
      ctx.rotate(aim);
      ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(r * 0.3, 0, r + 2, -1, 1); ctx.stroke();
      circle(0, 0, r, col, '#3a6a24', 3);
      ctx.fillStyle = col; ctx.strokeStyle = '#3a6a24'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.lineTo(-r * 0.4, -r * 1.5); ctx.lineTo(r * 0.3, -r * 0.8); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, r * 0.7); ctx.lineTo(-r * 0.4, r * 1.5); ctx.lineTo(r * 0.3, r * 0.8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#7a4a2a'; ctx.beginPath(); ctx.arc(-r * 0.15, 0, r * 0.55, 1.3, TAU - 1.3); ctx.fill();
      circle(r * 0.5, -r * 0.25, 2.5, '#ffee55'); circle(r * 0.5, r * 0.25, 2.5, '#ffee55');
      break;
    }
    case 'slime': {
      const wob = Math.sin(t * 5 + id) * 0.08;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = col; ctx.strokeStyle = '#2e7a3a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(0, 0, r * (1 + wob), r * (1 - wob), 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.beginPath(); ctx.ellipse(-r * 0.35, -r * 0.4, r * 0.3, r * 0.18, -0.5, 0, TAU); ctx.fill();
      circle(Math.cos(aim) * r * 0.35 - 5, Math.sin(aim) * r * 0.35, 3.5, '#12301a');
      circle(Math.cos(aim) * r * 0.35 + 5, Math.sin(aim) * r * 0.35, 3.5, '#12301a');
      break;
    }
    case 'skeleton': {
      ctx.rotate(aim); ctx.translate(lunge, 0);
      ctx.strokeStyle = '#bdb6a4'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, r * 0.8); ctx.lineTo(r + 18, r * 0.5); ctx.stroke();
      circle(0, 0, r, col, '#8a8474', 3);
      circle(r * 0.35, -r * 0.3, 4, '#1a1410'); circle(r * 0.35, r * 0.3, 4, '#1a1410');
      circle(r * 0.35, -r * 0.3, 1.5, '#7dd8ff'); circle(r * 0.35, r * 0.3, 1.5, '#7dd8ff');
      ctx.strokeStyle = '#8a8474'; ctx.lineWidth = 1.5;
      for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(-r * 0.5, i * 5); ctx.lineTo(-r * 0.05, i * 5); ctx.stroke(); }
      break;
    }
    case 'imp': {
      ctx.rotate(aim);
      const flap = Math.sin(t * 14 + id) * 0.4;
      ctx.fillStyle = '#8a2a20';
      ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.5); ctx.lineTo(-r * 1.1, -r * (1.5 + flap)); ctx.lineTo(-r * 0.7, -r * 0.3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.5); ctx.lineTo(-r * 1.1, r * (1.5 + flap)); ctx.lineTo(-r * 0.7, r * 0.3); ctx.fill();
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, r * 1.8);
      g.addColorStop(0, 'rgba(255,120,40,0.35)'); g.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 1.8, 0, TAU); ctx.fill();
      circle(0, 0, r, col, '#6a1a14', 3);
      ctx.fillStyle = '#2a1a14';
      ctx.beginPath(); ctx.moveTo(r * 0.2, -r * 0.5); ctx.lineTo(r * 0.9, -r * 0.9); ctx.lineTo(r * 0.5, -r * 0.3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(r * 0.2, r * 0.5); ctx.lineTo(r * 0.9, r * 0.9); ctx.lineTo(r * 0.5, r * 0.3); ctx.fill();
      circle(r * 0.5, -r * 0.22, 2.5, '#ffe14a'); circle(r * 0.5, r * 0.22, 2.5, '#ffe14a');
      break;
    }
    case 'golem': {
      ctx.rotate(aim * 0.3);
      ctx.translate(lunge * 0.5, 0);
      ctx.fillStyle = col; ctx.strokeStyle = '#4a3f32'; ctx.lineWidth = 4;
      polyRand(0, 0, r, 77, 8, 0.15); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#6e8a4a'; polyRand(-r * 0.3, -r * 0.4, r * 0.35, 12, 6, 0.3); ctx.fill();
      ctx.restore(); ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
      circle(r * 0.95, -r * 0.7, r * 0.35, '#7a6a58', '#4a3f32', 3);
      circle(r * 0.95, r * 0.7, r * 0.35, '#7a6a58', '#4a3f32', 3);
      circle(r * 0.45, -r * 0.25, 4, '#ff9a3d'); circle(r * 0.45, r * 0.25, 4, '#ff9a3d');
      break;
    }
  }
  ctx.restore();
  if (flash) { ctx.globalAlpha = flash * 0.8; circle(x, y, r, '#ffffff'); ctx.globalAlpha = 1; }
}

function drawKnight(x, y, aim, rel, anim, flash) {
  const r = S.KNIGHT.r;
  const col = REL_COLORS[rel];
  shadow(x, y, r);
  ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
  const sw = anim < 0.4 ? lerp(-1, 1, anim / 0.4) : 0.6;
  ctx.save(); ctx.rotate(sw);
  ctx.fillStyle = '#e0e4ea'; ctx.strokeStyle = '#4a4f58'; ctx.lineWidth = 1.5;
  ctx.fillRect(r, -2.5, 28, 5); ctx.strokeRect(r, -2.5, 28, 5);
  ctx.fillStyle = '#c9a040'; ctx.fillRect(r - 2, -7, 4, 14);
  ctx.restore();
  ctx.fillStyle = col; ctx.strokeStyle = '#e0e4ea'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(r * 0.2, -r * 1.2); ctx.lineTo(r * 0.9, -r * 0.9); ctx.lineTo(r * 0.6, -r * 0.3); ctx.lineTo(0, -r * 0.6); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  circle(x, y, r, '#a8aeb8', darker(col, 0.7), 3);
  circle(x, y, r * 0.55, col);
  ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + Math.cos(aim) * r * 0.2, y + Math.sin(aim) * r * 0.2); ctx.lineTo(x + Math.cos(aim) * r * 0.9, y + Math.sin(aim) * r * 0.9); ctx.stroke();
  if (flash) { ctx.globalAlpha = flash * 0.8; circle(x, y, r, '#ffffff'); ctx.globalAlpha = 1; }
}

function drawBoss(x, y, key, aim, enraged, t, flash) {
  const def = S.BOSSES.find((b) => b.key === key);
  const r = def.r;
  shadow(x, y, r, 0.3);
  if (enraged) {
    const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 1.8);
    g.addColorStop(0, 'rgba(255,40,20,0.35)'); g.addColorStop(1, 'rgba(255,40,20,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, TAU); ctx.fill();
  }
  ctx.save(); ctx.translate(x, y);
  if (key === 'treant') {
    ctx.rotate(aim);
    ctx.strokeStyle = '#4a2e18'; ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      const wave = Math.sin(t * 2 + s) * 0.3;
      ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(0, s * r * 0.6); ctx.quadraticCurveTo(r * 0.8, s * r * (1.1 + wave), r * 1.3, s * r * (0.7 + wave)); ctx.stroke();
      ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(r * 1.1, s * r * (0.85 + wave)); ctx.lineTo(r * 1.45, s * r * (1.0 + wave)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    circle(0, 0, r * 0.85, '#6b4428', '#3a2414', 5);
    ctx.strokeStyle = 'rgba(40,20,10,0.5)'; ctx.lineWidth = 2;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.arc(0, 0, r * 0.2 * i, 0, TAU); ctx.stroke(); }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU + Math.sin(t + i) * 0.05;
      circle(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85, r * 0.32, i % 2 ? '#3b8038' : '#2e6b2e', '#1f4a1f', 2.5);
    }
    circle(r * 0.35, -r * 0.22, 7, '#b4ff6a'); circle(r * 0.35, r * 0.22, 7, '#b4ff6a');
  } else if (key === 'lich') {
    for (let i = 0; i < 4; i++) {
      const a = t * 1.5 + (i / 4) * TAU;
      const g = ctx.createRadialGradient(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 1, Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 14);
      g.addColorStop(0, '#e8fbff'); g.addColorStop(0.4, '#6ad8ff'); g.addColorStop(1, 'rgba(60,160,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 14, 0, TAU); ctx.fill();
    }
    ctx.rotate(aim);
    ctx.fillStyle = '#2a1f3a'; ctx.strokeStyle = '#120c1c'; ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < 14; i++) { const a = (i / 14) * TAU; const rr = r * (i % 2 ? 1.05 : 1.2) + Math.sin(t * 4 + i) * 3; ctx.lineTo(Math.cos(a) * rr - r * 0.15, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    circle(r * 0.1, 0, r * 0.55, '#e9e4d6', '#8a8474', 3);
    circle(r * 0.35, -r * 0.2, 6, '#101018'); circle(r * 0.35, r * 0.2, 6, '#101018');
    circle(r * 0.35, -r * 0.2, 3, '#6ad8ff'); circle(r * 0.35, r * 0.2, 3, '#6ad8ff');
    ctx.fillStyle = '#ffd34a'; ctx.strokeStyle = '#8a6a10'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) { const a = -0.9 + i * 0.45 + Math.PI; ctx.lineTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55); ctx.lineTo(Math.cos(a + 0.22) * r * 0.85, Math.sin(a + 0.22) * r * 0.85); }
    ctx.stroke(); ctx.fill();
  } else if (key === 'hydra') {
    ctx.rotate(aim);
    circle(-r * 0.2, 0, r * 0.9, '#3e6b3a', '#1f3a1d', 5);
    ctx.fillStyle = 'rgba(160,200,90,0.35)';
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.beginPath(); ctx.arc(-r * 0.2 + Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, 8, 0, TAU); ctx.fill(); }
    for (let h = -1; h <= 1; h++) {
      const a = h * 0.75 + Math.sin(t * 2.3 + h * 2) * 0.12;
      const hx = Math.cos(a) * r * 1.2, hy = Math.sin(a) * r * 1.2;
      ctx.strokeStyle = '#1f3a1d'; ctx.lineWidth = 24; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(Math.cos(a) * r * 0.6 + Math.sin(t * 3 + h) * 10, Math.sin(a) * r * 0.6, hx, hy); ctx.stroke();
      ctx.strokeStyle = '#4f8a45'; ctx.lineWidth = 18;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(Math.cos(a) * r * 0.6 + Math.sin(t * 3 + h) * 10, Math.sin(a) * r * 0.6, hx, hy); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(a);
      ctx.fillStyle = '#4f8a45'; ctx.strokeStyle = '#1f3a1d'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(8, 0, 22, 15, 0, 0, TAU); ctx.fill(); ctx.stroke();
      circle(14, -7, 3.5, '#ffe14a'); circle(14, 7, 3.5, '#ffe14a');
      ctx.restore();
    }
  } else if (key === 'colossus') {
    ctx.rotate(aim);
    const punch = Math.sin(t * 3) * 6;
    circle(r * 0.55 + punch, -r * 0.95, r * 0.38, '#7d766b', '#3e3a33', 4);
    circle(r * 0.55 - punch, r * 0.95, r * 0.38, '#7d766b', '#3e3a33', 4);
    ctx.fillStyle = '#8f887c'; ctx.strokeStyle = '#3e3a33'; ctx.lineWidth = 5;
    polyRand(0, 0, r, 5, 9, 0.12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#6e8a4a'; polyRand(-r * 0.35, -r * 0.35, r * 0.35, 8, 7, 0.3); ctx.fill();
    ctx.fillStyle = '#6e8a4a'; polyRand(-r * 0.4, r * 0.4, r * 0.25, 9, 7, 0.3); ctx.fill();
    const glow = 0.6 + Math.sin(t * 4) * 0.4;
    ctx.strokeStyle = `rgba(90,200,255,${glow})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.1); ctx.lineTo(0, r * 0.2); ctx.lineTo(-r * 0.25, r * 0.4); ctx.stroke();
    circle(r * 0.5, -r * 0.2, 7, `rgba(90,200,255,${glow})`); circle(r * 0.5, r * 0.2, 7, `rgba(90,200,255,${glow})`);
  } else if (key === 'dragon') {
    ctx.rotate(aim);
    const flap = Math.sin(t * 4) * 0.25;
    ctx.fillStyle = '#8a1e14'; ctx.strokeStyle = '#3a0a06'; ctx.lineWidth = 4;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(r * 0.1, s * r * 0.3);
      ctx.lineTo(-r * 0.2, s * r * (1.9 + flap)); ctx.lineTo(-r * 0.6, s * r * (1.4 + flap));
      ctx.lineTo(-r * 0.9, s * r * (1.7 + flap)); ctx.lineTo(-r * 1.0, s * r * (1.1 + flap)); ctx.lineTo(-r * 0.6, s * r * 0.3);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = '#b8281a'; ctx.lineWidth = 18; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-r * 0.6, 0); ctx.quadraticCurveTo(-r * 1.3, Math.sin(t * 2) * 30, -r * 1.8, Math.sin(t * 2 + 1) * 20); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#c42e1e'; ctx.strokeStyle = '#4a0e08'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 0.8, r * 0.55, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e8a040';
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(-r * 0.6 + i * r * 0.25, -4); ctx.lineTo(-r * 0.5 + i * r * 0.25, 0); ctx.lineTo(-r * 0.6 + i * r * 0.25, 4); ctx.fill(); }
    ctx.fillStyle = '#c42e1e';
    ctx.beginPath(); ctx.ellipse(r * 0.85, 0, r * 0.4, r * 0.28, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#efe0c0';
    ctx.beginPath(); ctx.moveTo(r * 0.7, -r * 0.2); ctx.lineTo(r * 0.4, -r * 0.5); ctx.lineTo(r * 0.8, -r * 0.25); ctx.fill();
    ctx.beginPath(); ctx.moveTo(r * 0.7, r * 0.2); ctx.lineTo(r * 0.4, r * 0.5); ctx.lineTo(r * 0.8, r * 0.25); ctx.fill();
    circle(r * 0.95, -r * 0.12, 4, '#ffe14a'); circle(r * 0.95, r * 0.12, 4, '#ffe14a');
  }
  ctx.restore();
  if (flash) { ctx.globalAlpha = flash * 0.5; circle(x, y, r * 0.9, '#ffffff'); ctx.globalAlpha = 1; }
}

function drawProj(p, t) {
  const [, type, , , , mine] = p.row;
  const { x, y, a } = p;
  switch (type) {
    case 'arrow': case 'tarrow': case 'gob': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.strokeStyle = type === 'gob' ? '#6a4a2a' : '#d8c090'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(6, 0); ctx.stroke();
      ctx.fillStyle = '#e6e9ee'; ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(3, -4); ctx.lineTo(3, 4); ctx.fill();
      ctx.fillStyle = mine ? '#8fd0ff' : type === 'gob' ? '#6fae4a' : '#ff8a7a';
      ctx.beginPath(); ctx.moveTo(-18, 0); ctx.lineTo(-12, -4); ctx.lineTo(-10, 0); ctx.lineTo(-12, 4); ctx.fill();
      ctx.restore();
      break;
    }
    case 'fire': case 'fireball': case 'imp': case 'flame': {
      const r = type === 'fireball' ? 16 : type === 'flame' ? 12 + Math.sin(t * 30 + x) * 3 : type === 'imp' ? 9 : 11;
      const g = ctx.createRadialGradient(x, y, 1, x, y, r * 2);
      g.addColorStop(0, '#fff6d0'); g.addColorStop(0.3, '#ffb040'); g.addColorStop(0.65, 'rgba(255,80,20,0.6)'); g.addColorStop(1, 'rgba(255,40,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2, 0, TAU); ctx.fill();
      if (Math.random() < 0.4) particles.push({ x, y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, t: 0, life: 0.3, c: '#ff9a3d', s: 4 });
      break;
    }
    case 'magic': case 'bolt': {
      const c1 = type === 'magic' ? '#d8b8ff' : '#c8f4ff', c2 = type === 'magic' ? 'rgba(150,90,255,0.7)' : 'rgba(80,190,255,0.7)';
      const g = ctx.createRadialGradient(x, y, 1, x, y, 20);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, c1); g.addColorStop(0.6, c2); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 20, 0, TAU); ctx.fill();
      break;
    }
    case 'seed': circle(x, y, 12, '#8a6a2a', '#3a5a1a', 3); circle(x - 3, y - 3, 4, '#b4ff6a'); break;
    case 'poison': {
      const g = ctx.createRadialGradient(x, y, 1, x, y, 16);
      g.addColorStop(0, '#e8ff9a'); g.addColorStop(0.4, '#8ad83a'); g.addColorStop(1, 'rgba(60,140,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 16, 0, TAU); ctx.fill();
      break;
    }
    case 'shock': ctx.fillStyle = '#9a8a70'; polyRand(x, y, 13, (x | 0) % 50, 6, 0.3); ctx.fill(); ctx.strokeStyle = '#4a3f32'; ctx.lineWidth = 2; ctx.stroke(); break;
    case 'rock':
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 6);
      ctx.fillStyle = '#8f887c'; polyRand(0, 0, 24, 3, 7, 0.25); ctx.fill(); ctx.strokeStyle = '#3e3a33'; ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
      break;
    default: circle(x, y, 8, '#fff');
  }
}

// =================================================================== main render
let lastFrame = performance.now();
let menuT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  // aim & fixed input step
  if (joined) {
    myAim = Math.atan2(mouse.y - H / 2, mouse.x - W / 2);
    accum += dt;
    while (accum >= S.DT) { accum -= S.DT; inputStep(); }
    vis.x *= Math.pow(0.001, dt); vis.y *= Math.pow(0.001, dt);
  }

  const world = joined ? sampleWorld(now) : null;
  if (joined && me && !dead) { cam.x = pred.x + vis.x; cam.y = pred.y + vis.y; }
  else if (!joined) { menuT += dt; cam.x = S.SPAWN.x + Math.cos(menuT * 0.05) * 1400; cam.y = S.SPAWN.y + Math.sin(menuT * 0.07) * 1100; cam.scale = Math.max(W / 1700, H / 1000); }

  const sc = cam.scale * DPR;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1a1612'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.setTransform(sc, 0, 0, sc, W * DPR / 2 - cam.x * sc, H * DPR / 2 - cam.y * sc);
  const vw = W / cam.scale / 2, vh = H / cam.scale / 2;
  const vx0 = cam.x - vw, vy0 = cam.y - vh, vx1 = cam.x + vw, vy1 = cam.y + vh;
  mouse.wx = cam.x + (mouse.x - W / 2) / cam.scale;
  mouse.wy = cam.y + (mouse.y - H / 2) / cam.scale;

  // ground
  for (let cx = Math.floor(vx0 / CHUNK); cx <= Math.floor(vx1 / CHUNK); cx++) {
    for (let cy = Math.floor(vy0 / CHUNK); cy <= Math.floor(vy1 / CHUNK); cy++) {
      if (cx < 0 || cy < 0 || cx * CHUNK >= S.W || cy * CHUNK >= S.H) continue;
      ctx.drawImage(getChunk(cx, cy), cx * CHUNK, cy * CHUNK);
    }
  }
  // world border
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 30; ctx.strokeRect(-15, -15, S.W + 30, S.H + 30);
  // boss lairs
  for (const b of S.BOSSES) {
    if (b.x < vx0 - 700 || b.x > vx1 + 700 || b.y < vy0 - 700 || b.y > vy1 + 700) continue;
    ctx.strokeStyle = 'rgba(120,20,10,0.35)'; ctx.lineWidth = 6; ctx.setLineDash([22, 16]);
    ctx.beginPath(); ctx.arc(b.x, b.y, 620, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(40,10,10,0.18)'; ctx.beginPath(); ctx.arc(b.x, b.y, 300, 0, TAU); ctx.fill();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.fillStyle = 'rgba(230,220,200,0.55)'; ctx.beginPath(); ctx.ellipse(b.x + Math.cos(a) * 280, b.y + Math.sin(a) * 280, 9, 6, a, 0, TAU); ctx.fill(); }
  }
  // spawn plaza
  if (Math.abs(S.SPAWN.x - cam.x) < vw + 500 && Math.abs(S.SPAWN.y - cam.y) < vh + 500) {
    ctx.fillStyle = 'rgba(210,190,150,0.35)'; ctx.beginPath(); ctx.arc(S.SPAWN.x, S.SPAWN.y, 240, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(140,120,90,0.5)'; ctx.lineWidth = 5; ctx.stroke();
    const g = ctx.createRadialGradient(S.SPAWN.x, S.SPAWN.y, 5, S.SPAWN.x, S.SPAWN.y, 60);
    g.addColorStop(0, `rgba(255,220,140,${0.6 + Math.sin(t * 2) * 0.2})`); g.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(S.SPAWN.x, S.SPAWN.y, 60, 0, TAU); ctx.fill();
    circle(S.SPAWN.x, S.SPAWN.y, 16, '#e8dcc0', '#8a7a5a', 3);
  }

  // my base radius
  if (pf && pf.th && (buildMode || (hovered && hovered.k === 'b' && hovered.rel === 0))) {
    const R = S.thRadius(pf.th[2]);
    ctx.fillStyle = 'rgba(61,157,243,0.07)'; ctx.beginPath(); ctx.arc(pf.th[0], pf.th[1], R, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(61,157,243,0.6)'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]); ctx.stroke(); ctx.setLineDash([]);
  }

  // collect drawables
  const draw = [];
  for (const s of statics) {
    const e = s.k === 'b' ? s.hs + 40 : s.r * 1.4;
    if (s.x + e < vx0 || s.x - e > vx1 || s.y + e < vy0 || s.y - e > vy1) continue;
    draw.push({ y: s.y + (s.k === 'b' ? s.hs * 0.5 : 0), s });
  }
  hovered = null;
  if (joined) {
    for (const s of statics) {
      if (s.k !== 'b') continue;
      if (Math.abs(mouse.wx - s.x) < s.hs && Math.abs(mouse.wy - s.y) < s.hs) { hovered = s; break; }
    }
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
    if (d.s) { if (d.s.k === 'n') drawNode(d.s, t); else drawBuilding(d.s, t); continue; }
    if (d.self) {
      const anim = atkAnim.has(myId) ? (now - atkAnim.get(myId)) / (pf.cls === 'warrior' ? 280 : 350) : 9;
      const myRow = world && findMyRow(world);
      const flags = { invuln: myRow && myRow[9], slow: myRow && myRow[10], recall: me.rc > 0 };
      const fl = hurtFlash.has(myId) ? Math.max(0, 1 - (now - hurtFlash.get(myId)) / 150) : 0;
      drawHero(cam.x, cam.y, pf.cls, myAim, 0, anim, flags, t, fl);
      names.push({ x: cam.x, y: cam.y, r: S.CLASSES[pf.cls].r, hp: Math.round((me.hp / me.mhp) * 100), rel: 0, id: myId, hero: true });
      continue;
    }
    const u = d.u, row = u.row;
    const id = row[0];
    const anim = atkAnim.has(id) ? (now - atkAnim.get(id)) / 300 : 9;
    const fl = hurtFlash.has(id) ? Math.max(0, 1 - (now - hurtFlash.get(id)) / 150) : 0;
    if (row[1] === 'h') {
      drawHero(u.x, u.y, row[2], u.aim, row[7], anim, { invuln: row[9], slow: row[10], recall: row[11] }, t, fl);
      names.push({ x: u.x, y: u.y, r: S.CLASSES[row[2]].r, hp: row[6], rel: row[7], id, hero: true });
    } else if (row[1] === 'm') {
      drawMob(u.x, u.y, row[2], u.aim, anim, t, row[11], fl, id);
      if (row[6] < 100) names.push({ x: u.x, y: u.y, r: S.MOBS[row[2]].r, hp: row[6], rel: 3 });
    } else if (row[1] === 'k') {
      drawKnight(u.x, u.y, u.aim, row[7], anim, fl);
      if (row[6] < 100) names.push({ x: u.x, y: u.y, r: S.KNIGHT.r, hp: row[6], rel: row[7] });
    } else if (row[1] === 'B') {
      drawBoss(u.x, u.y, row[2], u.aim, row[8], t, fl);
    }
  }
  if (world) for (const p of world.projs) drawProj(p, t);

  // build ghost
  if (joined && buildMode && pf) drawGhost();

  // fx
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    if (r.t > r.life) { rings.splice(i, 1); continue; }
    if (r.t < 0) continue;
    const k = r.t / r.life;
    const rad = lerp(r.r0, r.r1, 1 - Math.pow(1 - k, 2));
    ctx.globalAlpha = (1 - k) * 0.8;
    if (r.fill) { ctx.fillStyle = r.c; ctx.globalAlpha = (1 - k) * 0.25; ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.fill(); ctx.globalAlpha = (1 - k) * 0.8; }
    ctx.strokeStyle = r.c; ctx.lineWidth = 5 * (1 - k) + 1;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t > p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92;
    ctx.globalAlpha = 1 - p.t / p.life;
    ctx.fillStyle = p.c;
    ctx.fillRect(p.x - p.s / 2, p.y - p.s / 2, p.s, p.s);
  }
  ctx.globalAlpha = 1;

  // names & bars
  for (const n of names) {
    const col = n.rel === 0 ? '#6cc0ff' : n.rel === 1 ? '#7de89a' : n.rel === 2 ? '#ff8a80' : '#e0d0b0';
    if (n.hero) {
      const nm = info.names[n.id];
      if (nm) label(`${nm[1] ? `[${nm[1]}] ` : ''}${nm[0]}`, n.x, n.y - n.r - 14, 14, col, true);
      if (nm) label(`${nm[2]}`, n.x - n.r - 12, n.y + 4, 12, '#ffd76a', true);
      hpBar(n.x, n.y + n.r + 9, 46, n.hp, n.rel === 2 ? '#e8514a' : '#5fd16f');
      if (bubbles.has(n.id)) {
        const b = bubbles.get(n.id);
        if (now - b.t > 5000) bubbles.delete(n.id);
        else drawBubble(n.x, n.y - n.r - 34, b.m);
      }
    } else {
      hpBar(n.x, n.y + n.r + 8, 32, n.hp, n.rel === 3 ? '#e0a040' : n.rel === 2 ? '#e8514a' : '#5fd16f');
    }
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const f = texts[i];
    f.t += dt;
    if (f.t > f.life) { texts.splice(i, 1); continue; }
    const k = f.t / f.life;
    ctx.globalAlpha = k > 0.6 ? (1 - k) / 0.4 : 1;
    label(f.s, f.x, f.y - k * 40, f.size * (k < 0.15 ? 0.8 + k * 1.4 : 1), f.color, true);
  }
  ctx.globalAlpha = 1;

  // screen space
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (joined && me && !dead && me.hp / me.mhp < 0.3) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(160,0,0,0)'); g.addColorStop(1, `rgba(160,0,0,${0.35 + Math.sin(t * 6) * 0.1})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
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
  ctx.font = '13px Trebuchet MS, sans-serif';
  const s = m.length > 40 ? m.slice(0, 40) + '…' : m;
  const w = ctx.measureText(s).width + 14;
  ctx.fillStyle = 'rgba(255,250,240,0.92)';
  roundRect(x - w / 2, y - 18, w, 22, 8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 5, y + 4); ctx.lineTo(x, y + 10); ctx.lineTo(x + 5, y + 4); ctx.fill();
  ctx.fillStyle = '#2a2018'; ctx.textAlign = 'center'; ctx.fillText(s, x, y - 3);
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
function drawGhost() {
  const type = buildMode;
  const def = S.BUILDINGS[type];
  const x = S.snap(type, mouse.wx), y = S.snap(type, mouse.wy);
  const err = ghostError(type, x, y);
  const hs = def.size / 2;
  if (type === 'tower' || type === 'magetower' || type === 'shrine') {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.arc(x, y, def.range, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  if (type === 'townhall') {
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
    ctx.beginPath(); ctx.arc(x, y, S.thRadius(Math.max(1, pf.thLvl)), 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.globalAlpha = 0.55;
  drawBuilding({ type, x, y, hs, lvl: 1, hp: 100, rel: 0, aim: 0 }, performance.now() / 1000);
  ctx.globalAlpha = 1;
  ctx.fillStyle = err ? 'rgba(255,60,40,0.3)' : 'rgba(80,255,120,0.25)';
  ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
  ctx.strokeStyle = err ? '#ff5a4a' : '#5aff8a'; ctx.lineWidth = 2; ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
  if (err) label(err, x, y - hs - 10, 14, '#ffb0a0', true);
  // continuous wall painting
  if (type === 'wall' && mouse.down && !err && lastWallCell !== x + ',' + y) {
    lastWallCell = x + ',' + y;
    send({ t: 'build', type, x, y });
  }
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
    $('ability').querySelector('.ab-cd').style.background = k > 0 ? `conic-gradient(rgba(0,0,0,0.65) ${k * 360}deg, transparent 0)` : 'transparent';
    $('ability').style.borderColor = k > 0 ? 'rgba(255,214,150,0.25)' : '#ffd76a';
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
  pc.width = 90; pc.height = 70;
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
function drawPreviews(t) {
  for (const p of previews) {
    if (!p.cv.offsetParent) continue;
    const g = p.cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, 90, 70);
    g.translate(32, 36);
    g.scale(0.85, 0.85);
    // reuse the world drawing code on the preview canvas
    const real = ctx;
    ctx = g;
    drawHero(0, 0, p.cls, Math.sin(t * 1.5) * 0.4, 0, (t * 1000 % 1400) / 350, {}, t, 0);
    ctx = real;
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
