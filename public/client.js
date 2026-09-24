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
const TN = Math.ceil(S.W / S.TILE);
const biomeGrid = new Uint8Array(TN * TN);
for (let ty = 0; ty < TN; ty++) for (let tx = 0; tx < TN; tx++) biomeGrid[ty * TN + tx] = S.biomeAt((tx + 0.5) * S.TILE, (ty + 0.5) * S.TILE);
const biomeAtTile = (tx, ty) => biomeGrid[clamp(ty, 0, TN - 1) * TN + clamp(tx, 0, TN - 1)];
const biomeAtPos = (x, y) => biomeAtTile(Math.floor(x / S.TILE), Math.floor(y / S.TILE));


// ---- ground chunks, pre-rendered and cached
const CHUNK = 640;
const chunkCache = new Map();
function hashf(x, y, s) { return S.hash2(x | 0, y | 0, s); }
// tileable grain (single pixels) and mottling (soft blotches) laid over the paint so the ground reads as a texture
const NOISE = (function () {
  const mk = (n, fn) => { const c = document.createElement('canvas'); c.width = c.height = n; fn(c.getContext('2d'), n); return c; };
  const fine = mk(128, (g, n) => {
    const img = g.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const v = S.hash2(i % n, (i / n) | 0, 77);
      const a = v < 0.22 ? 26 : v > 0.8 ? 20 : v > 0.72 ? 9 : 0;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v > 0.5 ? 255 : 0;
      img.data[i * 4 + 3] = a;
    }
    g.putImageData(img, 0, 0);
  });
  const mottle = mk(256, (g, n) => {
    for (let i = 0; i < 110; i++) {
      const x = S.hash2(i, 1, 78) * n, y = S.hash2(i, 2, 78) * n, r = 10 + S.hash2(i, 3, 78) * 38;
      const light = S.hash2(i, 4, 78) > 0.5;
      for (const [ox, oy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n], [n, n], [-n, -n], [n, -n], [-n, n]]) {
        if (x + ox + r < 0 || x + ox - r > n || y + oy + r < 0 || y + oy - r > n) continue;
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, light ? 'rgba(255,250,215,0.09)' : 'rgba(20,15,5,0.1)'); gr.addColorStop(1, light ? 'rgba(255,250,215,0)' : 'rgba(20,15,5,0)');
        g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  });
  return { fine, mottle };
})();
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
  // soft shading where two biomes meet
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    const b = biomeAtTile(tx, ty);
    if (biomeAtTile(tx, ty - 1) !== b || biomeAtTile(tx - 1, ty) !== b) {
      const px = tx * T - x0 + T / 2, py = ty * T - y0 + T / 2;
      const gr = g.createRadialGradient(px, py, 0, px, py, T * 0.9);
      gr.addColorStop(0, 'rgba(0,0,0,0.07)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(px - T, py - T, T * 2, T * 2);
    }
  }
  const pat = (img, s) => { g.save(); g.translate(-(x0 % s), -(y0 % s)); g.fillStyle = g.createPattern(img, 'repeat'); g.fillRect(0, 0, CHUNK + s, CHUNK + s); g.restore(); };
  pat(NOISE.mottle, 256);
  // snow stays bright: wash the mottling back out
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    if (biomeAtTile(tx, ty) !== S.B.SNOW) continue;
    const px = tx * T - x0 + T / 2, py = ty * T - y0 + T / 2;
    const gr = g.createRadialGradient(px, py, T * 0.3, px, py, T * 0.85);
    gr.addColorStop(0, 'rgba(244,248,252,0.55)'); gr.addColorStop(1, 'rgba(244,248,252,0)');
    g.fillStyle = gr; g.fillRect(px - T, py - T, T * 2, T * 2);
  }
  // fine surface strokes: grass blades, gravel, snow crust...
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    drawGrain(g, biomeAtTile(tx, ty), tx, ty, tx * T - x0, ty * T - y0);
  }
  pat(NOISE.fine, 128);
  // decorations
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const tx = tx0 + i, ty = ty0 + j;
    const b = biomeAtTile(tx, ty);
    for (let k = 0; k < 7; k++) {
      const h = hashf(tx, ty, 40 + k);
      const px = tx * T - x0 + hashf(tx, ty, 50 + k) * T, py = ty * T - y0 + hashf(tx, ty, 60 + k) * T;
      drawDecor(g, b, h, px, py, hashf(tx, ty, 70 + k));
    }
  }
  return c;
}
const GRAIN = [
  ['rgba(60,110,35,0.30)', 'rgba(170,215,110,0.28)'],
  ['rgba(20,55,20,0.34)', 'rgba(120,170,90,0.22)'],
  ['rgba(70,64,58,0.30)', 'rgba(215,210,200,0.30)'],
  ['rgba(150,175,200,0.30)', 'rgba(255,255,255,0.7)'],
  ['rgba(30,45,25,0.35)', 'rgba(140,165,110,0.22)'],
  ['rgba(20,10,10,0.35)', 'rgba(150,110,90,0.22)'],
];
function drawGrain(g, b, tx, ty, px, py) {
  const T = S.TILE, cols = GRAIN[b];
  g.lineCap = 'round';
  for (let k = 0; k < 22; k++) {
    const h = hashf(tx, ty, 100 + k), x = px + hashf(tx, ty, 130 + k) * T, y = py + hashf(tx, ty, 160 + k) * T;
    g.strokeStyle = g.fillStyle = cols[k % 2];
    if (b === S.B.MEADOW || b === S.B.FOREST || b === S.B.SWAMP) {
      g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (h - 0.5) * 4, y - 3 - h * 4); g.stroke();
    } else if (b === S.B.MOUNTAIN) {
      if (k % 3) { g.fillRect(x, y, 1.5 + h * 2, 1.5 + h * 1.5); }
      else { g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 6 + h * 8, y + (h - 0.5) * 3); g.stroke(); }
    } else if (b === S.B.SNOW) {
      if (k % 2) { g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 6, y - 2, x + 12 + h * 8, y); g.stroke(); }
      else g.fillRect(x, y, 1.5, 1.5);
    } else {
      g.fillRect(x, y, 1 + h * 2.5, 1 + h * 2);
    }
  }
  g.lineCap = 'butt';
}
function drawDecor(g, b, h, x, y, h2) {
  const blades = (n, len, c1, c2) => {
    g.lineCap = 'round'; g.lineWidth = 1.7;
    for (let i = 0; i < n; i++) {
      const off = i - (n - 1) / 2, hh = S.hash2(x | 0, i, y | 0);
      const a = -Math.PI / 2 + off * 0.3 + (hh - 0.5) * 0.3, l = len * (0.7 + hh * 0.5);
      g.strokeStyle = i % 2 ? c1 : c2;
      g.beginPath(); g.moveTo(x + off * 1.8, y);
      g.quadraticCurveTo(x + off * 1.8 + Math.cos(a) * l * 0.3, y + Math.sin(a) * l * 0.6, x + off * 2.4 + Math.cos(a) * l, y + Math.sin(a) * l);
      g.stroke();
    }
    g.lineCap = 'butt';
  };
  const pebble = (px, py, r, c) => {
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.ellipse(px + 1, py + 1.5, r, r * 0.7, 0, 0, TAU); g.fill();
    g.fillStyle = c; g.beginPath(); g.ellipse(px, py, r, r * 0.7, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(px - r * 0.3, py - r * 0.25, r * 0.45, r * 0.25, 0, 0, TAU); g.fill();
  };
  const blob = (px, py, rx, ry, c, rot) => { g.fillStyle = c; g.beginPath(); g.ellipse(px, py, rx, ry, rot || 0, 0, TAU); g.fill(); };
  const line = (pts, c, w) => { g.strokeStyle = c; g.lineWidth = w; g.beginPath(); g.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]); g.stroke(); };
  const flower = (px, py, c, s) => {
    g.fillStyle = c;
    for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(px + Math.cos(i * 1.26) * 2.8 * s, py + Math.sin(i * 1.26) * 2.8 * s, 2.1 * s, 0, TAU); g.fill(); }
    g.fillStyle = '#e8a93a'; g.beginPath(); g.arc(px, py, 1.5 * s, 0, TAU); g.fill();
  };
  if (b === S.B.MEADOW) {
    if (h < 0.28) blades(5, 11 + h2 * 5, '#5f9a3e', '#8cc860');
    else if (h < 0.36) {
      const cols = ['#fff3a8', '#ff9fbf', '#ffffff', '#a8d4ff', '#d8a8ff'];
      const k = 1 + ((h2 * 3) | 0);
      for (let i = 0; i < k; i++) {
        const fx = x + (S.hash2(i, x | 0, 3) - 0.5) * 14, fy = y + (S.hash2(i, y | 0, 4) - 0.5) * 10;
        blob(fx + 3, fy + 2, 3, 1.5, '#4f8a32', 0.5);
        flower(fx, fy, cols[((h2 * 5) | 0 + i) % 5], 0.8 + S.hash2(i, 2, 5) * 0.4);
      }
    } else if (h < 0.42) {
      for (let i = 0; i < 3; i++) {
        const cx = x + i * 6 - 6, cy = y + (i % 2) * 4;
        for (let l = 0; l < 3; l++) blob(cx + Math.cos(l * 2.09) * 2.2, cy + Math.sin(l * 2.09) * 2.2, 2.4, 2.4, l ? '#5a9a3c' : '#6cae48');
      }
    } else if (h < 0.47) { pebble(x, y, 3 + h2 * 3, '#a39c90'); if (h2 > 0.5) pebble(x + 7, y + 3, 2, '#b8b0a2'); }
    else if (h < 0.51) {
      blob(x, y, 12 + h2 * 8, 7 + h2 * 4, 'rgba(130,100,60,0.2)');
      for (let i = 0; i < 4; i++) blob(x + (S.hash2(i, x | 0, 7) - 0.5) * 16, y + (S.hash2(i, y | 0, 8) - 0.5) * 8, 1.2, 1, 'rgba(90,70,40,0.4)');
    } else if (h < 0.54) {
      blob(x + 2, y + 4, 11, 5, 'rgba(0,0,0,0.18)');
      for (const [dx, dy, r, c] of [[-5, 0, 6, '#3f7e32'], [5, 0, 6, '#3f7e32'], [0, -4, 7, '#4f9a3e'], [-2, -6, 3.5, '#6cb450']]) blob(x + dx, y + dy, r, r * 0.9, c);
      if (h2 > 0.55) for (let i = 0; i < 4; i++) blob(x - 5 + i * 3.5, y - 2 + (i % 2) * 3, 1.5, 1.5, '#d8324a');
    } else if (h < 0.56) {
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 0.8;
      for (let i = 0; i < 8; i++) { const a = i * 0.785; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4); g.stroke(); }
      blob(x, y, 1.2, 1.2, '#f0f0e0');
    } else if (h < 0.565) {
      blob(x + 2, y + 3, 9, 5, 'rgba(0,0,0,0.2)');
      blob(x, y, 8, 6, '#8a5a30'); blob(x, y - 1, 7, 5, '#c8a070');
      g.strokeStyle = 'rgba(120,80,40,0.6)'; g.lineWidth = 0.8; g.beginPath(); g.ellipse(x, y - 1, 4, 2.8, 0, 0, TAU); g.moveTo(x + 1.5, y - 1); g.ellipse(x, y - 1, 1.5, 1, 0, 0, TAU); g.stroke();
    }
  } else if (b === S.B.FOREST) {
    if (h < 0.28) blades(4, 10 + h2 * 4, '#2f6a2a', '#4f8e3e');
    else if (h < 0.36) {
      const cols = ['#c9782e', '#d8a83a', '#9a4a2a', '#b89a3a'];
      for (let i = 0; i < 4; i++) blob(x + (S.hash2(i, x | 0, 9) - 0.5) * 18, y + (S.hash2(i, y | 0, 10) - 0.5) * 12, 3, 1.6, cols[(i + ((h2 * 4) | 0)) % 4], S.hash2(i, 1, 11) * 3);
    } else if (h < 0.42) {
      g.lineCap = 'round';
      for (let f = 0; f < 3; f++) {
        const a = -Math.PI / 2 + (f - 1) * 0.7, L = 14 + h2 * 5;
        const ex = x + Math.cos(a) * L, ey = y + Math.sin(a) * L;
        line([x, y, ex, ey], '#2f6a2a', 1.5);
        for (let k = 1; k < 6; k++) {
          const px = x + (ex - x) * k / 6, py = y + (ey - y) * k / 6, l = 5 * (1 - k / 7);
          line([px, py, px + Math.cos(a - 1.2) * l, py + Math.sin(a - 1.2) * l], '#3f8a36', 1.3);
          line([px, py, px + Math.cos(a + 1.2) * l, py + Math.sin(a + 1.2) * l], '#4f9a42', 1.3);
        }
      }
      g.lineCap = 'butt';
    } else if (h < 0.47) {
      const k = 1 + ((h2 * 3) | 0);
      for (let i = 0; i < k; i++) {
        const mx = x + i * 6 - k * 3, my = y + (i % 2) * 4, s = 1 - i * 0.2;
        g.fillStyle = '#e8dcc0'; g.fillRect(mx - 1.5, my - 2, 3, 5 * s);
        g.fillStyle = h2 > 0.5 ? '#c9423a' : '#a8743a'; g.beginPath(); g.arc(mx, my - 2, 4.5 * s, Math.PI, 0); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)'; blob(mx - 1.5 * s, my - 4 * s, 0.9, 0.9, g.fillStyle); blob(mx + 1.8 * s, my - 3.2 * s, 0.7, 0.7, g.fillStyle);
      }
    } else if (h < 0.52) {
      for (let i = 0; i < 5; i++) blob(x + (S.hash2(i, x | 0, 12) - 0.5) * 16, y + (S.hash2(i, y | 0, 13) - 0.5) * 9, 4 + S.hash2(i, 1, 14) * 3, 3, i % 2 ? 'rgba(90,150,60,0.55)' : 'rgba(60,120,45,0.55)');
    } else if (h < 0.55) {
      line([x - 9, y + 2, x, y, x + 10, y - 3], '#5a3a22', 2);
      line([x - 2, y, x - 5, y - 6], '#5a3a22', 1.4); line([x + 5, y - 1, x + 8, y + 4], '#5a3a22', 1.4);
    } else if (h < 0.57) {
      const a = h2 * 3, L = 26;
      g.save(); g.translate(x, y); g.rotate(a);
      blob(2, 5, L * 0.6, 6, 'rgba(0,0,0,0.25)');
      g.fillStyle = '#6b4428'; g.beginPath(); g.moveTo(-L / 2, -5); g.lineTo(L / 2, -5); g.lineTo(L / 2, 5); g.lineTo(-L / 2, 5); g.fill();
      line([-L / 2 + 3, -2, L / 2 - 6, -2], 'rgba(40,25,10,0.5)', 1); line([-L / 2 + 6, 2, L / 2 - 3, 2], 'rgba(40,25,10,0.5)', 1);
      blob(L / 2, 0, 3, 5, '#c8a070'); g.strokeStyle = '#8a5a30'; g.lineWidth = 0.8; g.beginPath(); g.ellipse(L / 2, 0, 1.6, 2.8, 0, 0, TAU); g.stroke();
      blob(-2, -4, 5, 2.2, 'rgba(100,170,70,0.8)');
      g.restore();
    } else if (h < 0.6) pebble(x, y, 2.5 + h2 * 2, '#7a7a6a');
  } else if (b === S.B.MOUNTAIN) {
    if (h < 0.26) pebble(x, y, 2 + h2 * 4, h2 > 0.5 ? '#8a847a' : '#7a746a');
    else if (h < 0.36) {
      const p = [x, y, x + 8, y + 5 * h2, x + 14, y - 2, x + 22, y + 3];
      line(p.map((v, i) => v + (i % 2 ? 1 : 0.5)), 'rgba(255,255,255,0.25)', 1.2);
      line(p, 'rgba(50,45,40,0.5)', 1.5);
      line([x + 8, y + 5 * h2, x + 10, y + 10], 'rgba(50,45,40,0.4)', 1);
    } else if (h < 0.42) {
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.moveTo(x - 9, y + 2); g.lineTo(x + 1, y - 5); g.lineTo(x + 13, y - 1); g.lineTo(x + 9, y + 7); g.lineTo(x - 5, y + 8); g.fill();
      g.fillStyle = '#a8a296'; g.beginPath(); g.moveTo(x - 10, y); g.lineTo(x, y - 7); g.lineTo(x + 12, y - 3); g.lineTo(x + 8, y + 5); g.lineTo(x - 6, y + 6); g.closePath(); g.fill();
      g.strokeStyle = '#6a645a'; g.lineWidth = 1.2; g.stroke();
      g.fillStyle = '#c8c2b6'; g.beginPath(); g.moveTo(x - 8, y - 0.5); g.lineTo(x, y - 6); g.lineTo(x + 10, y - 3); g.lineTo(x, y - 1); g.fill();
    } else if (h < 0.5) {
      for (let i = 0; i < 7; i++) blob(x + (S.hash2(i, x | 0, 15) - 0.5) * 14, y + (S.hash2(i, y | 0, 16) - 0.5) * 8, 1.4, 1.1, i % 2 ? '#6a645a' : '#b0aa9e');
    } else if (h < 0.56) blades(4, 8 + h2 * 4, '#9a9a5a', '#b8b070');
    else if (h < 0.6) {
      for (let i = 0; i < 4; i++) blob(x + (S.hash2(i, x | 0, 17) - 0.5) * 8, y + (S.hash2(i, y | 0, 18) - 0.5) * 6, 2, 1.7, i % 2 ? 'rgba(210,160,60,0.65)' : 'rgba(160,180,90,0.6)');
    }
  } else if (b === S.B.SNOW) {
    if (h < 0.09) {
      blob(x + 2, y + 3, 16 + h2 * 12, 5 + h2 * 3, 'rgba(150,180,210,0.3)');
      blob(x, y, 15 + h2 * 12, 4.5 + h2 * 3, 'rgba(255,255,255,0.9)');
    } else if (h < 0.3) {
      g.fillStyle = '#ffffff';
      g.beginPath(); g.moveTo(x, y - 3.5); g.lineTo(x + 0.8, y - 0.8); g.lineTo(x + 3.5, y); g.lineTo(x + 0.8, y + 0.8); g.lineTo(x, y + 3.5); g.lineTo(x - 0.8, y + 0.8); g.lineTo(x - 3.5, y); g.lineTo(x - 0.8, y - 0.8); g.fill();
    } else if (h < 0.42) {
      blob(x, y, 14 + h2 * 8, 7 + h2 * 4, 'rgba(170,215,240,0.45)', h2);
      line([x - 6, y - 2, x + 2, y - 4], 'rgba(255,255,255,0.85)', 1.3); line([x, y + 1, x + 5, y], 'rgba(255,255,255,0.7)', 1);
    } else if (h < 0.51) blades(3, 8, '#8aa0b0', '#b8c8d4');
    else if (h < 0.55) { pebble(x, y, 3.5, '#6a7480'); blob(x - 0.5, y - 1.5, 3, 1.5, '#ffffff'); }
    else if (h < 0.57) {
      for (let i = 0; i < 4; i++) {
        const fx = x + i * 9, fy = y + (i % 2 ? 4 : -4) + i * 2;
        blob(fx, fy, 2.4, 1.6, 'rgba(140,165,190,0.55)', 0.2);
      }
    }
  } else if (b === S.B.SWAMP) {
    if (h < 0.045) {
      const rx = 14 + h2 * 16, ry = 8 + h2 * 8;
      blob(x, y, rx + 3, ry + 2, 'rgba(70,60,35,0.45)', h2 * 3);
      blob(x, y, rx, ry, 'rgba(35,62,58,0.85)', h2 * 3);
      g.strokeStyle = 'rgba(200,230,210,0.25)'; g.lineWidth = 1; g.beginPath(); g.ellipse(x + 3, y + 1, rx * 0.45, ry * 0.4, h2 * 3, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.5; g.beginPath(); g.ellipse(x, y, rx * 0.75, ry * 0.65, h2 * 3, 3.6, 4.4); g.stroke();
    } else if (h < 0.12) {
      g.fillStyle = '#5f8f42'; g.beginPath(); g.arc(x, y, 5.5, 0.3, TAU - 0.3); g.lineTo(x, y); g.fill();
      g.strokeStyle = '#3f6a2c'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 4, y); g.moveTo(x, y); g.lineTo(x + 2, y - 4); g.stroke();
      if (h2 > 0.6) flower(x + 2, y - 1, '#ffb0d0', 0.6);
    } else if (h < 0.38) {
      for (let i = 0; i < 3; i++) {
        const rx = x + (i - 1) * 3.5, top = y - 12 - S.hash2(i, x | 0, 19) * 6;
        line([rx, y, rx + (i - 1) * 1.5, top], '#4a6a32', 1.5);
        if (i !== 1 || h2 > 0.4) { g.fillStyle = '#6a4222'; g.beginPath(); g.ellipse(rx + (i - 1) * 1.4, top + 3, 1.6, 3.5, 0, 0, TAU); g.fill(); }
      }
    } else if (h < 0.46) {
      for (let i = 0; i < 4; i++) blob(x + (S.hash2(i, x | 0, 20) - 0.5) * 16, y + (S.hash2(i, y | 0, 21) - 0.5) * 8, 4, 2.6, 'rgba(40,70,40,0.5)');
    } else if (h < 0.51) {
      g.strokeStyle = 'rgba(200,230,200,0.5)'; g.lineWidth = 0.8;
      for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(x + i * 4, y + (i % 2) * 3, 1.2 + i * 0.5, 0, TAU); g.stroke(); }
    } else if (h < 0.54) {
      line([x - 8, y, x - 2, y - 2, x + 3, y + 1, x + 9, y - 1], '#4a3a24', 2.2);
      line([x - 2, y - 2, x - 3, y - 7], '#4a3a24', 1.5);
    } else if (h < 0.6) blades(4, 10, '#3f5a30', '#5a7a44');
  } else if (b === S.B.VOLCANO) {
    if (h < 0.045) {
      const p = [x, y, x + 8, y + 6 * h2, x + 14, y - 2, x + 22, y + 4, x + 27, y + 1];
      line(p, 'rgba(255,90,20,0.25)', 6);
      line(p, 'rgba(255,120,40,0.85)', 2.2);
      line(p, 'rgba(255,230,140,0.9)', 0.8);
    } else if (h < 0.28) pebble(x, y, 1.5 + h2 * 3.5, '#2a1e1c');
    else if (h < 0.35) {
      g.fillStyle = '#1a1220'; g.beginPath(); g.moveTo(x - 4, y + 3); g.lineTo(x - 1, y - 8); g.lineTo(x + 5, y + 3); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(170,120,220,0.7)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x - 1, y - 8); g.lineTo(x - 3, y + 2); g.stroke();
      g.fillStyle = '#241828'; g.beginPath(); g.moveTo(x + 3, y + 3); g.lineTo(x + 7, y - 4); g.lineTo(x + 9, y + 3); g.fill();
    } else if (h < 0.4) {
      for (let i = 0; i < 3; i++) blob(x + i * 5, y + (i % 2) * 3, 1.3, 1.3, i ? '#ff8a2d' : '#ffd060');
    } else if (h < 0.45) {
      const gr = g.createRadialGradient(x, y, 0, x, y, 14 + h2 * 8);
      gr.addColorStop(0, 'rgba(10,5,5,0.45)'); gr.addColorStop(1, 'rgba(10,5,5,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, 14 + h2 * 8, 0, TAU); g.fill();
    } else if (h < 0.455) {
      line([x - 6, y - 2, x + 6, y + 2], '#d8ccb4', 2.2);
      for (const [ex, ey] of [[-6, -2], [6, 2]]) { blob(x + ex, y + ey - 1.2, 1.6, 1.6, '#e0d4bc'); blob(x + ex, y + ey + 1.2, 1.6, 1.6, '#e0d4bc'); }
    } else if (h < 0.52) {
      line([x, y, x + 7, y - 4, x + 13, y - 3], 'rgba(15,8,8,0.55)', 1.2);
      line([x + 7, y - 4, x + 8, y + 4, x + 5, y + 9], 'rgba(15,8,8,0.55)', 1.2);
      line([x, y, x - 5, y + 5], 'rgba(15,8,8,0.5)', 1);
    }
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
      AUDIO.play('gameover');
      showDeath();
      break;
    case 'feed': addFeed(m.m, m.big); if (m.big) AUDIO.play('horn'); break;
    case 'chat': addChat(m); AUDIO.play('chat'); break;
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
  for (const p of m.p) {
    projs.set(p[0], p);
    if (!seenProj.has(p[0])) { seenProj.add(p[0]); projSound(p); }
  }
  if (seenProj.size > 4000) seenProj.clear();
  snaps.push({ tm: m.tm, units, projs });
  while (snaps.length > 30) snaps.shift();

  // attack animations & hurt flashes
  for (const u of m.u) {
    const id = u[0];
    const a = u[1] === 'B' ? u[11] : u[8];
    // bosses fire constantly: only restart their attack pose once the previous one finished
    if (lastAtkN[id] !== undefined && a !== lastAtkN[id] && (u[1] !== 'B' || !atkAnim.has(id) || now - atkAnim.get(id) > 450)) {
      atkAnim.set(id, now);
      attackSound(u);
    }
    lastAtkN[id] = a;
    const prev = lastHp.get(id);
    if (prev !== undefined && u[6] < prev) {
      hurtFlash.set(id, now);
      if (id === myId && u[1] === 'h') lastHurtMe = now;
      if (u[2] === 'cow') AUDIO.at('moo', u[3], u[4], 0.7);
    } else if (u[2] === 'cow' && Math.random() < 0.0006) AUDIO.at('moo', u[3], u[4], 0.35);
    if ((u[1] === 'h' && u[7] === 2) || u[1] === 'B') {
      const d = Math.hypot(u[3] - cam.x, u[4] - cam.y);
      if (d < 700 && now - lastHurtMe < 3000) lastCombat = now;
    }
    lastHp.set(id, u[6]);
  }

  if (m.st) {
    statics = m.st.map((s) => s[1] === 'n'
      ? { id: s[0], k: 'n', type: s[2], x: s[3], y: s[4], r: s[5], hp: s[6], biome: s[7], v: s[8] }
      : { id: s[0], k: 'b', type: s[2], x: s[3], y: s[4], hs: S.BUILDINGS[s[2]].size / 2, lvl: s[5], hp: s[6], rel: s[7], pid: s[8], aim: s[9], faction: s[10] });
    staticById.clear();
    for (const s of statics) staticById.set(s.id, s);
  }
  const prevLvl = pf ? pf.lvl : m.pf.lvl, prevSub = pf ? pf.sub : m.pf.sub;
  pf = Object.assign(pf || {}, m.pf);
  if (pf.lvl > prevLvl) AUDIO.play('lvl');
  if (pf.sub && pf.sub !== prevSub && prevSub !== undefined) AUDIO.play('evolve');
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

const seenProj = new Set();
let lastHurtMe = -1e9;
const PROJ_SOUND = { web: 'thorn', snowball: 'heavy', iceboulder: 'heavy', shard: 'magic', arrow: 'arrow', tarrow: 'arrow', bolt_x: 'crossbow', bigbolt: 'bigbolt', dagger: 'dagger', fire: 'fire', magic: 'magic', thorn: 'thorn', holy: 'holyshot', rock: 'heavy' };
function projSound(p) { AUDIO.at(PROJ_SOUND[p[1]] || 'enemyshot', p[2], p[3], p[5] ? 0.8 : 0.5); }
function attackSound(u) {
  const x = u[3], y = u[4];
  if (u[1] === 'B') { if (Math.random() < 0.35) AUDIO.at('roar', x, y); return; }
  if (u[1] === 'h') {
    if (S.heroDef(u[2]).base === 'warrior') AUDIO.at(u[2] === 'berserker' || u[2] === 'cavalier' ? 'heavy' : 'swing', x, y);
    return;
  }
  if (u[2] === 'peasant') { AUDIO.at(u[0] % 3 ? 'stone' : 'chop', x, y, 0.35); return; }
  if (u[1] === 'm' || u[1] === 'k') AUDIO.at(u[2] === 'wolf' ? 'bite' : 'swing', x, y, 0.5);
}
function myType() { return pf ? pf.sub || pf.cls : 'warrior'; }
function myRadius() { return S.heroDef(myType()).r; }
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
  if (e.k === 'msg') { toast(e.m); AUDIO.play('error'); }
  else if (e.k === 'res') {
    if (e.v > 0) AUDIO.play('coin');
    if (e.v > 0) floatText(e.x, e.y, `+${e.v >= 10 ? Math.round(e.v) : e.v.toFixed(1)}`, e.r === 'gold' ? '#ffd76a' : e.r === 'wood' ? '#d7f59a' : e.r === 'food' ? '#ffb08a' : '#e4e4e4', 1.1, 16, e.r);
    else if (e.full) floatText(e.x, e.y, 'Склад полон!', '#ff9d7a', 1.2);
  }
}

// =================================================================== fx
const particles = [];
const texts = [];
const rings = [];
function floatText(x, y, s, color, life, size, icon) {
  texts.push({ x: x + (Math.random() - 0.5) * 16, y, s, color, t: 0, life: life || 0.9, size: size || 16, icon });
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
const FX_SOUND = { nova: 'nova', slam: 'slam', dash: 'dash', blink: 'blink', lvl: 'lvl', build: 'build', bossdeath: 'bossdie', strike: 'thunder', shield: 'bastion', rage: 'rage', whirl: 'whirl', howl: 'howl', roots: 'roots', holy: 'bless' };
function fxSound(f) {
  const [k, x, y, a, b] = f;
  if (FX_SOUND[k]) { AUDIO.at(FX_SOUND[k], x, y); return; }
  if (k === 'hit') AUDIO.at(['hit', 'chop', 'stone', 'gold', 'hit'][b] || 'hit', x, y, b === 4 ? 0.8 : 0.7);
  else if (k === 'death') AUDIO.at(a === 3 ? 'crumble' : a === 0 ? 'die' : a === 5 ? 'mobdie' : 'chop', x, y);
  else if (k === 'boom') AUDIO.at(b === 2 ? 'bless' : 'boom', x, y, b === 2 ? 0.4 : 0.7);
  else if (k === 'bolt') AUDIO.at('zap', a, b);
}
function spawnFx(f) {
  const [k, x, y, a, b] = f;
  fxSound(f);
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
      rings.push({ x, y, r0: 10, r1: a, t: 0, life: 0.35, c: b === 1 ? '#c08cff' : b === 2 ? '#fff0a8' : '#ff9a3d', fill: true });
      burst(x, y, 16, b === 1 ? ['#e2c8ff', '#9b5cff', '#ffffff'] : b === 2 ? ['#fff4b0', '#ffd84f', '#ffffff'] : ['#ffd070', '#ff7a2d', '#ffec9a', '#ff4a1a'], 260, 0.45, 6);
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
    case 'bolt': {
      const j = [];
      for (let i = 0; i < 8; i++) j.push(Math.round((Math.random() - 0.5) * 6));
      bolts.push({ x1: x, y1: y, x2: a, y2: b, j, t: 0, life: 0.22 });
      burst(a, b, 6, ['#e6faff', '#78e0ff'], 160, 0.3, 4);
      break;
    }
    case 'strike': {
      const j = [];
      for (let i = 0; i < 8; i++) j.push(Math.round((Math.random() - 0.5) * 5));
      bolts.push({ x1: x + (Math.random() - 0.5) * 60, y1: y - 420, x2: x, y2: y, j, t: 0, life: 0.3 });
      rings.push({ x, y, r0: 10, r1: a, t: 0, life: 0.3, c: '#78e0ff', fill: true });
      burst(x, y, 12, ['#e6faff', '#78e0ff', '#ffffff'], 220, 0.4, 5);
      break;
    }
    case 'shield': rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.45, c: '#ffd84f', fill: true }); burst(x, y, 20, ['#ffd84f', '#fff4b0'], 260, 0.5, 5); break;
    case 'rage': rings.push({ x, y, r0: 10, r1: 90, t: 0, life: 0.5, c: '#ff4a2a' }); burst(x, y, 24, ['#ff4a2a', '#ffa24a', '#ffffff'], 260, 0.5, 6); break;
    case 'whirl': rings.push({ x, y, r0: a * 0.6, r1: a, t: 0, life: 0.3, c: '#ffffff' }); break;
    case 'howl': rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.6, c: '#c2c8d0' }); rings.push({ x, y, r0: 10, r1: a * 0.7, t: -0.1, life: 0.6, c: '#c2c8d0' }); break;
    case 'roots': rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.6, c: '#66b84c', fill: true }); burst(x, y, 40, ['#66b84c', '#9ada74', '#9a6838'], 380, 0.6, 6); break;
    case 'holy': rings.push({ x, y, r0: 20, r1: a, t: 0, life: 0.6, c: '#fff0a8', fill: true }); burst(x, y, 40, ['#fff4b0', '#ffd84f', '#ffffff'], 380, 0.7, 5); break;
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
  // F1..F11 pick a building, 1..6 spend skill points (like diep.io)
  const fk = /^F(\d+)$/.exec(e.code);
  if (fk) {
    e.preventDefault();
    const i = +fk[1] - 1;
    if (i >= 0 && i < S.BUILD_ORDER.length) selectBuild(S.BUILD_ORDER[i]);
  }
  if (e.code.startsWith('Digit')) {
    const i = +e.code.slice(5) - 1;
    if (i >= 0 && i < S.STATS.length && pf && pf.pts > 0) { send({ t: 'stat', i }); AUDIO.play('click'); }
  }
  if (e.code === 'Escape') { buildMode = null; closeHelp(); renderBuildBar(); }
  if (e.code === 'KeyH') { e.preventDefault(); toggleHelp(); }
  if (e.code === 'KeyE' && hovered && hovered.k === 'b' && hovered.rel === 0) send({ t: 'up', id: hovered.id });
  if (e.code === 'KeyX' && hovered && hovered.k === 'b' && hovered.rel === 0 && hovered.type !== 'townhall') {
    if (demolishArm && performance.now() - demolishArm < 1500) { send({ t: 'del', id: hovered.id }); demolishArm = 0; }
    else { demolishArm = performance.now(); toast('Нажмите X ещё раз, чтобы снести'); }
  }
  if (e.code === 'KeyR') send({ t: 'recall' });
  if (e.code === 'KeyM') { AUDIO.toggle('musicOn'); renderAudioButtons(); }
  if (e.code === 'KeyN') { AUDIO.toggle('sfxOn'); renderAudioButtons(); }
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
  AUDIO.play('place');
  if (buildMode !== 'wall' && !keys.ShiftLeft && !keys.ShiftRight) { buildMode = null; renderBuildBar(); }
}

function selectBuild(type) {
  buildMode = buildMode === type ? null : type;
  AUDIO.play('click');
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
const REL_COLORS = ['#3d9df3', '#45c46a', '#e8514a', '#c9782e'];
const FACTION_COL = ['#6a9a3a', '#b0602a', '#9a2a24'];
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
// resource nodes are detailed, so each variant is painted once into a sprite and reused
const nodeCache = new Map();
function nodeSprite(s) {
  const rb = Math.max(20, Math.round(s.r / 4) * 4), vb = (s.v | 0) % 4;
  const key = s.type + s.biome + ':' + rb + ':' + vb;
  let c = nodeCache.get(key);
  if (c) return c;
  const ext = Math.ceil(rb * 1.75 + 12), SC = 1.6;
  c = document.createElement('canvas');
  c.width = c.height = Math.ceil(ext * 2 * SC);
  const real = ctx;
  ctx = c.getContext('2d');
  try { ctx.scale(SC, SC); ctx.translate(ext, ext); drawNodeShape(s.type, s.biome, rb, vb * 131 + 17); } finally { ctx = real; }
  c.ext = ext; c.SC = SC; c.rb = rb;
  nodeCache.set(key, c);
  if (nodeCache.size > 260) nodeCache.delete(nodeCache.keys().next().value);
  return c;
}
function drawNode(s, t) {
  const { x, y, r } = s;
  const c = nodeSprite(s);
  const k = r / c.rb;
  ctx.save();
  ctx.translate(x, y + r * 0.35);
  if (s.type === 'tree' && s.biome !== S.B.VOLCANO) ctx.transform(1, 0, Math.sin(t * 1.3 + s.v) * 0.035, 1, 0, 0);
  ctx.translate(0, -r * 0.35);
  ctx.scale(k / c.SC, k / c.SC);
  ctx.drawImage(c, -c.ext * c.SC, -c.ext * c.SC);
  ctx.restore();
  if (s.type === 'gold') {
    for (let i = 0; i < 2; i++) {
      const g = Math.max(0, Math.sin(t * 2.2 + s.v + i * 2.7));
      if (g < 0.2) continue;
      const a = s.v + i * 2.1, px = x + Math.cos(a) * r * 0.4, py = y + Math.sin(a) * r * 0.35 - 6;
      ctx.globalAlpha = g; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(px, py - 5 * g); ctx.lineTo(px + 1, py - 1); ctx.lineTo(px + 5 * g, py); ctx.lineTo(px + 1, py + 1); ctx.lineTo(px, py + 5 * g); ctx.lineTo(px - 1, py + 1); ctx.lineTo(px - 5 * g, py); ctx.lineTo(px - 1, py - 1); ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else if (s.type === 'tree' && s.biome === S.B.VOLCANO) {
    const e = (Math.sin(t * 3 + s.v) + 1) / 2;
    glow(x + Math.cos(s.v) * r * 0.9, y + Math.sin(s.v) * r * 0.9 - 6, 8, 'rgba(255,120,40,A)', 0.3 + e * 0.4);
  }
  if (s.hp < 100) hpBar(x, y + r + 8, 40, s.hp, '#e8c95a');
}
// facetted boulder lit from the upper left
function facetRock(x, y, r, v, base, outline) {
  const n = 9, pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + S.hash2(v, i, 3) * 0.4;
    const rr = r * (0.74 + S.hash2(v, i, 7) * 0.26);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.9, a]);
  }
  const cx = x - r * 0.14, cy = y - r * 0.2;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const lit = Math.cos((p[2] + q[2]) / 2 + 2.3);
    tri(cx, cy, p[0], p[1], q[0], q[1], lit > 0.35 ? lighter(base, 0.28) : lit < -0.35 ? darker(base, 0.7) : lit < 0 ? darker(base, 0.86) : base);
  }
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
  ctx.strokeStyle = outline; ctx.lineWidth = 2.5; ctx.stroke();
  // top plateau
  ctx.fillStyle = lighter(base, 0.18);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + v; const rr = r * (0.3 + S.hash2(v, i, 11) * 0.12); const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.85; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.2; ctx.stroke();
  return pts;
}
function drawNodeShape(type, b, r, v) {
  const x = 0, y = 0;
  const H = (i) => S.hash2(v, i, 91);
  if (type === 'tree') {
    shadow(x + r * 0.2, y + r * 0.35, r * 1.15, 0.3);
    if (b === S.B.SNOW) {
      ctx.fillStyle = '#5a3a22'; roundRect(x - 4, y + r * 0.2, 8, r * 0.45, 3); ctx.fill();
      const cols = ['#284f3a', '#2f5d45', '#3a6d52', '#467e5f'];
      for (let i = 0; i < 4; i++) {
        const rr = r * (1.28 - i * 0.26), yy = y - i * 6;
        ctx.beginPath();
        for (let k = 0; k < 22; k++) { const a = (k / 22) * TAU + i * 0.3; const q = k % 2 ? rr * 0.78 : rr; const px = x + Math.cos(a) * q, py = yy + Math.sin(a) * q; if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
        ctx.closePath(); ctx.fillStyle = cols[i]; ctx.fill(); ctx.strokeStyle = '#183526'; ctx.lineWidth = 1.8; ctx.stroke();
        // needles
        ctx.strokeStyle = 'rgba(15,40,25,0.45)'; ctx.lineWidth = 1;
        ctx.beginPath(); for (let k = 0; k < 11; k++) { const a = (k / 11) * TAU + i; ctx.moveTo(x + Math.cos(a) * rr * 0.35, yy + Math.sin(a) * rr * 0.35); ctx.lineTo(x + Math.cos(a) * rr * 0.8, yy + Math.sin(a) * rr * 0.8); } ctx.stroke();
        // snow on the lit side of every tier
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath(); ctx.ellipse(x - rr * 0.3, yy - rr * 0.35, rr * 0.42, rr * 0.2, -0.5, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(200,225,245,0.8)';
        ctx.beginPath(); ctx.ellipse(x - rr * 0.25, yy - rr * 0.28, rr * 0.36, rr * 0.08, -0.5, 0, Math.PI); ctx.fill();
      }
      circle(x - 1, y - 20, 4, '#ffffff');
    } else if (b === S.B.VOLCANO) {
      ctx.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + v;
        const ex = x + Math.cos(a) * r * 1.1, ey = y + Math.sin(a) * r * 1.1 - 6;
        ctx.strokeStyle = '#2a1a14'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.strokeStyle = '#4a3226'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 1, y - 2); ctx.lineTo(ex - 1, ey - 2); ctx.stroke();
        ctx.strokeStyle = '#2a1a14'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7 - 4);
        ctx.lineTo(x + Math.cos(a + 0.5) * r * 1.2, y + Math.sin(a + 0.5) * r * 1.2 - 6); ctx.stroke();
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + Math.cos(a - 0.6) * 8, ey + Math.sin(a - 0.6) * 8); ctx.stroke();
        circle(ex, ey, 2, i % 2 ? '#ff7a2a' : '#ffb04a');
      }
      ctx.lineCap = 'butt';
      circle(x, y, r * 0.38, '#3a261c', '#1a100c', 3);
      ctx.strokeStyle = 'rgba(120,80,50,0.6)'; ctx.lineWidth = 1;
      for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.arc(x, y, r * 0.09 * k, 0, TAU); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(255,110,40,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - r * 0.2, y + 2); ctx.lineTo(x + r * 0.05, y - r * 0.1); ctx.lineTo(x + r * 0.2, y + 4); ctx.stroke();
    } else {
      const swamp = b === S.B.SWAMP, forest = b === S.B.FOREST;
      const cols = swamp ? ['#34502a', '#3f5a32', '#4a6a3a', '#5f8250'] : forest ? ['#255a26', '#2e6b2e', '#3b8038', '#56a04c'] : ['#357a32', '#3f8a3a', '#4d9c44', '#6cba5c'];
      const out = swamp ? '#1f3019' : '#1a401b';
      // roots and trunk peeking out under the crown
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const a = Math.PI * 0.15 + (i / 3) * Math.PI * 0.7;
        ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x, y + r * 0.3); ctx.quadraticCurveTo(x + Math.cos(a) * r * 0.5, y + r * 0.35 + Math.sin(a) * r * 0.2, x + Math.cos(a) * r * 0.8, y + r * 0.35 + Math.sin(a) * r * 0.45); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.fillStyle = '#6b4428'; roundRect(x - r * 0.17, y, r * 0.34, r * 0.5, 4); ctx.fill();
      ctx.strokeStyle = 'rgba(40,20,10,0.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 2, y + 4); ctx.lineTo(x - 2, y + r * 0.45); ctx.moveTo(x + 3, y + 6); ctx.lineTo(x + 3, y + r * 0.42); ctx.stroke();
      // outer lobes shaded by the light direction
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + v * 0.1;
        const lit = Math.cos(a + 2.3);
        const lr = r * (0.48 + H(i) * 0.14);
        circle(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.58 - 6, lr, lit > 0.3 ? cols[2] : lit < -0.3 ? cols[0] : cols[1], out, 2.5);
      }
      circle(x, y - 6, r * 0.8, cols[1]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU + v * 0.2;
        const lit = Math.cos(a + 2.3);
        circle(x + Math.cos(a) * r * 0.36 - r * 0.08, y + Math.sin(a) * r * 0.34 - r * 0.12 - 6, r * 0.34, lit > 0 ? cols[2] : cols[1]);
      }
      circle(x - r * 0.25, y - r * 0.3 - 6, r * 0.3, cols[3]);
      // leaf texture: little dark crescents and bright specks
      ctx.strokeStyle = 'rgba(10,40,10,0.35)'; ctx.lineWidth = 1.3;
      for (let i = 0; i < 22; i++) {
        const a = H(20 + i) * TAU, d = Math.sqrt(H(50 + i)) * r * 0.95;
        const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.95 - 6;
        ctx.beginPath(); ctx.arc(px, py, 3, 0.2 + H(80 + i), 2 + H(80 + i)); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(230,255,190,0.4)';
      for (let i = 0; i < 12; i++) {
        const a = Math.PI * 1.1 + H(110 + i) * Math.PI * 0.8, d = H(130 + i) * r * 0.8;
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d - 6, 1.4, 0, TAU); ctx.fill();
      }
      if (!forest && !swamp && v % 3 === 1) {
        for (let i = 0; i < 6; i++) {
          const a = H(150 + i) * TAU, d = r * (0.3 + H(160 + i) * 0.55);
          circle(x + Math.cos(a) * d, y + Math.sin(a) * d - 6, 3.2, '#d8323a', '#7a1a1a', 1);
          circle(x + Math.cos(a) * d - 1, y + Math.sin(a) * d - 7, 1, '#ffd0d0');
        }
      }
      if (forest && v % 4 === 2) {
        circle(x + r * 0.35, y - r * 0.1, 6, '#8a5a30', '#4a2e18', 1.5);
        for (let i = 0; i < 3; i++) circle(x + r * 0.33 + i * 2.5 - 2.5, y - r * 0.12, 1.6, '#c8e0f0');
      }
      if (swamp) {
        ctx.strokeStyle = 'rgba(80,110,60,0.85)'; ctx.lineWidth = 1.8;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU + 0.2;
          const sx = x + Math.cos(a) * r * 0.95, sy = y + Math.sin(a) * r * 0.95 - 6;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(sx + 3, sy + 8, sx - 1, sy + 14 + H(200 + i) * 8); ctx.stroke();
        }
      }
    }
  } else if (type === 'rock') {
    shadow(x + r * 0.1, y + r * 0.1, r * 1.05, 0.3);
    const base = b === S.B.VOLCANO ? '#3a2e3a' : b === S.B.SNOW ? '#8d98a3' : b === S.B.SWAMP ? '#6f7466' : '#8f897e';
    // pebbles around the foot
    for (let i = 0; i < 4; i++) {
      const a = Math.PI * 0.2 + H(i) * Math.PI * 0.9;
      circle(x + Math.cos(a) * r * 1.05, y + Math.sin(a) * r * 0.9, 2.5 + H(10 + i) * 2.5, darker(base, 0.9), darker(base, 0.55), 1);
    }
    facetRock(x, y, r, v, base, darker(base, 0.5));
    // cracks with a bright lip
    for (let i = 0; i < 2; i++) {
      const a = H(30 + i) * TAU;
      const p = [x + Math.cos(a) * r * 0.15, y + Math.sin(a) * r * 0.15, x + Math.cos(a + 0.3) * r * 0.5, y + Math.sin(a + 0.3) * r * 0.5, x + Math.cos(a) * r * 0.78, y + Math.sin(a) * r * 0.7];
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p[0] + 1, p[1] + 1); ctx.lineTo(p[2] + 1, p[3] + 1); ctx.lineTo(p[4] + 1, p[5] + 1); ctx.stroke();
      ctx.strokeStyle = 'rgba(30,25,20,0.6)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]); ctx.lineTo(p[4], p[5]); ctx.stroke();
    }
    if (b === S.B.MEADOW || b === S.B.FOREST || b === S.B.SWAMP) {
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * 1.05 + H(40 + i) * 1.3, d = r * (0.3 + H(50 + i) * 0.5);
        circle(x + Math.cos(a) * d, y + Math.sin(a) * d, 3 + H(60 + i) * 4, i % 2 ? 'rgba(90,150,60,0.8)' : 'rgba(110,170,70,0.75)');
      }
    }
    if (b === S.B.SNOW) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; polyRand(x - r * 0.2, y - r * 0.32, r * 0.48, v + 2, 7, 0.3); ctx.fill();
      ctx.fillStyle = 'rgba(190,215,235,0.8)'; ctx.beginPath(); ctx.ellipse(x - r * 0.18, y - r * 0.12, r * 0.4, r * 0.08, 0, 0, Math.PI); ctx.fill();
    }
    if (b === S.B.VOLCANO) {
      glow(x, y, r * 0.6, 'rgba(255,90,30,A)', 0.25);
      ctx.strokeStyle = 'rgba(255,110,40,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - r * 0.45, y + r * 0.15); ctx.lineTo(x - r * 0.05, y + r * 0.35); ctx.lineTo(x + r * 0.35, y + r * 0.02); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,230,140,0.9)'; ctx.lineWidth = 0.8; ctx.stroke();
    }
  } else {
    shadow(x + r * 0.1, y + r * 0.1, r * 1.1, 0.3);
    facetRock(x, y, r, v, '#5e524a', '#2a221e');
    // gold veins
    for (let i = 0; i < 3; i++) {
      const a = H(i) * TAU;
      const p = [x + Math.cos(a) * r * 0.1, y + Math.sin(a) * r * 0.1, x + Math.cos(a + 0.4) * r * 0.45, y + Math.sin(a + 0.4) * r * 0.4, x + Math.cos(a + 0.1) * r * 0.8, y + Math.sin(a + 0.1) * r * 0.7];
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#b8861a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]); ctx.lineTo(p[4], p[5]); ctx.stroke();
      ctx.strokeStyle = '#ffe07a'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.lineCap = 'butt';
    }
    // crystal nuggets with facets
    for (let i = 0; i < 4; i++) {
      const a = v * 0.01 + i * 1.7, d = i ? r * 0.42 : 0;
      const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d * 0.9 - 4;
      const s = r * (i ? 0.2 : 0.3);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a * 0.3 - 0.4);
      tri(0, -s * 1.8, s, 0, 0, s, '#d9a520');
      tri(0, -s * 1.8, -s, 0, 0, s, '#ffe27a');
      tri(0, -s * 1.8, -s * 0.35, -s * 0.2, s * 0.35, -s * 0.2, '#fff4c0');
      ctx.beginPath(); ctx.moveTo(0, -s * 1.8); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0); ctx.closePath();
      ctx.strokeStyle = '#7a4a08'; ctx.lineWidth = 1.4; ctx.stroke();
      ctx.restore();
    }
    for (let i = 0; i < 6; i++) circle(x + (H(70 + i) - 0.5) * r * 1.4, y + (H(80 + i) - 0.5) * r * 1.2, 1.2, '#ffd34a');
  }
}

function teamFlag(x, y, rel, t, scale, colOverride) {
  const col = colOverride || REL_COLORS[rel];
  const sc = scale || 1;
  ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 3 * sc;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 34 * sc); ctx.stroke();
  const w = Math.sin(t * 5 + x) * 3 * sc;
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(x, y - 34 * sc); ctx.quadraticCurveTo(x + 12 * sc, y - 36 * sc + w, x + 24 * sc, y - 30 * sc + w);
  ctx.lineTo(x + 24 * sc, y - 22 * sc + w); ctx.quadraticCurveTo(x + 12 * sc, y - 24 * sc + w, x, y - 20 * sc); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = darker(col, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
}

function star(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
}


function lighter(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgb(${(r + (255 - r) * f) | 0},${(g + (255 - g) * f) | 0},${(b + (255 - b) * f) | 0})`;
}
function tri(ax, ay, bx, by, cx, cy, fill) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); }
// mortar lines of a stone surface, clipped to the current path
function brickLines(x, y, w, h, rowH, brickW, alpha) {
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = `rgba(40,30,20,${alpha || 0.18})`; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let yy = y + rowH, row = 0; yy < y + h; yy += rowH, row++) { ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); }
  for (let yy = y, row = 0; yy < y + h; yy += rowH, row++) {
    for (let xx = x + (row % 2) * brickW / 2; xx < x + w; xx += brickW) { ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + rowH); }
  }
  ctx.stroke();
  ctx.restore();
}
function glow(x, y, r, color, a) {
  const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, color.replace('A', a)); gr.addColorStop(1, color.replace('A', 0));
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
function torchFlame(x, y, t, s) {
  const f = Math.sin(t * 17 + s) * 1.5;
  glow(x, y, 16 + f, 'rgba(255,170,60,A)', 0.45);
  circle(x, y - 1, 3.5 + f * 0.3, '#ff8a2d');
  circle(x, y - 2, 1.8, '#ffe89a');
}
function smokeFrom(x, y, rate) {
  if (!iconMode && Math.random() < rate) particles.push({ x, y, vx: 8 + Math.random() * 8, vy: -28 - Math.random() * 12, t: 0, life: 1.8, c: 'rgba(210,205,195,0.55)', s: 9 + Math.random() * 5, smoke: true });
}
function pennant(x, y, col, t, len) {
  ctx.strokeStyle = '#4a3624'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - len); ctx.stroke();
  const w = Math.sin(t * 6 + x) * 2;
  tri(x, y - len, x + 13, y - len + 3 + w, x, y - len + 7, col);
}
function banner(x, y, h, col) {
  ctx.fillStyle = darker(col, 0.8); ctx.fillRect(x - 6, y, 12, h);
  ctx.fillStyle = col; ctx.fillRect(x - 5, y, 10, h - 3);
  tri(x - 5, y + h - 3, x + 5, y + h - 3, x, y + h + 3, col);
  ctx.fillStyle = '#ffd34a'; ctx.beginPath(); ctx.arc(x, y + h * 0.45, 2.5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#5a3820'; ctx.fillRect(x - 8, y - 2, 16, 3);
}
function woodPlanks(x, y, w, h, base, dir) {
  ctx.fillStyle = base; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(60,35,15,0.35)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (dir === 'v') for (let xx = x + 7; xx < x + w; xx += 7) { ctx.moveTo(xx, y); ctx.lineTo(xx, y + h); }
  else for (let yy = y + 7; yy < y + h; yy += 7) { ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); }
  ctx.stroke();
}
// top-down gable roof split by a horizontal ridge (upper slope lit, lower slope in shade)
function gableRoof(x, y, w, h, col) {
  roundRect(x, y, w, h, 4); ctx.fillStyle = darker(col, 0.55); ctx.fill();
  ctx.fillStyle = lighter(col, 0.25); ctx.fillRect(x + 3, y + 3, w - 6, h / 2 - 3);
  ctx.fillStyle = darker(col, 0.85); ctx.fillRect(x + 3, y + h / 2, w - 6, h / 2 - 3);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let yy = y + 8; yy < y + h - 3; yy += 6) { ctx.moveTo(x + 3, yy); ctx.lineTo(x + w - 3, yy); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.beginPath();
  for (let yy = y + 3, row = 0; yy < y + h - 3; yy += 6, row++) for (let xx = x + 3 + (row % 2) * 5; xx < x + w - 3; xx += 10) { ctx.moveTo(xx, yy); ctx.lineTo(xx, yy + 6); }
  ctx.stroke();
  ctx.fillStyle = lighter(col, 0.5); ctx.fillRect(x + 2, y + h / 2 - 1.5, w - 4, 3);
  roundRect(x, y, w, h, 4); ctx.strokeStyle = darker(col, 0.45); ctx.lineWidth = 3; ctx.stroke();
}
function coneRoof(x, y, r, col) {
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
    const lit = Math.cos((a0 + a1) / 2 + 2.3);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, a0, a1); ctx.closePath();
    ctx.fillStyle = lit > 0.3 ? lighter(col, 0.3) : lit < -0.3 ? darker(col, 0.72) : col;
    ctx.fill();
  }
  ctx.strokeStyle = darker(col, 0.5); ctx.lineWidth = 1.2;
  for (let i = 0; i < segs; i++) { const a = (i / segs) * TAU; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke(); }
  circle(x, y, r, null, darker(col, 0.45), 2.5);
  circle(x, y, 2.5, '#ffd34a');
}
function merlonRing(x, y, r, n, col) {
  ctx.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    ctx.save(); ctx.translate(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.rotate(a);
    ctx.fillRect(-3.5, -4, 7, 8); ctx.restore();
  }
}
function litWindow(x, y, w, h) {
  ctx.fillStyle = '#3a2a1c'; ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
  ctx.fillStyle = '#ffd86a'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#fff2b8'; ctx.fillRect(x, y, w, h * 0.35);
  ctx.fillStyle = '#6b4428'; ctx.fillRect(x + w / 2 - 0.75, y, 1.5, h);
}

// upgrades show on the building: supplies at level 2, gilded corners at 3, a rune circle at 4+
function levelDressing(s, t) {
  const { x, y, hs, lvl } = s;
  if (lvl >= 2) {
    const bx = x - hs - 4, by = y + hs - 6;
    for (const [dx, dy] of [[0, 0], [9, 4]]) {
      circle(bx + dx + 1.5, by + dy + 2, 6, 'rgba(0,0,0,0.25)');
      circle(bx + dx, by + dy, 6, '#9a6a3a', '#4a2e18', 1.5);
      ctx.strokeStyle = '#5a5e66'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(bx + dx, by + dy, 4, 0, TAU); ctx.stroke();
      circle(bx + dx - 1.5, by + dy - 1.5, 1.5, 'rgba(255,230,190,0.5)');
    }
    ctx.fillStyle = '#b8864a'; ctx.fillRect(bx - 4, by - 16, 11, 10);
    ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 1.2; ctx.strokeRect(bx - 4, by - 16, 11, 10);
    ctx.beginPath(); ctx.moveTo(bx - 4, by - 16); ctx.lineTo(bx + 7, by - 6); ctx.moveTo(bx + 7, by - 16); ctx.lineTo(bx - 4, by - 6); ctx.stroke();
  }
  if (lvl >= 3) {
    const g = (Math.sin(t * 2 + x) + 1) / 2;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const cx = x + dx * (hs - 3), cy = y + dy * (hs - 3);
      circle(cx, cy, 4.5, '#ffd34a', '#8a5a10', 1.5);
      circle(cx - 1, cy - 1, 1.5, '#fff4c0');
    }
    ctx.globalAlpha = 0.25 + g * 0.35; circle(x - hs + 2, y - hs + 2, 2, '#ffffff'); ctx.globalAlpha = 1;
  }
  if (lvl >= 4) {
    const R = hs + 12, rot = t * 0.25;
    ctx.strokeStyle = `rgba(255,215,110,${0.28 + Math.sin(t * 2) * 0.08})`; ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 8]); ctx.lineDashOffset = -t * 10;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,225,140,0.55)';
    for (let i = 0; i < 6; i++) { const a = rot + (i / 6) * TAU; ctx.save(); ctx.translate(x + Math.cos(a) * R, y + Math.sin(a) * R); ctx.rotate(a); ctx.fillRect(-2, -4, 4, 8); ctx.restore(); }
  }
  if (lvl >= 5 && Math.random() < 0.08) particles.push({ x: x + (Math.random() - 0.5) * hs * 2, y: y + (Math.random() - 0.5) * hs * 2, vx: 0, vy: -25, t: 0, life: 0.9, c: '#ffe07a', s: 2.5 });
}

function drawBuilding(s, t) {
  const { x, y, hs } = s;
  const A0 = ctx.globalAlpha;
  const col = s.rel === 3 && s.faction >= 0 ? FACTION_COL[s.faction] : REL_COLORS[s.rel];
  const dcol = darker(col, 0.6);
  const stone = '#a39a88', stoneD = '#5e564b', stoneL = '#c4bba9';
  ctx.globalAlpha = A0 * 0.28; ctx.fillStyle = '#000';
  roundRect(x - hs + 7, y - hs + 11, hs * 2, hs * 2, 10); ctx.fill();
  ctx.globalAlpha = A0;
  switch (s.type) {
    case 'townhall': {
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 12); ctx.fillStyle = stone; ctx.fill();
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 12); brickLines(x - hs, y - hs, hs * 2, hs * 2, 12, 24, 0.16);
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 12); ctx.strokeStyle = stoneD; ctx.lineWidth = 4; ctx.stroke();
      // courtyard with cobbles
      roundRect(x - hs + 16, y - hs + 16, hs * 2 - 32, hs * 2 - 32, 8); ctx.fillStyle = '#c7b99a'; ctx.fill();
      ctx.fillStyle = 'rgba(120,100,70,0.25)';
      for (let i = 0; i < 26; i++) { const px = x - hs + 22 + S.hash2(i, 1, 9) * (hs * 2 - 44), py = y - hs + 22 + S.hash2(i, 2, 9) * (hs * 2 - 44); ctx.beginPath(); ctx.ellipse(px, py, 4, 3, 0, 0, TAU); ctx.fill(); }
      // walkway highlight
      ctx.strokeStyle = stoneL; ctx.lineWidth = 2; roundRect(x - hs + 8, y - hs + 8, hs * 2 - 16, hs * 2 - 16, 8); ctx.stroke();
      // keep with a pyramid roof
      const kx = x, ky = y - 8, kh = 34;
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(kx - kh + 5, ky - kh + 7, kh * 2, kh * 2);
      ctx.fillStyle = '#b3a891'; ctx.fillRect(kx - kh, ky - kh, kh * 2, kh * 2);
      tri(kx - kh, ky - kh, kx + kh, ky - kh, kx, ky, lighter(col, 0.35));
      tri(kx - kh, ky - kh, kx - kh, ky + kh, kx, ky, col);
      tri(kx + kh, ky - kh, kx + kh, ky + kh, kx, ky, darker(col, 0.72));
      tri(kx - kh, ky + kh, kx + kh, ky + kh, kx, ky, darker(col, 0.85));
      ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 1.2;
      for (let k = 6; k < kh; k += 6) { ctx.strokeRect(kx - k, ky - k, k * 2, k * 2); }
      ctx.strokeStyle = dcol; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(kx - kh, ky - kh); ctx.lineTo(kx + kh, ky + kh); ctx.moveTo(kx + kh, ky - kh); ctx.lineTo(kx - kh, ky + kh); ctx.stroke();
      ctx.strokeStyle = dcol; ctx.lineWidth = 3; ctx.strokeRect(kx - kh, ky - kh, kh * 2, kh * 2);
      litWindow(kx - 16, ky + kh - 12, 6, 7); litWindow(kx + 10, ky + kh - 12, 6, 7);
      // corner towers with cone roofs
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const tx = x + dx * (hs - 8), ty = y + dy * (hs - 8);
        circle(tx, ty, 23, stoneL, stoneD, 3);
        merlonRing(tx, ty, 19, 10, '#8a8170');
        coneRoof(tx, ty, 14, col);
      }
      // gate, banners, torches
      const gy = y + hs - 4;
      ctx.fillStyle = '#6b6252'; ctx.fillRect(x - 21, gy - 20, 42, 22);
      ctx.fillStyle = '#3a2a1c'; ctx.beginPath(); ctx.moveTo(x - 15, gy + 2); ctx.lineTo(x - 15, gy - 10); ctx.arc(x, gy - 10, 15, Math.PI, 0); ctx.lineTo(x + 15, gy + 2); ctx.fill();
      woodPlanks(x - 12, gy - 14, 24, 16, '#8a5a30', 'v');
      ctx.fillStyle = '#3b3444'; ctx.fillRect(x - 12, gy - 9, 24, 2); ctx.fillRect(x - 12, gy - 3, 24, 2);
      banner(x - 34, y + hs - 26, 20, col); banner(x + 34, y + hs - 26, 20, col);
      torchFlame(x - 24, gy - 16, t, 1); torchFlame(x + 24, gy - 16, t, 2);
      teamFlag(kx, ky, s.rel, t, 1.4);
      break;
    }
    case 'wall': {
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 4); ctx.fillStyle = '#9c9282'; ctx.fill();
      ctx.fillStyle = '#bdb4a3'; ctx.fillRect(x - hs + 2, y - hs + 2, hs * 2 - 4, 5); ctx.fillRect(x - hs + 2, y - hs + 2, 5, hs * 2 - 4);
      ctx.fillStyle = '#7d7466'; ctx.fillRect(x - hs + 2, y + hs - 7, hs * 2 - 4, 5); ctx.fillRect(x + hs - 7, y - hs + 2, 5, hs * 2 - 4);
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 4); brickLines(x - hs, y - hs, hs * 2, hs * 2, 11, 22, 0.22);
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 4); ctx.strokeStyle = stoneD; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = col; ctx.globalAlpha = A0 * 0.8; ctx.fillRect(x - hs + 3, y - hs + 3, hs * 2 - 6, 4); ctx.globalAlpha = A0;
      if (S.hash2(x | 0, y | 0, 3) < 0.4) { ctx.fillStyle = 'rgba(110,150,70,0.7)'; ctx.beginPath(); ctx.arc(x - hs + 8 + S.hash2(x | 0, y | 0, 4) * 26, y + hs - 9, 4, 0, TAU); ctx.fill(); }
      break;
    }
    case 'tower': {
      circle(x, y, hs, stone, stoneD, 4);
      ctx.beginPath(); ctx.arc(x, y, hs - 2, 0, TAU); brickLines(x - hs, y - hs, hs * 2, hs * 2, 10, 18, 0.14);
      merlonRing(x, y, hs - 5, 12, '#7a7264');
      // wooden fighting floor
      ctx.beginPath(); ctx.arc(x, y, hs * 0.62, 0, TAU); ctx.save(); ctx.clip(); woodPlanks(x - hs, y - hs, hs * 2, hs * 2, '#a8764a'); ctx.restore();
      circle(x, y, hs * 0.62, null, '#5a3820', 2.5);
      // archer turning towards targets
      const a = s.aim || 0;
      circle(x, y, 10, col, dcol, 2.5);
      circle(x + Math.cos(a) * 3, y + Math.sin(a) * 3, 5.5, '#f2c79a', '#8a5a30', 1.5);
      ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * 8, y + Math.sin(a) * 8, 12, a - 1.1, a + 1.1); ctx.stroke();
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 8 + Math.cos(a - 1.1) * 12, y + Math.sin(a) * 8 + Math.sin(a - 1.1) * 12); ctx.lineTo(x + Math.cos(a + 1.1) * 12 + Math.cos(a) * 8, y + Math.sin(a + 1.1) * 12 + Math.sin(a) * 8); ctx.stroke();
      banner(x, y + hs - 8, 14, col);
      break;
    }
    case 'magetower': {
      circle(x, y, hs, '#8e86a0', '#4a4058', 4);
      ctx.beginPath(); ctx.arc(x, y, hs - 2, 0, TAU); brickLines(x - hs, y - hs, hs * 2, hs * 2, 10, 18, 0.16);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + 0.3;
        const cx = x + Math.cos(a) * (hs - 3), cy = y + Math.sin(a) * (hs - 3);
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(a + Math.PI / 2);
        tri(-4, 0, 4, 0, 0, -11, i % 2 ? '#78e0ff' : '#c8a0ff');
        ctx.restore();
      }
      circle(x, y, hs * 0.7, '#5e3a8e', '#3a2260', 3);
      ctx.save(); ctx.setLineDash([6, 5]); ctx.lineDashOffset = -t * 18;
      circle(x, y, hs * 0.55, null, 'rgba(200,160,255,0.85)', 2); ctx.restore();
      circle(x, y + 2, 8, dcol);
      const bob = Math.sin(t * 3 + x) * 3;
      glow(x, y - 10 + bob, 30, 'rgba(160,110,255,A)', 0.7);
      circle(x, y - 10 + bob, 8, '#c8a0ff', '#6b3fa0', 2);
      circle(x - 2, y - 12 + bob, 3, '#ffffff');
      for (let i = 0; i < 3; i++) { const a = t * 2.5 + (i / 3) * TAU; circle(x + Math.cos(a) * 16, y - 10 + bob + Math.sin(a) * 7, 2.2, '#e8d8ff'); }
      break;
    }
    case 'sawmill': {
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.save(); ctx.clip(); woodPlanks(x - hs, y - hs, hs * 2, hs * 2, '#b08a5a', 'v'); ctx.restore();
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.strokeStyle = '#5a3a1a'; ctx.lineWidth = 3; ctx.stroke();
      gableRoof(x - hs + 4, y - hs + 4, hs * 1.2, hs * 1.35, '#b0523a');
      ctx.fillStyle = '#8a8170'; ctx.fillRect(x - hs + hs * 0.8, y - hs + 10, 10, 10); ctx.strokeStyle = '#4a4238'; ctx.lineWidth = 2; ctx.strokeRect(x - hs + hs * 0.8, y - hs + 10, 10, 10);
      smokeFrom(x - hs + hs * 0.8 + 5, y - hs + 10, 0.05);
      // log pile
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const lx = x - hs + 12 + i * 12, ly = y + hs - 14 - j * 10; circle(lx, ly, 6, '#c89060', '#6a4220', 1.5); circle(lx, ly, 2.5, null, '#8a5a30', 1); }
      // spinning saw blade
      ctx.save(); ctx.translate(x + hs - 17, y + 4); ctx.rotate(t * 6);
      circle(0, 0, 13, '#dfe5ec', '#6a7078', 2);
      ctx.fillStyle = '#6a7078';
      for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; tri(Math.cos(a) * 13, Math.sin(a) * 13, Math.cos(a + 0.35) * 17, Math.sin(a + 0.35) * 17, Math.cos(a + 0.45) * 12, Math.sin(a + 0.45) * 12, '#6a7078'); }
      circle(0, 0, 4, '#8a94a0'); ctx.restore();
      if (!iconMode && Math.random() < 0.15) particles.push({ x: x + hs - 17 + (Math.random() - 0.5) * 8, y: y + 16, vx: (Math.random() - 0.5) * 60, vy: 30 + Math.random() * 30, t: 0, life: 0.4, c: '#e8c890', s: 3 });
      teamFlag(x + hs - 8, y - hs + 26, s.rel, t, 0.8);
      break;
    }
    case 'quarry': {
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 14); ctx.fillStyle = '#8f887b'; ctx.fill();
      ctx.strokeStyle = stoneD; ctx.lineWidth = 3; ctx.stroke();
      const shades = ['#7c7568', '#6a6356', '#575146', '#474238'];
      shades.forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(x - 2, y + 2 + i * 2, hs * 0.78 - i * 7, hs * 0.6 - i * 6, 0, 0, TAU); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1.5; ctx.stroke(); });
      for (const [dx, dy] of [[-20, -8], [-10, 10], [14, -12], [18, 8]]) {
        ctx.fillStyle = '#6e675c'; ctx.fillRect(x + dx - 6 + 3, y + dy - 5 + 3, 12, 10);
        ctx.fillStyle = '#b8b0a2'; ctx.fillRect(x + dx - 6, y + dy - 5, 12, 10);
        ctx.fillStyle = '#d6cfc2'; ctx.fillRect(x + dx - 6, y + dy - 5, 12, 3);
        ctx.strokeStyle = '#4a4238'; ctx.lineWidth = 1.5; ctx.strokeRect(x + dx - 6, y + dy - 5, 12, 10);
      }
      // crane swinging a block
      const bx = x - hs + 12, by = y - hs + 12;
      ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(bx - 6, by + 8); ctx.lineTo(bx, by); ctx.lineTo(bx + 6, by + 8); ctx.stroke();
      const ang = 0.6 + Math.sin(t * 0.8) * 0.5;
      const ex = bx + Math.cos(ang) * 40, ey = by + Math.sin(ang) * 40;
      ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = '#d8cfae'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex, ey + 12); ctx.stroke();
      ctx.fillStyle = '#b8b0a2'; ctx.fillRect(ex - 5, ey + 12, 10, 8); ctx.strokeStyle = '#4a4238'; ctx.strokeRect(ex - 5, ey + 12, 10, 8);
      teamFlag(x + hs - 10, y + hs - 8, s.rel, t, 0.8);
      break;
    }
    case 'farmhouse': {
      // yard
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.fillStyle = '#b89a6a'; ctx.fill();
      ctx.fillStyle = 'rgba(110,80,40,0.25)';
      for (let i = 0; i < 16; i++) { ctx.beginPath(); ctx.ellipse(x - hs + 6 + S.hash2(i, 5, 21) * (hs * 2 - 12), y - hs + 6 + S.hash2(i, 6, 21) * (hs * 2 - 12), 2.5, 1.6, 0, 0, TAU); ctx.fill(); }
      // vegetable garden with cabbages & carrots
      const gx = x - hs + 5, gy = y + 4, gw = hs - 4, gh = hs - 9;
      ctx.fillStyle = '#6a4a2a'; ctx.fillRect(gx, gy, gw, gh);
      ctx.strokeStyle = 'rgba(40,25,10,0.5)'; ctx.lineWidth = 1;
      for (let r = 0; r < 3; r++) { ctx.beginPath(); ctx.moveTo(gx + 2, gy + 5 + r * 8); ctx.lineTo(gx + gw - 2, gy + 5 + r * 8); ctx.stroke(); }
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
        const px = gx + 5 + c * ((gw - 8) / 3), py = gy + 5 + r * 8;
        if (r === 1) { tri(px - 2, py, px + 2, py, px, py + 5, '#e8842a'); ctx.fillStyle = '#5aa040'; ctx.fillRect(px - 1.5, py - 4, 3, 4); }
        else { circle(px, py, 3.4, '#7ac258', '#3e7a30', 1); circle(px - 0.8, py - 0.8, 1.4, '#b0e090'); }
      }
      // fence around the garden
      ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 2; ctx.strokeRect(gx - 1, gy - 1, gw + 2, gh + 2);
      ctx.fillStyle = '#6a4220'; for (let i = 0; i <= 4; i++) { ctx.fillRect(gx - 2 + i * (gw / 4), gy - 3, 3, 4); ctx.fillRect(gx - 2 + i * (gw / 4), gy + gh - 1, 3, 4); }
      // haystack
      const hx = x + hs * 0.55, hy = y + hs * 0.5;
      circle(hx + 2, hy + 3, 11, 'rgba(0,0,0,0.2)');
      circle(hx, hy, 11, '#e0bf52', '#9a7a22', 2);
      ctx.strokeStyle = 'rgba(140,100,30,0.6)'; ctx.lineWidth = 1;
      for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU; ctx.beginPath(); ctx.moveTo(hx + Math.cos(a) * 3, hy + Math.sin(a) * 3); ctx.lineTo(hx + Math.cos(a + 0.3) * 10, hy + Math.sin(a + 0.3) * 10); ctx.stroke(); }
      circle(hx - 3, hy - 3, 4, '#f0d880');
      if (s.lvl >= 2) {
        // cart with sacks
        ctx.fillStyle = '#7a4e2a'; ctx.fillRect(x + 6, y + hs - 12, 16, 9);
        ctx.strokeStyle = '#3a2418'; ctx.lineWidth = 1.2; ctx.strokeRect(x + 6, y + hs - 12, 16, 9);
        circle(x + 8, y + hs - 2, 3.2, '#5a3a22', '#2a1a10', 1); circle(x + 20, y + hs - 2, 3.2, '#5a3a22', '#2a1a10', 1);
        circle(x + 11, y + hs - 9, 3.2, '#d8c49a', '#7a6040', 1); circle(x + 17, y + hs - 8, 3.2, '#d8c49a', '#7a6040', 1);
      }
      // cottage: stone footing, timber walls, thatched roof
      const cx = x + 4, cy = y - hs * 0.35, cw = hs * 1.35, ch = hs * 0.95;
      roundRect(cx - cw / 2 - 2, cy - ch / 2 - 2, cw + 4, ch + 4, 4); ctx.fillStyle = '#8a8274'; ctx.fill();
      woodPlanks(cx - cw / 2, cy - ch / 2, cw, ch, '#c89a62', 'v');
      ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 2.5; ctx.strokeRect(cx - cw / 2, cy - ch / 2, cw, ch);
      // thatch
      const tx = cx - cw / 2 - 5, ty = cy - ch / 2 - 6, tw = cw + 10, th = ch * 0.9;
      roundRect(tx, ty, tw, th, 6); ctx.fillStyle = '#b8902e'; ctx.fill();
      ctx.fillStyle = '#e0bc50'; ctx.fillRect(tx + 3, ty + 3, tw - 6, th / 2 - 3);
      ctx.fillStyle = '#c8a038'; ctx.fillRect(tx + 3, ty + th / 2, tw - 6, th / 2 - 3);
      ctx.strokeStyle = 'rgba(110,80,20,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 26; i++) { const px = tx + 4 + (i / 25) * (tw - 8); ctx.moveTo(px, ty + 4); ctx.lineTo(px + 2, ty + th / 2 - 1); ctx.moveTo(px, ty + th / 2 + 2); ctx.lineTo(px - 2, ty + th - 4); }
      ctx.stroke();
      ctx.strokeStyle = '#8a6a1a'; ctx.lineWidth = 1.5;
      for (const k of [0.3, 0.75]) { ctx.beginPath(); ctx.moveTo(tx + 3, ty + th * k); ctx.lineTo(tx + tw - 3, ty + th * k); ctx.stroke(); }
      ctx.fillStyle = '#8a6a1a'; ctx.fillRect(tx + 2, ty + th / 2 - 2, tw - 4, 4);
      roundRect(tx, ty, tw, th, 6); ctx.strokeStyle = '#6a4e14'; ctx.lineWidth = 2.5; ctx.stroke();
      // chimney with smoke
      const chx = tx + tw - 13, chy = ty + 4;
      ctx.fillStyle = '#8a8274'; ctx.fillRect(chx, chy, 9, 9); ctx.strokeStyle = '#4a4238'; ctx.lineWidth = 1.5; ctx.strokeRect(chx, chy, 9, 9);
      ctx.fillStyle = '#2a2220'; ctx.fillRect(chx + 2, chy + 2, 5, 5);
      smokeFrom(chx + 4.5, chy, 0.05);
      // door, window with flower box, lantern
      const dy = cy + ch / 2;
      ctx.fillStyle = '#5a3820'; roundRect(cx - 6, dy - 4, 12, 9, 2); ctx.fill();
      ctx.fillStyle = '#e8c860'; circle(cx + 3, dy, 1, '#e8c860');
      litWindow(cx - cw / 2 + 5, dy - 3, 7, 5);
      for (let i = 0; i < 3; i++) circle(cx - cw / 2 + 6 + i * 3, dy + 4, 1.6, ['#ff7a9a', '#ffd34a', '#ff7a9a'][i]);
      torchFlame(cx + 11, dy - 1, t, 7);
      // well
      if (s.lvl >= 3) {
        const wx = x + hs - 12, wy = y - 6;
        circle(wx, wy, 8, '#a39a88', '#5e564b', 2); circle(wx, wy, 5, '#2a4a6a'); circle(wx - 1.5, wy - 1.5, 1.4, 'rgba(255,255,255,0.6)');
        ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(wx - 9, wy); ctx.lineTo(wx + 9, wy); ctx.stroke();
      }
      teamFlag(x - hs + 10, y - hs + 10, s.rel, t, 0.8);
      break;
    }
    case 'mine': {
      const gr = ctx.createRadialGradient(x - 10, y - 12, 4, x, y, hs * 1.1);
      gr.addColorStop(0, '#a08e78'); gr.addColorStop(1, '#5e5246');
      ctx.fillStyle = gr; polyRand(x, y, hs, 31, 11, 0.12); ctx.fill();
      ctx.strokeStyle = '#3e352c'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#6fae4a'; polyRand(x - 4, y - 12, hs * 0.62, 32, 9, 0.25); ctx.fill();
      ctx.fillStyle = '#8acd5e'; polyRand(x - 8, y - 16, hs * 0.32, 33, 7, 0.3); ctx.fill();
      // entrance
      ctx.fillStyle = '#1b1510'; ctx.beginPath(); ctx.moveTo(x - 13, y + hs - 4); ctx.lineTo(x - 13, y + 8); ctx.arc(x, y + 8, 13, Math.PI, 0); ctx.lineTo(x + 13, y + hs - 4); ctx.fill();
      ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(x - 15, y + hs - 2); ctx.lineTo(x - 15, y + 2); ctx.lineTo(x + 15, y + 2); ctx.lineTo(x + 15, y + hs - 2); ctx.stroke();
      torchFlame(x, y - 3, t, 5);
      // rails and a gold cart
      ctx.strokeStyle = '#6a6e78'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 6, y + hs - 4); ctx.lineTo(x - 6, y + hs + 6); ctx.moveTo(x + 6, y + hs - 4); ctx.lineTo(x + 6, y + hs + 6); ctx.stroke();
      ctx.fillStyle = '#6b4428'; ctx.fillRect(x + 14, y + hs - 22, 20, 14); ctx.strokeStyle = '#3a2418'; ctx.lineWidth = 2; ctx.strokeRect(x + 14, y + hs - 22, 20, 14);
      for (let i = 0; i < 4; i++) circle(x + 18 + i * 4, y + hs - 22 + (i % 2) * 2, 3, '#ffd34a', '#a87a10', 1);
      if (Math.sin(t * 3 + x) > 0.8) circle(x + 22, y + hs - 25, 1.8, '#ffffff');
      teamFlag(x - 8, y - hs + 18, s.rel, t, 0.8);
      break;
    }
    case 'barracks': {
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.fillStyle = '#8a7a64'; ctx.fill();
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); brickLines(x - hs, y - hs, hs * 2, hs * 2, 10, 20, 0.14);
      roundRect(x - hs, y - hs, hs * 2, hs * 2, 8); ctx.strokeStyle = '#4a3f32'; ctx.lineWidth = 3; ctx.stroke();
      gableRoof(x - hs + 6, y - hs + 6, hs * 2 - 12, hs * 1.3, col);
      // crossed swords emblem on the roof
      ctx.strokeStyle = '#e6e9ee'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x - 10, y - hs + 14); ctx.lineTo(x + 10, y - hs + 34); ctx.moveTo(x + 10, y - hs + 14); ctx.lineTo(x - 10, y - hs + 34); ctx.stroke();
      ctx.fillStyle = '#c9a040'; ctx.fillRect(x - 12, y - hs + 30, 5, 3); ctx.fillRect(x + 7, y - hs + 30, 5, 3);
      // door, training dummy, spear rack
      ctx.fillStyle = '#5a3820'; ctx.fillRect(x - 8, y + hs * 0.3 - 1, 16, 12);
      torchFlame(x - 14, y + hs * 0.3 + 3, t, 3); torchFlame(x + 14, y + hs * 0.3 + 3, t, 4);
      ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - hs + 14, y + hs - 6); ctx.lineTo(x - hs + 14, y + hs - 22); ctx.stroke();
      circle(x - hs + 14, y + hs - 22, 7, '#d8b86a', '#8a6a2a', 2); circle(x - hs + 14, y + hs - 22, 3, null, '#c0392b', 1.5);
      for (let i = 0; i < 3; i++) { ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + hs - 22 + i * 6, y + hs - 4); ctx.lineTo(x + hs - 22 + i * 6, y + hs - 24); ctx.stroke(); tri(x + hs - 25 + i * 6, y + hs - 24, x + hs - 19 + i * 6, y + hs - 24, x + hs - 22 + i * 6, y + hs - 30, '#c8d0d8'); }
      break;
    }
    case 'shrine': {
      const pulse = (Math.sin(t * 2.5) + 1) / 2;
      if (!iconMode) { ctx.globalAlpha = A0 * (0.05 + pulse * 0.05); circle(x, y, S.BUILDINGS.shrine.range, s.rel <= 1 ? '#7dffb0' : '#ff9a9a'); ctx.globalAlpha = A0; }
      circle(x, y, hs, '#c4bcaa', '#8a8374', 3);
      circle(x, y, hs - 6, '#ece6d8', '#b0a898', 2);
      ctx.save(); ctx.setLineDash([4, 6]); ctx.lineDashOffset = t * 12;
      circle(x, y, hs - 12, null, `rgba(60,210,120,${0.5 + pulse * 0.5})`, 2.5); ctx.restore();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + Math.PI / 6;
        const px = x + Math.cos(a) * (hs - 5), py = y + Math.sin(a) * (hs - 5);
        circle(px + 2, py + 3, 5, 'rgba(0,0,0,0.2)');
        circle(px, py, 5, '#ffffff', '#b0a898', 1.5);
        circle(px, py, 2, '#e0b44a');
      }
      const bob = Math.sin(t * 2) * 2;
      glow(x, y - 4 + bob, 26, 'rgba(120,255,170,A)', 0.55);
      ctx.beginPath(); ctx.moveTo(x, y - 18 + bob); ctx.lineTo(x + 8, y - 4 + bob); ctx.lineTo(x, y + 10 + bob); ctx.lineTo(x - 8, y - 4 + bob); ctx.closePath();
      const cg = ctx.createLinearGradient(x - 8, y - 18, x + 8, y + 10); cg.addColorStop(0, '#d8ffe6'); cg.addColorStop(1, '#2ecf72');
      ctx.fillStyle = cg; ctx.fill(); ctx.strokeStyle = '#1f8a4a'; ctx.lineWidth = 2; ctx.stroke();
      circle(x - 2, y - 8 + bob, 1.8, '#ffffff');
      teamFlag(x + hs - 6, y + hs - 4, s.rel, t, 0.7);
      break;
    }
    case 'npc_hall': {
      const f = s.faction || 0;
      if (f === 0) {
        // goblin hut: round thatched roof, bone fence, skull totems
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * TAU;
          ctx.strokeStyle = '#e9e4d6'; ctx.lineWidth = 4; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * (hs - 2), y + Math.sin(a) * (hs - 2)); ctx.lineTo(x + Math.cos(a) * (hs + 6), y + Math.sin(a) * (hs + 6)); ctx.stroke();
        }
        ctx.lineCap = 'butt';
        circle(x, y, hs * 0.86, '#c9a24a', '#6b5220', 4);
        ctx.strokeStyle = 'rgba(110,80,30,0.55)'; ctx.lineWidth = 2;
        for (let i = 0; i < 28; i++) { const a = (i / 28) * TAU; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 8, y + Math.sin(a) * 8); ctx.lineTo(x + Math.cos(a) * hs * 0.84, y + Math.sin(a) * hs * 0.84); ctx.stroke(); }
        for (let r = hs * 0.3; r < hs * 0.84; r += 12) circle(x, y, r, null, 'rgba(110,80,30,0.35)', 1.5);
        circle(x, y, 10, '#8a6a2a', '#4e3a14', 2.5);
        for (const [dx, dy] of [[-hs * 0.55, hs * 0.55], [hs * 0.55, hs * 0.55]]) {
          ctx.fillStyle = '#6b4428'; ctx.fillRect(x + dx - 2, y + dy - 18, 4, 20);
          circle(x + dx, y + dy - 20, 7, '#efeadc', '#8a8474', 2); circle(x + dx - 2.5, y + dy - 21, 1.8, '#1b1420'); circle(x + dx + 2.5, y + dy - 21, 1.8, '#1b1420');
        }
        banner(x, y + hs * 0.55, 18, col);
      } else if (f === 1) {
        // bandit hideout: timber longhouse, crates and a red banner
        roundRect(x - hs, y - hs * 0.75, hs * 2, hs * 1.5, 8); ctx.fillStyle = '#7a5a38'; ctx.fill(); ctx.strokeStyle = '#3e2a18'; ctx.lineWidth = 3; ctx.stroke();
        gableRoof(x - hs + 6, y - hs * 0.75 + 6, hs * 2 - 12, hs * 1.5 - 12, '#5a3a2a');
        for (const [dx, dy] of [[-hs + 4, hs * 0.72], [-hs + 22, hs * 0.8], [hs - 26, hs * 0.76]]) {
          ctx.fillStyle = '#a8764a'; ctx.fillRect(x + dx, y + dy, 16, 14); ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 2; ctx.strokeRect(x + dx, y + dy, 16, 14);
          ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.lineTo(x + dx + 16, y + dy + 14); ctx.stroke();
        }
        banner(x - 24, y + hs * 0.5, 20, col); banner(x + 24, y + hs * 0.5, 20, col);
        torchFlame(x, y + hs * 0.62, t, 7);
      } else {
        // orc stronghold: dark stone keep, spikes, braziers
        roundRect(x - hs, y - hs, hs * 2, hs * 2, 10); ctx.fillStyle = '#4a4040'; ctx.fill();
        roundRect(x - hs, y - hs, hs * 2, hs * 2, 10); brickLines(x - hs, y - hs, hs * 2, hs * 2, 12, 24, 0.3);
        roundRect(x - hs, y - hs, hs * 2, hs * 2, 10); ctx.strokeStyle = '#1e1818'; ctx.lineWidth = 4; ctx.stroke();
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * TAU;
          ctx.save(); ctx.translate(x + Math.cos(a) * hs * 1.02, y + Math.sin(a) * hs * 1.02); ctx.rotate(a + Math.PI / 2);
          tri(-4, 0, 4, 0, 0, -12, '#c8c0b0'); ctx.restore();
        }
        const kh = hs * 0.55;
        tri(x - kh, y - kh, x + kh, y - kh, x, y, darker(col, 1.2) || col);
        tri(x - kh, y - kh, x - kh, y + kh, x, y, col);
        tri(x + kh, y - kh, x + kh, y + kh, x, y, darker(col, 0.65));
        tri(x - kh, y + kh, x + kh, y + kh, x, y, darker(col, 0.8));
        ctx.strokeStyle = '#1e1818'; ctx.lineWidth = 3; ctx.strokeRect(x - kh, y - kh, kh * 2, kh * 2);
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const bx = x + dx * (hs - 12), by = y + dy * (hs - 12);
          circle(bx, by, 9, '#2e2626', '#1e1818', 2); glow(bx, by, 20, 'rgba(255,110,40,A)', 0.6);
          circle(bx + Math.sin(t * 9 + dx) * 1.5, by, 4, '#ff7a2d');
        }
        circle(x, y + hs * 0.2, 8, '#efeadc', '#8a8474', 2); circle(x - 3, y + hs * 0.2 - 1, 2, '#1b1420'); circle(x + 3, y + hs * 0.2 - 1, 2, '#1b1420');
      }
      teamFlag(x, y - (f === 1 ? 4 : 0), s.rel, t, 1.3, col);
      break;
    }
    case 'warcamp': {
      circle(x, y, hs, '#a8906a', '#6b5a3a', 2);
      ctx.fillStyle = 'rgba(120,95,60,0.35)';
      for (let i = 0; i < 12; i++) { ctx.beginPath(); ctx.arc(x + (S.hash2(i, 5, 2) - 0.5) * hs * 1.4, y + (S.hash2(i, 6, 2) - 0.5) * hs * 1.4, 3, 0, TAU); ctx.fill(); }
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * TAU;
        if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.3) continue; // gate gap
        const px = x + Math.cos(a) * (hs - 4), py = y + Math.sin(a) * (hs - 4);
        circle(px, py, 5.5, '#8a5a30', '#4e321c', 1.8);
        circle(px - 1, py - 1, 2, '#b88050');
      }
      // hide tent
      const tx = x - 6, ty = y - 8;
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * TAU, a1 = ((i + 1) / 6) * TAU;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.arc(tx, ty, 20, a0, a1); ctx.closePath();
        ctx.fillStyle = i % 2 ? '#c89066' : '#b07a52'; ctx.fill();
      }
      circle(tx, ty, 20, null, '#6b4a2a', 2.5);
      ctx.strokeStyle = '#4e321c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx - 4, ty - 4); ctx.lineTo(tx + 4, ty + 4); ctx.moveTo(tx + 4, ty - 4); ctx.lineTo(tx - 4, ty + 4); ctx.stroke();
      tri(tx - 7, ty + 18, tx + 7, ty + 18, tx, ty + 6, '#3a2a20');
      // campfire
      const fx = x + hs * 0.42, fy = y + hs * 0.35;
      for (let i = 0; i < 7; i++) { const a = (i / 7) * TAU; circle(fx + Math.cos(a) * 8, fy + Math.sin(a) * 8, 2.8, '#8a8378', '#4a4238', 1); }
      glow(fx, fy, 26, 'rgba(255,150,50,A)', 0.5);
      for (let i = 0; i < 3; i++) circle(fx + Math.sin(t * 9 + i * 2) * 2, fy - i * 2.5, 5 - i * 1.3, ['#ff5a1a', '#ff9a3d', '#ffe07a'][i]);
      smokeFrom(fx, fy - 6, 0.04);
      // axe rack
      const rx = x - hs * 0.45, ry = y + hs * 0.35;
      for (const s2 of [-1, 1]) {
        ctx.save(); ctx.translate(rx, ry); ctx.rotate(s2 * 0.6);
        ctx.fillStyle = '#6a4220'; ctx.fillRect(-1.5, -12, 3, 22);
        ctx.fillStyle = '#c8d0d8'; ctx.beginPath(); ctx.moveTo(1.5, -12); ctx.quadraticCurveTo(10, -9, 1.5, -2); ctx.fill();
        ctx.restore();
      }
      teamFlag(x + hs * 0.5, y - hs * 0.35, s.rel, t, 1);
      break;
    }
  }
  ctx.globalAlpha = A0;
  if (!iconMode && s.type !== 'wall' && s.type !== 'npc_hall') levelDressing(s, t);
  if (s.type !== 'wall' && !iconMode) {
    for (let i = 0; i < s.lvl; i++) {
      ctx.fillStyle = '#ffd76a'; ctx.strokeStyle = '#6a4a10'; ctx.lineWidth = 1.5;
      star(x - (s.lvl - 1) * 7 + i * 14, y + hs - 6, 5);
    }
  }
  if (s.hp < 100) hpBar(x, y - hs - 14, Math.min(90, hs * 1.4), s.hp, s.rel === 2 ? '#e8514a' : s.rel === 1 ? '#45c46a' : '#3d9df3');
}
const MOB_COL = { cow: '#f6f1e8', wolf: '#8a8c90', goblin: '#6fae4a', slime: '#5ecb6a', skeleton: '#e9e4d6', imp: '#d8483a', golem: '#8a7a68', boar: '#7a5234', spider: '#3a3040', troll: '#6f8a5a', yeti: '#eef4f8', salamander: '#f07a2a', wraith: '#bfe4ff' };
function drawMob(x, y, type, aim, anim, t, tier, flash, id) {
  const d = S.MOBS[type];
  const r = d.r * (tier > 1.5 ? 1.12 : 1);
  const col = MOB_COL[type];
  shadow(x, y, r);
  ctx.save(); ctx.translate(x, y);
  const lunge = anim < 0.3 ? Math.sin((anim / 0.3) * Math.PI) * 8 : 0;
  switch (type) {
    case 'cow': {
      ctx.rotate(aim);
      const graze = Math.max(0, Math.sin(t * 0.9 + id)) * 4;
      const sw = Math.sin(t * 3.2 + id);
      // tail with a dark tuft
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#d6cabb'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-r * 1.02, 0); ctx.quadraticCurveTo(-r * 1.35, sw * 6, -r * 1.5, sw * 12); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = '#3a2e2a'; ctx.beginPath(); ctx.ellipse(-r * 1.52, sw * 12.5, 3.5, 2.4, sw, 0, TAU); ctx.fill();
      // hooves under the body
      for (const [lx, ly] of [[0.55, -0.6], [0.55, 0.6], [-0.62, -0.58], [-0.62, 0.58]]) circle(lx * r, ly * r, 4.2, '#4a3a34', '#241a16', 1.5);
      // body with patches
      ctx.fillStyle = col; ctx.strokeStyle = '#8a7c6c'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 1.02, r * 0.7, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 1.0, r * 0.68, 0, 0, TAU); ctx.clip();
      ctx.fillStyle = '#2e2626';
      for (let i = 0; i < 5; i++) {
        const px = (S.hash2(id, i, 5) - 0.6) * r * 1.7, py = (S.hash2(id, i, 6) - 0.5) * r * 1.3;
        ctx.beginPath(); ctx.ellipse(px, py, r * (0.18 + S.hash2(id, i, 7) * 0.24), r * (0.13 + S.hash2(id, i, 8) * 0.18), S.hash2(id, i, 9) * 3, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.beginPath(); ctx.ellipse(-r * 0.2, -r * 0.3, r * 0.65, r * 0.16, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.beginPath(); ctx.ellipse(-r * 0.1, r * 0.45, r * 0.9, r * 0.25, 0, 0, TAU); ctx.fill();
      ctx.restore();
      // spine
      ctx.strokeStyle = 'rgba(120,105,90,0.35)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-r * 0.9, 0); ctx.lineTo(r * 0.7, 0); ctx.stroke();
      // collar & bell
      const hx = r * 0.98 + graze, hy = Math.sin(t * 0.6 + id) * 2;
      ctx.strokeStyle = '#7a3a22'; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(r * 0.72, -r * 0.34); ctx.quadraticCurveTo(r * 0.82, 0, r * 0.72, r * 0.34); ctx.stroke();
      circle(r * 0.86, r * 0.1, 3.6, '#e8b830', '#8a5a10', 1.3);
      circle(r * 0.85, r * 0.08, 1.1, '#fff4b0');
      // ears & horns
      for (const sd of [-1, 1]) {
        ctx.save(); ctx.translate(hx - 3, hy + sd * r * 0.36); ctx.rotate(sd * 0.5);
        ctx.fillStyle = '#e8dccc'; ctx.beginPath(); ctx.ellipse(0, sd * 3, 6, 3.5, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#8a7c6c'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = '#f0a8a8'; ctx.beginPath(); ctx.ellipse(0, sd * 3, 3.5, 1.8, 0, 0, TAU); ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#f2e6c8'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(hx - 1, hy + sd * r * 0.2); ctx.quadraticCurveTo(hx - 2, hy + sd * r * 0.42, hx + 4, hy + sd * r * 0.5); ctx.stroke();
        ctx.strokeStyle = '#8a7c6c'; ctx.lineWidth = 1; ctx.stroke();
        ctx.lineCap = 'butt';
      }
      // head
      ctx.fillStyle = col; ctx.strokeStyle = '#8a7c6c'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(hx, hy, r * 0.44, r * 0.36, 0, 0, TAU); ctx.fill(); ctx.stroke();
      if (id % 2) { ctx.fillStyle = '#2e2626'; ctx.beginPath(); ctx.ellipse(hx - 2, hy - r * 0.12, r * 0.2, r * 0.14, 0.4, 0, TAU); ctx.fill(); }
      // snout
      ctx.fillStyle = '#f2b0a8'; ctx.strokeStyle = '#b87870'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(hx + r * 0.36, hy, r * 0.2, r * 0.27, 0, 0, TAU); ctx.fill(); ctx.stroke();
      circle(hx + r * 0.42, hy - r * 0.1, 1.6, '#6a3a36'); circle(hx + r * 0.42, hy + r * 0.1, 1.6, '#6a3a36');
      // eyes
      circle(hx + r * 0.08, hy - r * 0.22, 2.2, '#1a1414'); circle(hx + r * 0.08, hy + r * 0.22, 2.2, '#1a1414');
      circle(hx + r * 0.1, hy - r * 0.24, 0.7, '#ffffff'); circle(hx + r * 0.1, hy + r * 0.2, 0.7, '#ffffff');
      break;
    }
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
    case 'boar': {
      ctx.rotate(aim); ctx.translate(lunge, 0);
      for (const [lx, sd] of [[r * 0.5, -1], [r * 0.5, 1], [-r * 0.5, -1], [-r * 0.5, 1]]) { ctx.fillStyle = '#3e2a18'; ctx.beginPath(); ctx.ellipse(lx + Math.sin(t * 14 + lx) * 2, sd * r * 0.7, 4, 3, 0, 0, TAU); ctx.fill(); }
      ctx.fillStyle = col; ctx.strokeStyle = '#3e2a18'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(0, 0, r * 1.1, r * 0.75, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#3e2a18'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-r * 0.9, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
      circle(r * 0.95, 0, r * 0.45, '#8a6040', '#3e2a18', 2.5);
      circle(r * 1.35, 0, r * 0.25, '#d88a8a', '#6a3a3a', 2);
      ctx.fillStyle = '#f4f1e8';
      ctx.beginPath(); ctx.moveTo(r * 1.1, -r * 0.3); ctx.quadraticCurveTo(r * 1.5, -r * 0.55, r * 1.45, -r * 0.2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(r * 1.1, r * 0.3); ctx.quadraticCurveTo(r * 1.5, r * 0.55, r * 1.45, r * 0.2); ctx.fill();
      circle(r * 1.0, -r * 0.25, 2.2, '#1b1420'); circle(r * 1.0, r * 0.25, 2.2, '#1b1420');
      break;
    }
    case 'spider': {
      ctx.rotate(aim); ctx.translate(lunge, 0);
      ctx.strokeStyle = '#1e1824'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) {
        const a = (i - 1.5) * 0.45, step = Math.sin(t * 16 + i * 1.7 + sd) * 0.18;
        const kx = Math.cos(a + step) * r * 0.9, ky = sd * (r * 0.7 + Math.abs(Math.sin(a)) * r * 0.3);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(kx, ky); ctx.lineTo(kx * 1.4 + (i - 1.5) * 4, ky * 1.6); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      ctx.fillStyle = col; ctx.strokeStyle = '#150f1c'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(-r * 0.55, 0, r * 0.8, r * 0.65, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.moveTo(-r * 0.8, -4); ctx.lineTo(-r * 0.4, 0); ctx.lineTo(-r * 0.8, 4); ctx.lineTo(-r * 0.55, 0); ctx.closePath(); ctx.fill();
      circle(r * 0.35, 0, r * 0.45, '#4a3f55', '#150f1c', 2);
      for (const [ex, ey] of [[0.6, -0.15], [0.6, 0.15], [0.48, -0.28], [0.48, 0.28]]) circle(r * ex, r * ey, 1.8, '#ff4a3a');
      break;
    }
    case 'troll': {
      ctx.rotate(aim); ctx.translate(lunge * 0.6, 0);
      const sw = anim < 0.3 ? lerp(-1.2, 1, anim / 0.3) : 0.5;
      ctx.save(); ctx.translate(r * 0.2, r * 0.8); ctx.rotate(sw);
      ctx.fillStyle = '#7a5234'; ctx.strokeStyle = '#3e2a18'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -3); ctx.lineTo(r * 1.4, -7); ctx.lineTo(r * 1.4, 7); ctx.lineTo(0, 3); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      circle(0, 0, r, col, '#3a4a2e', 4);
      ctx.fillStyle = 'rgba(40,60,30,0.35)'; ctx.beginPath(); ctx.arc(-r * 0.3, r * 0.3, r * 0.35, 0, TAU); ctx.fill();
      circle(r * 0.7, -r * 0.75, r * 0.3, col, '#3a4a2e', 3);
      circle(r * 0.45, -r * 0.22, 3.5, '#ffe14a'); circle(r * 0.45, r * 0.22, 3.5, '#ffe14a');
      tri(r * 0.7, -r * 0.12, r * 0.95, -r * 0.3, r * 0.75, -r * 0.02, '#f4f1e8'); tri(r * 0.7, r * 0.12, r * 0.95, r * 0.3, r * 0.75, r * 0.02, '#f4f1e8');
      break;
    }
    case 'yeti': {
      ctx.rotate(aim); ctx.translate(lunge * 0.6, 0);
      for (const sd of [-1, 1]) circle(r * 0.5, sd * r * 0.95, r * 0.35, '#e4eef4', '#8aa4b8', 2.5);
      ctx.fillStyle = col; ctx.strokeStyle = '#8aa4b8'; ctx.lineWidth = 3;
      polyRand(0, 0, r, 41, 14, 0.12); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#9ec4dc'; ctx.beginPath(); ctx.ellipse(r * 0.45, 0, r * 0.35, r * 0.4, 0, 0, TAU); ctx.fill();
      circle(r * 0.55, -r * 0.14, 2.5, '#1b1420'); circle(r * 0.55, r * 0.14, 2.5, '#1b1420');
      ctx.strokeStyle = '#5a7890'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r * 0.6, 0, 4, -1, 1); ctx.stroke();
      tri(-r * 0.1, -r * 0.55, -r * 0.35, -r * 0.95, r * 0.05, -r * 0.62, '#c8d6e0'); tri(-r * 0.1, r * 0.55, -r * 0.35, r * 0.95, r * 0.05, r * 0.62, '#c8d6e0');
      break;
    }
    case 'salamander': {
      ctx.rotate(aim);
      glow(0, 0, r * 2, 'rgba(255,120,40,A)', 0.3);
      ctx.strokeStyle = '#c0501a'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.6, 0); ctx.quadraticCurveTo(-r * 1.3, Math.sin(t * 8 + id) * 10, -r * 1.8, Math.sin(t * 8 + id + 1) * 8); ctx.stroke();
      ctx.lineCap = 'butt';
      for (const [lx, sd] of [[r * 0.4, -1], [r * 0.4, 1], [-r * 0.4, -1], [-r * 0.4, 1]]) { ctx.strokeStyle = '#a0401a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx + Math.sin(t * 12 + lx) * 4, sd * r * 0.9); ctx.stroke(); }
      ctx.fillStyle = col; ctx.strokeStyle = '#7a2a0a'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.55, 0, 0, TAU); ctx.fill(); ctx.stroke();
      for (let i = 0; i < 4; i++) circle(-r * 0.5 + i * r * 0.3, (i % 2 ? 1 : -1) * r * 0.15, 3, '#ffd34a');
      circle(r * 0.95, 0, r * 0.42, col, '#7a2a0a', 2.5);
      circle(r * 1.05, -r * 0.2, 2.5, '#1b1420'); circle(r * 1.05, r * 0.2, 2.5, '#1b1420');
      break;
    }
    case 'wraith': {
      ctx.rotate(aim);
      const A1 = ctx.globalAlpha;
      ctx.globalAlpha = A1 * (0.65 + Math.sin(t * 5 + id) * 0.15);
      glow(0, 0, r * 2, 'rgba(160,210,255,A)', 0.5);
      ctx.fillStyle = col; ctx.strokeStyle = '#5a7aa0'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; const rr = r * (i % 2 ? 0.85 : 1.15) + Math.sin(t * 7 + i) * 3; ctx.lineTo(Math.cos(a) * rr - (Math.cos(a) < 0 ? r * 0.4 : 0), Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      circle(r * 0.35, -r * 0.2, 3.5, '#1b2a4a'); circle(r * 0.35, r * 0.2, 3.5, '#1b2a4a');
      circle(r * 0.37, -r * 0.2, 1.8, '#9ef0ff'); circle(r * 0.37, r * 0.2, 1.8, '#9ef0ff');
      ctx.globalAlpha = A1;
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


// =================================================================== unit drawing
function swordShape(r, len, w) {
  ctx.fillStyle = '#e8ecf2'; ctx.strokeStyle = '#4a4f58'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(r + 2, -w); ctx.lineTo(r + len, -w + 1); ctx.lineTo(r + len + 8, 0); ctx.lineTo(r + len, w - 1); ctx.lineTo(r + 2, w); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#c9a040'; ctx.fillRect(r - 2, -w - 6, 5, w * 2 + 12);
  ctx.fillStyle = '#6a4220'; ctx.fillRect(r - 12, -3, 11, 6);
}
function axeShape(r, len) {
  ctx.fillStyle = '#7a4a22'; ctx.fillRect(r - 6, -2.5, len, 5);
  ctx.fillStyle = '#d2d9e0'; ctx.strokeStyle = '#4a4f58'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(r + len - 12, -3); ctx.quadraticCurveTo(r + len + 6, -16, r + len + 4, 0); ctx.quadraticCurveTo(r + len + 6, 16, r + len - 12, 3); ctx.closePath(); ctx.fill(); ctx.stroke();
}
function staffShape(r, orb, orbGlow, glowAmt) {
  ctx.strokeStyle = '#6a4220'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.85); ctx.lineTo(r + 20, r * 0.85); ctx.stroke(); ctx.lineCap = 'butt';
  const R = 12 + glowAmt * 10;
  const g = ctx.createRadialGradient(r + 22, r * 0.85, 1, r + 22, r * 0.85, R);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, orb); g.addColorStop(1, orbGlow);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(r + 22, r * 0.85, R, 0, TAU); ctx.fill();
}
function heroBody(x, y, r, col, flash) {
  circle(x, y, r, col, darker(col, 0.55), 3.5);
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, TAU); ctx.fill();
}
function drawHero(x, y, type, aim, rel, anim, flags, t, flash, moving) {
  const def = S.heroDef(type);
  const r = def.r;
  const col = REL_COLORS[rel];
  const A0 = ctx.globalAlpha;
  if (flags.stealth) ctx.globalAlpha = A0 * 0.35;
  if (moving && !iconMode && !flags.stealth && Math.random() < 0.18) {
    particles.push({ x: x - Math.cos(aim) * r * 0.6 + (Math.random() - 0.5) * r, y: y + r * 0.55, vx: (Math.random() - 0.5) * 20, vy: -10 - Math.random() * 10, t: 0, life: 0.5, c: 'rgba(200,185,150,0.5)', s: 4 + Math.random() * 3, smoke: true });
  }
  shadow(x, y, type === 'cavalier' ? r * 1.3 : r);
  if (flags.tier === 2) {
    const ac = { warrior: '255,215,80', ranger: '140,240,170', mage: '200,160,255' }[def.base];
    glow(x, y, r + 22, `rgba(${ac},A)`, 0.35);
    for (let i = 0; i < 8; i++) { const a = t * 2 + (i / 8) * TAU; circle(x + Math.cos(a) * (r + 11), y + Math.sin(a) * (r + 11), 2.2, `rgb(${ac})`); }
  }
  if (flags.rage) glow(x, y, r + 20, 'rgba(255,60,30,A)', 0.45);
  if (flags.recall) {
    ctx.strokeStyle = `rgba(160,220,255,${0.4 + Math.sin(t * 12) * 0.3})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 14 + Math.sin(t * 6) * 4, 0, TAU); ctx.stroke();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(aim);
  const swing = anim < 1 ? lerp(-1.3, 1.3, 1 - Math.pow(1 - anim, 3)) : 0.9;
  const trail = (len) => {
    if (anim < 0.6) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - anim / 0.6)})`; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.arc(0, 0, len, -1.2, lerp(-1.2, 1.2, Math.min(1, anim * 2.5))); ctx.stroke();
    }
  };
  // ---- mount & weapons (under the body)
  if (type === 'cavalier') {
    const gal = moving ? Math.sin(t * 16) : 0;
    ctx.strokeStyle = '#4e321c'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    for (const [lx, side, ph] of [[r * 0.7, -1, 0], [r * 0.7, 1, Math.PI], [-r * 0.7, -1, Math.PI], [-r * 0.7, 1, 0]]) {
      const o = moving ? Math.sin(t * 16 + ph) * 7 : 0;
      ctx.beginPath(); ctx.moveTo(lx, side * r * 0.45); ctx.lineTo(lx + o, side * r * 0.85); ctx.stroke();
    }
    ctx.strokeStyle = '#3a2414'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(-r * 1.2, 0); ctx.quadraticCurveTo(-r * 1.6, gal * 6, -r * 1.9, Math.sin(t * 5) * 5); ctx.stroke(); ctx.lineCap = 'butt';
    ctx.fillStyle = '#9a6838'; ctx.strokeStyle = '#4e321c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.35, r * 0.62, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 0.55, r * 0.66, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd34a'; ctx.fillRect(-r * 0.62, -r * 0.66, 3, r * 1.32);
    ctx.fillStyle = '#9a6838'; ctx.beginPath(); ctx.ellipse(r * 1.45, 0, r * 0.45, r * 0.3, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#3a2414'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(r * 0.5, 0); ctx.lineTo(r * 1.2, 0); ctx.stroke();
    tri(r * 1.3, -r * 0.2, r * 1.2, -r * 0.45, r * 1.45, -r * 0.25, '#6b4428'); tri(r * 1.3, r * 0.2, r * 1.2, r * 0.45, r * 1.45, r * 0.25, '#6b4428');
    circle(r * 1.8, -4, 1.5, '#1a1410'); circle(r * 1.8, 4, 1.5, '#1a1410');
    const push = anim < 0.5 ? Math.sin((anim / 0.5) * Math.PI) * 18 : 0;
    ctx.save(); ctx.translate(push, r * 0.45);
    ctx.fillStyle = '#b88050'; ctx.fillRect(-8, -3, r * 2.9, 6);
    ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 1.5; ctx.strokeRect(-8, -3, r * 2.9, 6);
    tri(r * 2.9 - 8, -6, r * 2.9 - 8, 6, r * 2.9 + 10, 0, '#e8ecf2');
    tri(r * 0.3, -3, r * 0.3, -14, r * 1.1, -8, col);
    ctx.restore();
  } else if (type === 'warrior' || type === 'guardian') {
    trail(S.CLASSES.warrior.range - (type === 'guardian' ? 20 : 10));
    ctx.save(); ctx.rotate(swing); swordShape(r, type === 'guardian' ? 34 : 48, 4); ctx.restore();
    if (type === 'warrior') {
      ctx.fillStyle = darker(col, 0.8); ctx.strokeStyle = '#c9a040'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(r * 0.35, -r * 0.85, 12, 8, 0.3, 0, TAU); ctx.fill(); ctx.stroke();
    }
  } else if (type === 'berserker') {
    trail(S.CLASSES.warrior.range - 4);
    ctx.save(); ctx.rotate(swing); axeShape(r, 44); ctx.restore();
    ctx.save(); ctx.rotate(-swing * 0.6 - 0.8); axeShape(r * 0.8, 30); ctx.restore();
  } else if (type === 'ranger' || type === 'beastmaster') {
    const pull = anim < 1 ? Math.max(0, 1 - anim * 3) : 0;
    ctx.strokeStyle = type === 'beastmaster' ? '#5a3820' : '#7a4a1e'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(r * 0.3, 0, r + 4, -1.05, 1.05); ctx.stroke();
    const bx = r * 0.3 + Math.cos(1.05) * (r + 4), by = Math.sin(1.05) * (r + 4);
    const sx = r * 0.3 + 2 - pull * 10 - (anim >= 1 ? 8 : 0);
    ctx.strokeStyle = '#eee'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(bx, -by); ctx.lineTo(sx, 0); ctx.lineTo(bx, by); ctx.stroke();
    if (anim > 0.35) { ctx.strokeStyle = '#d8c090'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(r + 22, 0); ctx.stroke(); }
  } else if (type === 'sniper') {
    const kick = anim < 0.3 ? (1 - anim / 0.3) * 6 : 0;
    ctx.save(); ctx.translate(-kick, 0);
    ctx.fillStyle = '#6b4428'; ctx.fillRect(r * 0.2, -3, r + 18, 6);
    ctx.strokeStyle = '#4a3020'; ctx.lineWidth = 1.5; ctx.strokeRect(r * 0.2, -3, r + 18, 6);
    ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(r + 10, -16); ctx.quadraticCurveTo(r + 16, 0, r + 10, 16); ctx.stroke();
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(r + 10, -16); ctx.lineTo(r + 2, 0); ctx.lineTo(r + 10, 16); ctx.stroke();
    ctx.fillStyle = '#8a94a0'; ctx.fillRect(r + 2, -1.5, 20, 3);
    ctx.fillStyle = '#c8d0d8'; ctx.fillRect(r * 0.4, -7, 10, 4);
    ctx.restore();
  } else if (type === 'shadow') {
    for (const [side, ph] of [[-1, 0], [1, 0.5]]) {
      const stab = anim < 0.4 ? Math.sin(((anim + ph * 0.2) / 0.4) * Math.PI) * 8 : 0;
      ctx.save(); ctx.translate(r * 0.3 + stab, side * r * 0.7); ctx.rotate(side * 0.3);
      ctx.fillStyle = '#c8d0d8'; ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -2.5); ctx.lineTo(16, 0); ctx.lineTo(0, 2.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c0392b'; ctx.fillRect(-6, -2, 6, 4);
      ctx.restore();
    }
  } else if (def.base === 'mage') {
    const glowAmt = anim < 1 ? 1 - anim : 0;
    if (type === 'storm') {
      staffShape(r, '#78e0ff', 'rgba(40,140,255,0)', glowAmt);
      ctx.strokeStyle = '#e6faff'; ctx.lineWidth = 1.5; ctx.beginPath();
      let px = r + 22, py = r * 0.85;
      for (let i = 0; i < 4; i++) { const nx = px + (Math.random() - 0.5) * 14, ny = py + (Math.random() - 0.5) * 14; ctx.moveTo(px, py); ctx.lineTo(nx, ny); px = nx; py = ny; }
      ctx.stroke();
    } else if (type === 'druid') {
      ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.85); ctx.quadraticCurveTo(r * 0.6, r * 1.1, r + 18, r * 0.8); ctx.stroke(); ctx.lineCap = 'butt';
      for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU + t; ctx.fillStyle = i % 2 ? '#66b84c' : '#9ada74'; ctx.beginPath(); ctx.ellipse(r + 20 + Math.cos(a) * 6, r * 0.8 + Math.sin(a) * 6, 5, 3, a, 0, TAU); ctx.fill(); }
      if (glowAmt > 0) glow(r + 20, r * 0.8, 10 + glowAmt * 10, 'rgba(150,255,120,A)', 0.6 * glowAmt);
    } else if (type === 'holy') {
      ctx.strokeStyle = '#c9922a'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-r * 0.2, r * 0.85); ctx.lineTo(r + 18, r * 0.85); ctx.stroke(); ctx.lineCap = 'butt';
      glow(r + 22, r * 0.85, 14 + glowAmt * 10, 'rgba(255,230,120,A)', 0.8);
      circle(r + 22, r * 0.85, 6, '#fff4b0', '#e0b44a', 2);
      ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + t; ctx.beginPath(); ctx.moveTo(r + 22 + Math.cos(a) * 8, r * 0.85 + Math.sin(a) * 8); ctx.lineTo(r + 22 + Math.cos(a) * 12, r * 0.85 + Math.sin(a) * 12); ctx.stroke(); }
    } else staffShape(r, '#ff9a3d', 'rgba(255,90,20,0)', glowAmt);
  }
  if (type === 'guardian') {
    // tower shield carried in front
    ctx.save(); ctx.translate(r * 0.95, -r * 0.1);
    roundRect(-6, -r * 1.05, 12, r * 2.1, 4); ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = '#c9a040'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#ffd34a'; ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-4, -r * 0.95, 3, r * 1.9);
    ctx.restore();
  }
  ctx.restore();
  // ---- body
  const bx = type === 'cavalier' ? x - Math.cos(aim) * r * 0.1 : x, by = type === 'cavalier' ? y - Math.sin(aim) * r * 0.1 : y;
  const br = type === 'cavalier' ? r * 0.62 : r;
  heroBody(bx, by, br, type === 'shadow' ? darker(col, 0.55) : col, flash);
  // ---- headgear
  ctx.save(); ctx.translate(bx, by); ctx.rotate(aim);
  const R = br;
  switch (type) {
    case 'warrior': case 'cavalier':
      circle(0, 0, R * 0.62, '#b8bec8', '#5a606a', 2.5);
      ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(R * 0.1, -R * 0.4); ctx.lineTo(R * 0.1, R * 0.4); ctx.stroke();
      if (type === 'warrior') {
        ctx.fillStyle = '#efe6d0';
        ctx.beginPath(); ctx.moveTo(-R * 0.1, -R * 0.55); ctx.lineTo(-R * 0.45, -R * 1.05); ctx.lineTo(R * 0.15, -R * 0.6); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-R * 0.1, R * 0.55); ctx.lineTo(-R * 0.45, R * 1.05); ctx.lineTo(R * 0.15, R * 0.6); ctx.fill();
      } else {
        ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(-R * 0.55, 0, R * 0.45, R * 0.18, 0, 0, TAU); ctx.fill();
      }
      break;
    case 'guardian':
      circle(0, 0, R * 0.66, '#c8ced6', '#5a606a', 2.5);
      ctx.fillStyle = '#3a3f48'; ctx.fillRect(R * 0.15, -R * 0.35, 3, R * 0.7); ctx.fillRect(-R * 0.1, -1.5, R * 0.5, 3);
      ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(-R * 0.25, 0, R * 0.5, R * 0.12, 0, 0, TAU); ctx.fill();
      break;
    case 'berserker':
      circle(0, 0, R * 0.58, '#6a6e78', '#3a3f48', 2.5);
      ctx.fillStyle = '#e07a2a'; ctx.beginPath(); ctx.arc(R * 0.3, 0, R * 0.42, -1.1, 1.1); ctx.fill();
      ctx.fillStyle = '#efe6d0';
      ctx.beginPath(); ctx.moveTo(-R * 0.05, -R * 0.5); ctx.quadraticCurveTo(-R * 0.3, -R * 1.25, R * 0.35, -R * 1.2); ctx.lineTo(R * 0.1, -R * 0.55); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-R * 0.05, R * 0.5); ctx.quadraticCurveTo(-R * 0.3, R * 1.25, R * 0.35, R * 1.2); ctx.lineTo(R * 0.1, R * 0.55); ctx.fill();
      break;
    case 'ranger':
      ctx.fillStyle = '#3f6e2e'; ctx.strokeStyle = '#243f1a'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(-R * 0.05, 0, R * 0.66, 0.9, TAU - 0.9); ctx.lineTo(-R * 0.95, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#f1d3b0'; ctx.beginPath(); ctx.arc(R * 0.25, 0, R * 0.3, -1.2, 1.2); ctx.fill();
      break;
    case 'sniper':
      circle(0, 0, R * 0.85, '#6b4a2a', '#3a2818', 2.5);
      circle(0, 0, R * 0.5, '#8a6a42', '#3a2818', 2);
      circle(R * 0.35, -R * 0.2, 3, '#78e0ff', '#2a3a4a', 1.5); circle(R * 0.35, R * 0.2, 3, '#78e0ff', '#2a3a4a', 1.5);
      break;
    case 'beastmaster':
      circle(0, 0, R * 0.7, '#8a8e96', '#4a4c50', 2.5);
      tri(-R * 0.2, -R * 0.5, -R * 0.55, -R * 0.95, R * 0.1, -R * 0.62, '#6a6e76');
      tri(-R * 0.2, R * 0.5, -R * 0.55, R * 0.95, R * 0.1, R * 0.62, '#6a6e76');
      ctx.fillStyle = '#f1d3b0'; ctx.beginPath(); ctx.arc(R * 0.3, 0, R * 0.28, -1.2, 1.2); ctx.fill();
      break;
    case 'shadow':
      circle(0, 0, R * 0.72, '#2c2238', '#150f1c', 2.5);
      tri(R * 0.1, -R * 0.2, -R * 1.05, 0, R * 0.1, R * 0.2, '#2c2238');
      circle(R * 0.4, -R * 0.2, 2.2, '#ff3a3a'); circle(R * 0.4, R * 0.2, 2.2, '#ff3a3a');
      break;
    case 'storm':
      ctx.fillStyle = '#2f67aa'; ctx.strokeStyle = '#1a3a66'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 0.75, R * 0.7, 0, 0, TAU); ctx.fill(); ctx.stroke();
      tri(R * 0.3, 0, -R * 0.9, -R * 0.3, -R * 0.9, R * 0.3, '#4a8ad0');
      ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(R * 0.25, -R * 0.3); ctx.lineTo(-R * 0.05, 0); ctx.lineTo(R * 0.15, 0.5); ctx.lineTo(-R * 0.2, R * 0.3); ctx.stroke();
      break;
    case 'druid':
      circle(0, 0, R * 0.6, '#5a8a3a', '#2e5a1e', 2.5);
      for (let i = 0; i < 7; i++) { const a = (i / 7) * TAU; ctx.fillStyle = i % 2 ? '#66b84c' : '#9ada74'; ctx.beginPath(); ctx.ellipse(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62, 4, 2.5, a, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (const sd of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(-R * 0.1, sd * R * 0.4); ctx.lineTo(-R * 0.6, sd * R * 1.1); ctx.moveTo(-R * 0.35, sd * R * 0.75); ctx.lineTo(-R * 0.1, sd * R * 1.15); ctx.moveTo(-R * 0.5, sd * R * 0.95); ctx.lineTo(-R * 0.95, sd * R * 1.0); ctx.stroke();
      }
      ctx.lineCap = 'butt';
      break;
    case 'holy':
      circle(0, 0, R * 0.72, '#f6f3ea', '#c9b98a', 2.5);
      circle(0, 0, R * 0.72, null, '#e0b44a', 2);
      ctx.fillStyle = '#f1d3b0'; ctx.beginPath(); ctx.arc(R * 0.28, 0, R * 0.3, -1.2, 1.2); ctx.fill();
      break;
    default: // mage
      ctx.fillStyle = '#5a3a9a'; ctx.strokeStyle = '#321f5c'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(0, 0, R * 0.75, R * 0.7, 0, 0, TAU); ctx.fill(); ctx.stroke();
      tri(R * 0.3, 0, -R * 0.9, -R * 0.3, -R * 0.9, R * 0.3, '#7a52c8');
      ctx.fillStyle = '#ffd76a'; ctx.strokeStyle = '#6a4a10'; ctx.lineWidth = 1.5; star(R * 0.05, 0, 5);
  }
  ctx.restore();
  if (type === 'holy') {
    ctx.strokeStyle = `rgba(255,215,90,${0.8 + Math.sin(t * 4) * 0.2})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(bx, by - r - 6 + Math.sin(t * 2) * 2, r * 0.6, r * 0.22, 0, 0, TAU); ctx.stroke();
  }
  if (flash) { ctx.globalAlpha = A0 * flash * 0.6; circle(bx, by, br + 1, '#ffffff'); ctx.globalAlpha = flags.stealth ? A0 * 0.35 : A0; }
  ctx.globalAlpha = A0;
  if (flags.invuln) { ctx.strokeStyle = `rgba(255,240,180,${0.5 + Math.sin(t * 10) * 0.3})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r + 7, 0, TAU); ctx.stroke(); }
  if (flags.bastion) { ctx.strokeStyle = 'rgba(255,215,80,0.9)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, r + 12, 0, TAU); ctx.stroke(); glow(x, y, r + 16, 'rgba(255,215,80,A)', 0.25); }
  if (flags.shield) { ctx.strokeStyle = `rgba(255,240,170,${0.6 + Math.sin(t * 8) * 0.25})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + 9, 0, TAU); ctx.stroke(); }
  if (flags.slow) { ctx.strokeStyle = 'rgba(150,220,255,0.8)'; ctx.lineWidth = 3; ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.stroke(); ctx.setLineDash([]); }
}

function drawAlly(x, y, type, aim, rel, anim, flash, t, moving, id, flags) {
  const def = S.ALLY_UNITS[type] || S.KNIGHT;
  const col = REL_COLORS[rel];
  if (type === 'peasant') { drawPeasant(x, y, aim, rel, anim, flash, t, moving, id, flags || 0); return; }
  if (type === 'knight') { drawKnight(x, y, aim, rel, anim, flash); return; }
  if (type === 'wolf') {
    drawMob(x, y, 'wolf', aim, anim, t, 1, flash, id);
    ctx.strokeStyle = col; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(x + Math.cos(aim) * 8, y + Math.sin(aim) * 8, 8, 0, TAU); ctx.stroke();
    return;
  }
  const r = def.r;
  shadow(x, y, r);
  if (type === 'merc') {
    ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
    const sw = anim < 0.4 ? lerp(-1.1, 1.1, anim / 0.4) : 0.7;
    ctx.save(); ctx.rotate(sw); axeShape(r, 26); ctx.restore();
    ctx.restore();
    circle(x, y, r, '#9a6838', '#4e321c', 3);
    ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
    circle(0, 0, r * 0.6, '#f2c79a', '#8a5a30', 2);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, r * 0.62, Math.PI * 0.55, Math.PI * 1.45); ctx.fill();
    tri(-r * 0.5, -r * 0.2, -r * 1.1, -r * 0.35, -r * 0.7, 0, col);
    ctx.fillStyle = '#5a3820'; ctx.beginPath(); ctx.arc(r * 0.35, 0, r * 0.3, -1.2, 1.2); ctx.fill();
    ctx.restore();
  } else if (type === 'ent') {
    const sway = Math.sin(t * 3 + id) * 0.1;
    ctx.save(); ctx.translate(x, y); ctx.rotate(aim);
    ctx.strokeStyle = '#6b4428'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(0, sd * r * 0.5); ctx.quadraticCurveTo(r * 0.7, sd * (r + 6), r * 1.2, sd * (r * 0.5 + sway * 20)); ctx.stroke(); }
    ctx.lineCap = 'butt';
    circle(0, 0, r * 0.8, '#7b5234', '#4a2e18', 3);
    for (let i = 0; i < 7; i++) { const a = (i / 7) * TAU; circle(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7, r * 0.34, i % 2 ? '#4f9a47' : '#68b058', '#2e6a30', 2); }
    circle(r * 0.3, -r * 0.2, 2.5, '#c8ff7a'); circle(r * 0.3, r * 0.2, 2.5, '#c8ff7a');
    ctx.restore();
    circle(x, y + r * 0.9, 3, col);
  }
  if (flash) { ctx.globalAlpha = flash * 0.7; circle(x, y, r, '#ffffff'); ctx.globalAlpha = 1; }
}

// peasants: straw hat, tunic in the owner's colour, a tool for their trade and whatever they carry
function drawPeasant(x, y, aim, rel, anim, flash, t, moving, id, fl) {
  const r = S.ALLY_UNITS.peasant.r, col = REL_COLORS[rel];
  const carry = fl & 7, hungry = fl & 8, scared = fl & 16;
  const ph = t * 13 + id;
  const bob = moving ? Math.abs(Math.sin(ph)) * 2 : 0;
  shadow(x, y + 1, r);
  if (moving && !iconMode && Math.random() < 0.08) particles.push({ x: x - Math.cos(aim) * r, y: y + r * 0.5, vx: -Math.cos(aim) * 15, vy: -12, t: 0, life: 0.45, c: 'rgba(190,170,130,0.55)', s: 4, smoke: true });
  ctx.save(); ctx.translate(x, y - bob); ctx.rotate(aim);
  const step = moving ? Math.sin(ph) * 5 : 0;
  circle(step, -r * 0.5, 4.2, '#5a3a22', '#2e1c10', 1.2); circle(-step, r * 0.5, 4.2, '#5a3a22', '#2e1c10', 1.2);
  // tool in the right hand: axe for woodcutters, pick for miners
  const job = id % 3;
  const sw = anim < 0.6 ? Math.sin((anim / 0.6) * Math.PI) * 1.5 - 0.5 : -0.5 + (moving ? Math.sin(ph) * 0.2 : 0);
  ctx.save(); ctx.translate(r * 0.15, r * 0.72); ctx.rotate(sw);
  ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-2, 0); ctx.lineTo(r * 1.25, 0); ctx.stroke();
  if (job === 0) {
    ctx.fillStyle = '#c8d0d8'; ctx.strokeStyle = '#5a6068'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(r * 1.0, -1.5); ctx.quadraticCurveTo(r * 1.15, -10, r * 1.4, -8); ctx.lineTo(r * 1.32, 1.5); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else {
    ctx.strokeStyle = '#9aa2ac'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(r * 1.55, 0, 8, Math.PI * 0.7, Math.PI * 1.3); ctx.stroke();
    ctx.strokeStyle = '#e0e6ec'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.restore();
  circle(r * 0.15 + Math.cos(sw) * 2, r * 0.72 + Math.sin(sw) * 2, 3.6, '#f2c79a', '#8a5a30', 1.2);
  circle(r * 0.35, -r * 0.72, 3.6, '#f2c79a', '#8a5a30', 1.2);
  // tunic & apron
  circle(0, 0, r, col, darker(col, 0.5), 2.5);
  ctx.fillStyle = '#d8c49a'; ctx.beginPath(); ctx.arc(0, 0, r - 1.5, -0.7, 0.7); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#6a4a28'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, r * 0.62, -1.3, 1.3); ctx.stroke();
  // load on the back
  if (carry) {
    ctx.save(); ctx.translate(-r * 0.95, 0);
    if (carry === 1) {
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = '#8a5a30'; roundRect(-5, i * 5 - 2.5, 14, 5, 2); ctx.fill();
        ctx.strokeStyle = '#4a2e18'; ctx.lineWidth = 1; ctx.stroke();
        circle(9, i * 5, 2.4, '#e0b27a', '#8a5a30', 0.8);
      }
      ctx.strokeStyle = '#c8a070'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(1, -8); ctx.lineTo(1, 8); ctx.stroke();
    } else if (carry === 2) {
      ctx.fillStyle = '#7a5a34'; roundRect(-6, -8, 12, 16, 3); ctx.fill();
      for (const [dx, dy, s] of [[-2, -4, 4], [2, 1, 4.5], [-2, 5, 3.5]]) { ctx.fillStyle = '#a8a192'; polyRand(dx, dy, s, id + dx, 6, 0.3); ctx.fill(); ctx.strokeStyle = '#5e564b'; ctx.lineWidth = 1; ctx.stroke(); }
    } else {
      circle(0, 0, 8, '#b89a64', '#6a5030', 1.5);
      ctx.strokeStyle = '#6a5030'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(5, -3); ctx.lineTo(8, 0); ctx.lineTo(5, 3); ctx.stroke();
      circle(-2, -2, 2.2, '#ffd34a', '#a87a10', 0.8); circle(2, 2, 2.2, '#ffd34a', '#a87a10', 0.8);
    }
    ctx.restore();
  }
  // straw hat
  circle(-1, 0, r * 0.88, '#e6c86a', '#9a7a2a', 2);
  ctx.strokeStyle = 'rgba(140,105,40,0.45)'; ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.arc(-1, 0, r * 0.68, 0, TAU); ctx.stroke();
  ctx.beginPath(); for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; ctx.moveTo(-1 + Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5); ctx.lineTo(-1 + Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86); } ctx.stroke();
  circle(-1, 0, r * 0.48, '#f0d480', '#a8862e', 1.5);
  ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(-1, 0, r * 0.5, 0, TAU); ctx.stroke();
  circle(-3, -2, r * 0.18, 'rgba(255,250,210,0.6)');
  ctx.restore();
  if (flash) { ctx.globalAlpha = flash * 0.7; circle(x, y, r, '#ffffff'); ctx.globalAlpha = 1; }
  if (hungry) {
    const p = 1 + Math.sin(t * 5 + id) * 0.08;
    const bx = x + 12, by = y - r - 20;
    circle(x + 5, y - r - 5, 2.2, '#ffffff', '#6a5a4a', 1); circle(x + 8, y - r - 10, 3, '#ffffff', '#6a5a4a', 1);
    circle(bx, by, 11 * p, '#ffffff', '#6a5a4a', 1.5);
    drumstick(bx, by, 0.55 * p);
    ctx.strokeStyle = '#d8322a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(bx - 7, by + 7); ctx.lineTo(bx + 7, by - 7); ctx.stroke();
  } else if (scared) {
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#8a1a14'; ctx.lineWidth = 3; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center';
    ctx.strokeText('!', x, y - r - 8); ctx.fillText('!', x, y - r - 8);
  }
}
// a roasted drumstick (the food resource), centred on x,y
function drumstick(x, y, s) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(-0.7);
  ctx.fillStyle = '#f4ecd8'; ctx.strokeStyle = OUTL; ctx.lineWidth = 2.2;
  roundRect(2, -2.5, 13, 5, 2.5); ctx.fill(); ctx.stroke();
  circle(15, -3, 3.4, '#f4ecd8', OUTL, 2.2); circle(15, 3, 3.4, '#f4ecd8', OUTL, 2.2);
  ctx.fillStyle = '#f4ecd8'; ctx.fillRect(10, -2, 6, 4);
  ctx.beginPath(); ctx.ellipse(-4, 0, 10, 8, 0, 0, TAU); ctx.fillStyle = '#b8602a'; ctx.fill(); ctx.strokeStyle = OUTL; ctx.stroke();
  ctx.fillStyle = '#d8843a'; ctx.beginPath(); ctx.ellipse(-6, -3, 6, 3.5, -0.2, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,240,200,0.7)'; ctx.beginPath(); ctx.ellipse(-8, -4, 2.5, 1.3, -0.3, 0, TAU); ctx.fill();
  ctx.restore();
}

// bosses: walk cycle driven by t, attack pose driven by atk (0..1 while attacking, -1 otherwise)
function drawBoss(x, y, key, aim, enraged, t, flash, atkT, moving) {
  const def = S.BOSSES.find((b) => b.key === key);
  const r = def.r;
  const atk = atkT < 450 ? atkT / 450 : -1;
  const up = atk >= 0 ? (atk < 0.45 ? atk / 0.45 : Math.max(0, 1 - (atk - 0.45) / 0.2)) : 0; // wind-up
  const hitK = atk >= 0.45 ? Math.min(1, (atk - 0.45) / 0.15) : 0; // strike
  const walk = moving ? Math.sin(t * 7) : 0;
  shadow(x, y, r, 0.3);
  if (enraged) glow(x, y, r * 1.8, 'rgba(255,40,20,A)', 0.35);
  ctx.save(); ctx.translate(x, y);
  if (key === 'treant') {
    ctx.rotate(aim);
    ctx.strokeStyle = 'rgba(58,36,20,0.7)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + 0.5; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6); ctx.quadraticCurveTo(Math.cos(a + 0.3) * r * 1.0, Math.sin(a + 0.3) * r * 1.0, Math.cos(a + 0.1) * (r * 1.15 + walk * 4), Math.sin(a + 0.1) * (r * 1.15)); ctx.stroke(); }
    ctx.strokeStyle = '#4a2e18';
    for (const s of [-1, 1]) {
      const wave = atk >= 0 ? lerp(-1.3 * up, 1.1, hitK) : Math.sin(t * 2 + s) * 0.3 + walk * 0.2 * s;
      const ex = r * 1.3 + (atk >= 0 ? hitK * r * 0.4 : 0);
      ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(0, s * r * 0.6); ctx.quadraticCurveTo(r * 0.8, s * r * (1.15 + wave), ex, s * r * (0.7 + wave)); ctx.stroke();
      ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(ex - 10, s * r * (0.82 + wave)); ctx.lineTo(ex + 14, s * r * (1.02 + wave)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex - 4, s * r * (0.74 + wave)); ctx.lineTo(ex + 16, s * r * (0.6 + wave)); ctx.stroke();
      ctx.fillStyle = '#4f9a47'; for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(ex - 18 + k * 9, s * r * (0.95 + wave) + s * 4, 5, 0, TAU); ctx.fill(); }
    }
    ctx.lineCap = 'butt';
    circle(0, 0, r * 0.85, '#7b5234', '#3a2414', 5);
    ctx.strokeStyle = 'rgba(40,20,10,0.45)'; ctx.lineWidth = 2;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.arc(0, 0, r * 0.17 * i, 0.3 * i, TAU - 0.4); ctx.stroke(); }
    ctx.fillStyle = 'rgba(110,154,74,0.8)'; ctx.beginPath(); ctx.ellipse(-r * 0.3, r * 0.35, 10, 6, 0.4, 0, TAU); ctx.fill();
    const leaf = ['#2e6b2e', '#3b8038', '#4c9444'];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + Math.sin(t + i) * 0.05;
      const rr = r * (0.85 + (i % 2) * 0.12);
      circle(Math.cos(a) * rr, Math.sin(a) * rr, r * 0.3, leaf[i % 3], '#1f4a1f', 2.5);
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.arc(Math.cos(a) * rr - 5, Math.sin(a) * rr - 5, r * 0.1, 0, TAU); ctx.fill();
      if (i % 4 === 0) circle(Math.cos(a) * rr + 4, Math.sin(a) * rr + 3, 3, '#ffd0e0');
    }
    const eyeR = 7 + up * 3;
    glow(r * 0.35, -r * 0.22, 18, 'rgba(180,255,106,A)', 0.6); glow(r * 0.35, r * 0.22, 18, 'rgba(180,255,106,A)', 0.6);
    circle(r * 0.35, -r * 0.22, eyeR, '#b4ff6a'); circle(r * 0.35, r * 0.22, eyeR, '#b4ff6a');
    ctx.fillStyle = '#1e120a'; ctx.beginPath(); ctx.ellipse(r * 0.6, 0, 5 + up * 5, 12, 0, 0, TAU); ctx.fill();
  } else if (key === 'lich') {
    const spin = atk >= 0 ? 5 : 1.5;
    for (let i = 0; i < 4; i++) {
      const a = t * spin + (i / 4) * TAU;
      glow(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 16, 'rgba(90,190,255,A)', 0.9);
      circle(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5, 4, '#e8fbff');
    }
    ctx.rotate(aim);
    ctx.fillStyle = '#2a1f3a'; ctx.strokeStyle = '#120c1c'; ctx.lineWidth = 4;
    ctx.beginPath();
    for (let i = 0; i < 18; i++) { const a = (i / 18) * TAU; const rr = r * (i % 2 ? 1.02 : 1.22) + Math.sin(t * 5 + i) * 4; ctx.lineTo(Math.cos(a) * rr - r * 0.15, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    const rg = ctx.createRadialGradient(-r * 0.1, 0, 2, -r * 0.1, 0, r);
    rg.addColorStop(0, 'rgba(120,80,200,0.5)'); rg.addColorStop(1, 'rgba(40,20,60,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(-r * 0.1, 0, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#d8b64a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(-r * 0.1, 0, r * 0.75, 2.2, 4.1); ctx.stroke();
    // staff raised while casting
    const sx = r * 0.3 + up * 10 + hitK * 18, sy = r * 0.9 - up * 20;
    ctx.strokeStyle = '#6b4428'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(sx - r * 0.9, sy + 6); ctx.lineTo(sx + r * 0.3, sy - 4); ctx.stroke();
    const orbR = 9 + up * 7 + hitK * 5;
    glow(sx + r * 0.35, sy - 5, orbR * 2.6, 'rgba(90,200,255,A)', 0.8);
    circle(sx + r * 0.35, sy - 5, orbR, '#c8f4ff', '#3a8ad0', 2);
    circle(r * 0.1, 0, r * 0.55, '#e9e4d6', '#8a8474', 3);
    const eye = atk >= 0 ? '#ffffff' : '#6ad8ff';
    circle(r * 0.35, -r * 0.2, 6, '#101018'); circle(r * 0.35, r * 0.2, 6, '#101018');
    glow(r * 0.35, -r * 0.2, 10, 'rgba(106,216,255,A)', 0.8); glow(r * 0.35, r * 0.2, 10, 'rgba(106,216,255,A)', 0.8);
    circle(r * 0.35, -r * 0.2, 3, eye); circle(r * 0.35, r * 0.2, 3, eye);
    ctx.fillStyle = '#2a2420'; ctx.fillRect(r * 0.5, -r * 0.14, 3 + up * 4, r * 0.28);
    ctx.fillStyle = '#ffd34a'; ctx.strokeStyle = '#8a6a10'; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 5; i++) { const a = -0.9 + i * 0.45 + Math.PI; ctx.lineTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55); ctx.lineTo(Math.cos(a + 0.22) * r * 0.88, Math.sin(a + 0.22) * r * 0.88); }
    ctx.stroke(); ctx.fill();
    circle(-r * 0.7, 0, 3, '#e0544a');
  } else if (key === 'hydra') {
    ctx.rotate(aim);
    ctx.strokeStyle = '#1f3a1d'; ctx.lineWidth = 16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-r * 0.9, 0); ctx.quadraticCurveTo(-r * 1.4, Math.sin(t * 2) * 25, -r * 1.7, Math.sin(t * 2 + 1) * 18); ctx.stroke();
    ctx.strokeStyle = '#4f8a45'; ctx.lineWidth = 10; ctx.stroke();
    circle(-r * 0.2, 0, r * 0.9, '#3e6b3a', '#1f3a1d', 5);
    ctx.strokeStyle = 'rgba(160,200,90,0.35)'; ctx.lineWidth = 2;
    for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; ctx.beginPath(); ctx.arc(-r * 0.2 + Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, 7, a - 1, a + 1); ctx.stroke(); }
    ctx.fillStyle = '#9ec26a'; ctx.beginPath(); ctx.ellipse(-r * 0.2, 0, r * 0.45, r * 0.3, 0, 0, TAU); ctx.fill();
    for (let h = -1; h <= 1; h++) {
      const ph = h * 2;
      const a = h * 0.75 + Math.sin(t * 2.3 + ph) * 0.12;
      const reach = r * (1.2 + (atk >= 0 ? hitK * 0.45 - up * 0.2 : 0) + walk * 0.03);
      const hx = Math.cos(a) * reach, hy = Math.sin(a) * reach;
      const cx1 = Math.cos(a) * r * 0.6 + Math.sin(t * 3 + h) * 10, cy1 = Math.sin(a) * r * 0.6;
      ctx.strokeStyle = '#1f3a1d'; ctx.lineWidth = 24; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(cx1, cy1, hx, hy); ctx.stroke();
      ctx.strokeStyle = '#4f8a45'; ctx.lineWidth = 18; ctx.stroke();
      ctx.strokeStyle = '#8cc876'; ctx.lineWidth = 4; ctx.stroke();
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(a);
      const open = atk >= 0 ? 0.25 + hitK * 0.35 : 0.08;
      ctx.fillStyle = '#3e6b3a'; ctx.strokeStyle = '#1f3a1d'; ctx.lineWidth = 3;
      ctx.save(); ctx.rotate(open); ctx.beginPath(); ctx.ellipse(12, 3, 16, 7, 0, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore();
      ctx.fillStyle = '#c83a3a'; ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(28, -open * 30); ctx.lineTo(28, open * 30); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#4f8a45';
      ctx.save(); ctx.rotate(-open); ctx.beginPath(); ctx.ellipse(12, -3, 17, 9, 0, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore();
      circle(8, -8, 3.5, '#ffe14a'); circle(8, 8, 3.5, '#ffe14a');
      tri(-6, -8, -14, -16, -2, -10, '#1f3a1d'); tri(-6, 8, -14, 16, -2, 10, '#1f3a1d');
      if (atk >= 0) circle(30, (Math.random() - 0.5) * 6, 2.5, '#8ad83a');
      ctx.restore();
    }
  } else if (key === 'colossus') {
    ctx.rotate(aim);
    const raise = up, slam = hitK;
    for (const s of [-1, 1]) {
      let fxp, fyp;
      if (atk >= 0 && slam > 0) { fxp = lerp(r * 0.2, r * 1.15, slam); fyp = s * lerp(r * 0.45, r * 1.0, slam); }
      else if (atk >= 0) { fxp = lerp(r * 0.55, r * 0.2, raise); fyp = s * lerp(r * 0.95, r * 0.45, raise); }
      else { fxp = r * 0.55 + walk * 8 * s; fyp = s * r * 0.95; }
      ctx.strokeStyle = '#5e584f'; ctx.lineWidth = 16; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, s * r * 0.55); ctx.lineTo(fxp, fyp); ctx.stroke(); ctx.lineCap = 'butt';
      const fr = r * 0.38 * (1 + raise * 0.15);
      circle(fxp, fyp, fr, '#8a8376', '#3e3a33', 4);
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.arc(fxp - fr * 0.3, fyp - fr * 0.3, fr * 0.4, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(60,54,48,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(fxp - fr * 0.5, fyp); ctx.lineTo(fxp + fr * 0.4, fyp - fr * 0.2); ctx.stroke();
    }
    // faceted body
    const pts = [];
    for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU; const rr = r * (0.88 + S.hash2(i, 5, 1) * 0.12); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    for (let i = 0; i < 9; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % 9];
      const lit = Math.cos(Math.atan2(p0[1] + p1[1], p0[0] + p1[0]) + 2.4);
      tri(0, 0, p0[0], p0[1], p1[0], p1[1], lit > 0.3 ? '#a8a192' : lit < -0.3 ? '#77706a' : '#8f887c');
    }
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    ctx.strokeStyle = '#3e3a33'; ctx.lineWidth = 5; ctx.stroke();
    ctx.fillStyle = '#6e8a4a'; polyRand(-r * 0.35, -r * 0.35, r * 0.28, 8, 7, 0.3); ctx.fill(); polyRand(-r * 0.4, r * 0.4, r * 0.2, 9, 7, 0.3); ctx.fill();
    const glowA = atk >= 0 ? 1 : 0.6 + Math.sin(t * 4) * 0.4;
    ctx.strokeStyle = `rgba(90,200,255,${glowA})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.1); ctx.lineTo(0, r * 0.2); ctx.lineTo(-r * 0.25, r * 0.4); ctx.moveTo(r * 0.1, -r * 0.45); ctx.lineTo(r * 0.3, -r * 0.2); ctx.stroke();
    circle(r * 0.5, 0, r * 0.26, '#8f887c', '#3e3a33', 3);
    glow(r * 0.55, -r * 0.1, 12, 'rgba(90,200,255,A)', glowA); glow(r * 0.55, r * 0.1, 12, 'rgba(90,200,255,A)', glowA);
    circle(r * 0.55, -r * 0.1, 4, '#dff6ff'); circle(r * 0.55, r * 0.1, 4, '#dff6ff');
  } else if (key === 'spiderqueen') {
    ctx.rotate(aim);
    ctx.strokeStyle = '#1a141e'; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) {
      const a = (i - 1.5) * 0.5;
      const step = (moving ? Math.sin(t * 10 + i * 1.6 + (sd > 0 ? Math.PI : 0)) : Math.sin(t * 2 + i)) * 0.15 - up * 0.25 * (i < 2 ? 1 : 0);
      const kx = Math.cos(a + step) * r * 0.95, ky = sd * (r * 0.75 + Math.abs(Math.sin(a)) * r * 0.35);
      ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(kx, ky); ctx.stroke();
      ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx * 1.35 + (i - 1.5) * 12, ky * 1.65); ctx.stroke();
      circle(kx, ky, 4, '#4a3f55');
    }
    ctx.lineCap = 'butt';
    ctx.fillStyle = '#2e2436'; ctx.strokeStyle = '#120c18'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(-r * 0.62, 0, r * 0.85, r * 0.72, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.beginPath(); ctx.ellipse(-r * 0.75, -r * 0.25, r * 0.45, r * 0.2, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d8342a';
    ctx.beginPath(); ctx.moveTo(-r * 1.0, -r * 0.18); ctx.lineTo(-r * 0.62, 0); ctx.lineTo(-r * 1.0, r * 0.18); ctx.lineTo(-r * 0.85, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-r * 0.25, -r * 0.18); ctx.lineTo(-r * 0.6, 0); ctx.lineTo(-r * 0.25, r * 0.18); ctx.lineTo(-r * 0.4, 0); ctx.closePath(); ctx.fill();
    circle(r * 0.28, 0, r * 0.48, '#4a3a58', '#120c18', 3.5);
    for (let i = 0; i < 5; i++) tri(r * 0.05 + i * 8 - 16, -r * 0.42, r * 0.05 + i * 8 - 12, -r * 0.62, r * 0.05 + i * 8 - 8, -r * 0.42, '#8a2a5a');
    const open = atk >= 0 ? 0.35 + hitK * 0.3 : 0.1;
    for (const sd of [-1, 1]) {
      ctx.save(); ctx.translate(r * 0.68, sd * 6); ctx.rotate(sd * open);
      ctx.fillStyle = '#e8e0d0'; ctx.beginPath(); ctx.moveTo(0, -3 * sd); ctx.quadraticCurveTo(14, 0, 18, 6 * sd); ctx.lineTo(4, 3 * sd); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    for (const [ex, ey, er] of [[0.55, -0.16, 4], [0.55, 0.16, 4], [0.45, -0.3, 3], [0.45, 0.3, 3], [0.62, -0.05, 2.5], [0.62, 0.05, 2.5], [0.38, -0.12, 2.5], [0.38, 0.12, 2.5]]) {
      circle(r * ex, r * ey, er + (atk >= 0 ? 1 : 0), atk >= 0 ? '#ff7a6a' : '#ff3a3a');
    }
  } else if (key === 'frostgiant') {
    glow(0, 0, r * 1.7, 'rgba(160,220,255,A)', 0.35);
    ctx.rotate(aim);
    // arms: raise a boulder overhead, then hurl it
    const armAng = atk >= 0 ? lerp(0.2, -1.1, up) + hitK * 1.6 : Math.sin(t * 2) * 0.1 + walk * 0.2;
    for (const sd of [-1, 1]) {
      const ax = Math.cos(armAng * sd * -1) * r * 1.0 * (atk >= 0 ? 0.6 + hitK * 0.6 : 1), ay = sd * r * (atk >= 0 ? lerp(0.95, 0.45, up) : 0.95);
      ctx.strokeStyle = '#9ec4dc'; ctx.lineWidth = 22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, sd * r * 0.55); ctx.lineTo(ax, ay); ctx.stroke(); ctx.lineCap = 'butt';
      circle(ax, ay, r * 0.26, '#cfe4f0', '#5a7890', 3);
    }
    if (atk >= 0 && hitK < 0.5) {
      const bx = r * (0.7 + hitK), by = 0;
      ctx.fillStyle = '#a8d8f0'; ctx.strokeStyle = '#4a7898'; ctx.lineWidth = 3; polyRand(bx, by, r * 0.45 * (1 + up * 0.2), 12, 8, 0.2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; polyRand(bx - 6, by - 6, r * 0.2, 13, 6, 0.3); ctx.fill();
    }
    ctx.fillStyle = '#d8eaf4'; ctx.strokeStyle = '#5a7890'; ctx.lineWidth = 5;
    polyRand(0, 0, r * 0.9, 51, 16, 0.08); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#b8d4e4'; for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, 7, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#6a7a8a'; ctx.fillRect(-r * 0.2, -r * 0.9, 10, r * 1.8);
    circle(r * 0.35, 0, r * 0.42, '#8ab0c8', '#3a5870', 3);
    for (let i = -2; i <= 2; i++) tri(r * 0.62, i * 6 - 3, r * 0.62, i * 6 + 3, r * 0.92 + (i % 2 ? 0 : 6), i * 6, '#e8f8ff');
    tri(r * 0.2, -r * 0.3, -r * 0.2, -r * 0.8, r * 0.3, -r * 0.4, '#c8b89a'); tri(r * 0.2, r * 0.3, -r * 0.2, r * 0.8, r * 0.3, r * 0.4, '#c8b89a');
    const eye = atk >= 0 ? '#ffffff' : '#7ae0ff';
    glow(r * 0.5, -r * 0.14, 10, 'rgba(120,220,255,A)', 0.8); glow(r * 0.5, r * 0.14, 10, 'rgba(120,220,255,A)', 0.8);
    circle(r * 0.5, -r * 0.14, 3.5, eye); circle(r * 0.5, r * 0.14, 3.5, eye);
  } else if (key === 'minotaur') {
    ctx.rotate(aim);
    const spin = atk >= 0 ? atk * TAU * 1.5 : 0;
    // great double axe
    ctx.save(); ctx.rotate(spin + (atk >= 0 ? 0 : 0.9 + walk * 0.1));
    ctx.fillStyle = '#6b4428'; ctx.fillRect(0, -3.5, r * 1.7, 7);
    ctx.fillStyle = '#d2d9e0'; ctx.strokeStyle = '#4a4f58'; ctx.lineWidth = 3;
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(r * 1.45, 0); ctx.quadraticCurveTo(r * 1.35, sd * r * 0.55, r * 1.75, sd * r * 0.6); ctx.quadraticCurveTo(r * 1.95, sd * r * 0.2, r * 1.75, 0); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.restore();
    if (atk >= 0) { ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - atk)})`; ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(0, 0, r * 1.7, spin - 1.4, spin); ctx.stroke(); }
    circle(0, 0, r * 0.85, '#7a4e2e', '#3a2414', 5);
    ctx.fillStyle = '#5a3820'; for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.beginPath(); ctx.ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, 7, 4, a, 0, TAU); ctx.fill(); }
    ctx.strokeStyle = '#c9a040'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 2.2, 4.1); ctx.stroke();
    const hx = r * (0.62 + (atk < 0 && moving ? 0.05 : 0));
    circle(hx, 0, r * 0.42, '#6a4226', '#3a2414', 3);
    ctx.fillStyle = '#efe0c0'; ctx.strokeStyle = '#8a7a5a'; ctx.lineWidth = 2;
    for (const sd of [-1, 1]) { ctx.beginPath(); ctx.moveTo(hx - 4, sd * r * 0.3); ctx.quadraticCurveTo(hx - r * 0.1, sd * r * 0.95, hx + r * 0.45, sd * r * 0.8); ctx.quadraticCurveTo(hx + r * 0.05, sd * r * 0.62, hx + 6, sd * r * 0.3); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = '#8a5a3a'; ctx.beginPath(); ctx.ellipse(hx + r * 0.32, 0, r * 0.22, r * 0.2, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(hx + r * 0.48, 0, 6, -1.4, 1.4); ctx.stroke();
    const eye = atk >= 0 ? '#ff5a3a' : '#ffb04a';
    circle(hx + r * 0.1, -r * 0.2, 3.5, eye); circle(hx + r * 0.1, r * 0.2, 3.5, eye);
  } else if (key === 'dragon') {
    ctx.rotate(aim);
    const flap = Math.sin(t * (atk >= 0 ? 9 : 4)) * (atk >= 0 ? 0.35 : 0.25) - up * 0.2;
    for (const s of [-1, 1]) {
      const tipX = -r * 0.2, tipY = s * r * (1.95 + flap);
      ctx.fillStyle = s < 0 ? '#8a1e14' : '#9a2418'; ctx.strokeStyle = '#3a0a06'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(r * 0.15, s * r * 0.3);
      ctx.lineTo(tipX, tipY); ctx.quadraticCurveTo(-r * 0.45, s * r * (1.35 + flap), -r * 0.62, s * r * (1.75 + flap));
      ctx.quadraticCurveTo(-r * 0.8, s * r * (1.2 + flap), -r * 0.98, s * r * (1.55 + flap));
      ctx.quadraticCurveTo(-r * 1.0, s * r * 0.9, -r * 0.6, s * r * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#4a0e08'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(r * 0.1, s * r * 0.3); ctx.lineTo(-r * 0.62, s * r * (1.75 + flap)); ctx.moveTo(r * 0.05, s * r * 0.3); ctx.lineTo(-r * 0.98, s * r * (1.55 + flap)); ctx.stroke();
      circle(tipX, tipY, 3, '#efe0c0');
    }
    ctx.strokeStyle = '#b8281a'; ctx.lineWidth = 18; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-r * 0.6, 0); ctx.quadraticCurveTo(-r * 1.3, Math.sin(t * 2) * 30, -r * 1.8, Math.sin(t * 2 + 1) * 20); ctx.stroke();
    ctx.lineCap = 'butt';
    ctx.save(); ctx.translate(-r * 1.8, Math.sin(t * 2 + 1) * 20); tri(-12, 0, 4, -9, 4, 9, '#efe0c0'); ctx.restore();
    ctx.fillStyle = '#c42e1e'; ctx.strokeStyle = '#4a0e08'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(-r * 0.1, 0, r * 0.8, r * 0.55, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.ellipse(-r * 0.2, -r * 0.2, r * 0.45, r * 0.18, 0, 0, TAU); ctx.fill();
    for (let i = 0; i < 6; i++) tri(-r * 0.7 + i * r * 0.22, -5, -r * 0.6 + i * r * 0.22, 0, -r * 0.7 + i * r * 0.22, 5, '#e8a040');
    const hx = r * (0.85 + up * 0.15 + hitK * 0.1);
    ctx.fillStyle = '#c42e1e';
    ctx.beginPath(); ctx.ellipse(hx, 0, r * 0.42, r * 0.3, 0, 0, TAU); ctx.fill(); ctx.stroke();
    const jaw = atk >= 0 ? 0.25 + hitK * 0.2 : 0;
    if (jaw) {
      glow(hx + r * 0.45, 0, 26 + hitK * 16, 'rgba(255,170,60,A)', 0.9);
      ctx.fillStyle = '#ffb040'; ctx.beginPath(); ctx.moveTo(hx + r * 0.1, 0); ctx.lineTo(hx + r * 0.5, -jaw * 40); ctx.lineTo(hx + r * 0.5, jaw * 40); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff1a0'; ctx.beginPath(); ctx.arc(hx + r * 0.35, 0, 5, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = '#efe0c0';
    tri(hx - r * 0.15, -r * 0.2, hx - r * 0.45, -r * 0.5, hx - r * 0.05, -r * 0.25, '#efe0c0');
    tri(hx - r * 0.15, r * 0.2, hx - r * 0.45, r * 0.5, hx - r * 0.05, r * 0.25, '#efe0c0');
    circle(hx + r * 0.1, -r * 0.12, 4, '#ffe14a'); circle(hx + r * 0.1, r * 0.12, 4, '#ffe14a');
    circle(hx + r * 0.36, -5, 1.5, '#3a0a06'); circle(hx + r * 0.36, 5, 1.5, '#3a0a06');
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
    case 'web': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 3);
      ctx.strokeStyle = 'rgba(240,240,240,0.9)'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) { const a2 = (i / 6) * TAU; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a2) * 12, Math.sin(a2) * 12); ctx.stroke(); }
      for (const rr of [5, 10]) { ctx.beginPath(); for (let i = 0; i <= 6; i++) { const a2 = (i / 6) * TAU; ctx.lineTo(Math.cos(a2) * rr, Math.sin(a2) * rr); } ctx.stroke(); }
      ctx.restore();
      break;
    }
    case 'snowball': circle(x, y, 11, '#f4f8fa', '#9ab4c8', 2.5); circle(x - 3, y - 3, 4, '#ffffff'); break;
    case 'iceboulder':
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 4);
      ctx.fillStyle = '#a8d8f0'; ctx.strokeStyle = '#4a7898'; ctx.lineWidth = 3; polyRand(0, 0, 26, 12, 8, 0.2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)'; polyRand(-6, -6, 10, 13, 6, 0.3); ctx.fill();
      ctx.restore();
      break;
    case 'shard':
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = '#c8f0ff'; ctx.strokeStyle = '#4a98c8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(0, -6); ctx.lineTo(-10, 0); ctx.lineTo(0, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      break;
    case 'bolt_x': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(6, 0); ctx.stroke();
      ctx.fillStyle = '#c8d0d8'; ctx.fillRect(4, -3, 7, 6);
      ctx.fillStyle = mine ? '#8fd0ff' : '#ff8a7a'; ctx.fillRect(-14, -3, 4, 6);
      ctx.restore();
      break;
    }
    case 'bigbolt': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      const g = ctx.createLinearGradient(-60, 0, 10, 0); g.addColorStop(0, 'rgba(255,230,120,0)'); g.addColorStop(1, 'rgba(255,240,170,0.9)');
      ctx.strokeStyle = g; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(-60, 0); ctx.lineTo(8, 0); ctx.stroke();
      ctx.strokeStyle = '#5a3820'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-20, 0); ctx.lineTo(10, 0); ctx.stroke();
      ctx.fillStyle = '#fff4b0'; ctx.beginPath(); ctx.moveTo(22, 0); ctx.lineTo(8, -7); ctx.lineTo(8, 7); ctx.fill();
      ctx.restore();
      break;
    }
    case 'dagger': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(t * 22);
      ctx.fillStyle = '#d2d9e0'; ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(-6, -2.5); ctx.lineTo(12, 0); ctx.lineTo(-6, 2.5); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c0392b'; ctx.fillRect(-10, -2, 4, 4);
      ctx.restore();
      break;
    }
    case 'thorn': {
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = '#4f9a47'; ctx.strokeStyle = '#1f4a1f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -6); ctx.lineTo(-4, 0); ctx.lineTo(-8, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#9ada74'; ctx.beginPath(); ctx.ellipse(-8, -7, 4, 2, -0.4, 0, TAU); ctx.fill();
      ctx.restore();
      break;
    }
    case 'holy': {
      const g = ctx.createRadialGradient(x, y, 1, x, y, 20);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#fff0a0'); g.addColorStop(0.7, 'rgba(255,210,80,0.5)'); g.addColorStop(1, 'rgba(255,200,60,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 20, 0, TAU); ctx.fill();
      if (Math.random() < 0.35) particles.push({ x, y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, t: 0, life: 0.35, c: '#fff4b0', s: 4 });
      break;
    }
    default: circle(x, y, 8, '#fff');
  }
}
// =================================================================== main render
let lastFrame = performance.now();
let menuT = 0;
let lastMood = 0;
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
      const flags = heroFlags(myRow);
      flags.recall = me.rc > 0;
      const fl = hurtFlash.has(myId) ? Math.max(0, 1 - (now - hurtFlash.get(myId)) / 150) : 0;
      const moving = !!(lastInput && (lastInput.mx || lastInput.my));
      drawHero(cam.x, cam.y, myType(), myAim, 0, anim, flags, t, fl, moving);
      names.push({ x: cam.x, y: cam.y, r: S.heroDef(myType()).r, hp: Math.round((me.hp / me.mhp) * 100), rel: 0, id: myId, hero: true });
      continue;
    }
    const u = d.u, row = u.row;
    const id = row[0];
    const anim = atkAnim.has(id) ? (now - atkAnim.get(id)) / 300 : 9;
    const fl = hurtFlash.has(id) ? Math.max(0, 1 - (now - hurtFlash.get(id)) / 150) : 0;
    if (row[1] === 'h') {
      drawHero(u.x, u.y, row[2], u.aim, row[7], anim, heroFlags(row), t, fl, u.mv);
      names.push({ x: u.x, y: u.y, r: S.heroDef(row[2]).r, hp: row[6], rel: row[7], id, hero: true });
    } else if (row[1] === 'm') {
      drawMob(u.x, u.y, row[2], u.aim, anim, t, row[11], fl, id);
      if (row[6] < 100) names.push({ x: u.x, y: u.y, r: S.MOBS[row[2]].r, hp: row[6], rel: 3 });
    } else if (row[1] === 'k') {
      drawAlly(u.x, u.y, row[2], u.aim, row[7], anim, fl, t, u.mv, id, row[12]);
      if (row[6] < 100) names.push({ x: u.x, y: u.y, r: (S.ALLY_UNITS[row[2]] || S.KNIGHT).r, hp: row[6], rel: row[7] });
    } else if (row[1] === 'B') {
      drawBoss(u.x, u.y, row[2], u.aim, row[8], t, fl, atkAnim.has(id) ? now - atkAnim.get(id) : 1e9, u.mv);
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
  drawBolts(dt);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt;
    if (p.t > p.life) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.smoke) { ctx.globalAlpha = (1 - p.t / p.life) * 0.7; circle(p.x, p.y, p.s * (0.6 + p.t / p.life), p.c); continue; }
    p.vx *= 0.92; p.vy *= 0.92;
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
    const fs = f.size * (k < 0.15 ? 0.8 + k * 1.4 : 1);
    label(f.s, f.x, f.y - k * 40, fs, f.color, true);
    if (f.icon) {
      const im = iconImg(f.icon);
      if (im.complete) ctx.drawImage(im, f.x + ctx.measureText(f.s).width / 2 + 2, f.y - k * 40 - fs, fs * 1.15, fs * 1.15);
    }
  }
  ctx.globalAlpha = 1;

  // screen space
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (typeof AUDIO !== 'undefined') { AUDIO.setView(cam.x, cam.y); if (now - lastMood > 500) { lastMood = now; AUDIO.setMood(currentMood(nearBoss, now)); } }
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
function heroFlags(row) {
  if (!row) return {};
  const f = row[14] || 0;
  return { invuln: row[9], slow: row[10], recall: row[11], tier: row[13], stealth: f & 1, bastion: f & 2, shield: f & 4, rage: f & 8 };
}

// music follows the situation: menu, biome themes, or battle near bosses / enemy heroes
let lastCombat = -1e9;
function currentMood(nearBoss, now) {
  if (!joined) return 'menu';
  if (nearBoss && nearBoss.d < 1300) return 'battle';
  if (now - lastCombat < 6000) return 'battle';
  const b = biomeAtPos(cam.x, cam.y);
  return ['peace', 'peace', 'high', 'cold', 'swamp', 'volcano'][b];
}

// jagged lightning between two points
const bolts = [];
function drawBolts(dt) {
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    b.t += dt;
    if (b.t > b.life) { bolts.splice(i, 1); continue; }
    const k = 1 - b.t / b.life;
    const pts = [[b.x1, b.y1]];
    const n = 7;
    for (let j = 1; j < n; j++) pts.push([lerp(b.x1, b.x2, j / n) + b.j[j % b.j.length] * 3, lerp(b.y1, b.y2, j / n) + b.j[(j + 3) % b.j.length] * 3]);
    pts.push([b.x2, b.y2]);
    for (const [w, c] of [[9, `rgba(80,180,255,${0.35 * k})`], [3, `rgba(235,250,255,${k})`]]) {
      ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineJoin = 'round';
      ctx.beginPath(); pts.forEach((p, idx) => (idx ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    }
  }
}

// ---- vector icons (rendered once to images for the DOM HUD)
let iconMode = false;
const urlCache = new Map();
function renderURL(key, w, h, fn) {
  let u = urlCache.get(key);
  if (u) return u;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const real = ctx;
  ctx = c.getContext('2d');
  iconMode = true;
  try { fn(); } finally { ctx = real; iconMode = false; }
  u = c.toDataURL();
  urlCache.set(key, u);
  return u;
}
const OUTL = '#2b2138';
function iconPath(fill, lw) { ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = OUTL; ctx.lineWidth = lw || 2.5; ctx.stroke(); }
const ICON_DRAW = {
  food() { drumstick(17, 17, 0.95); },
  cow() {
    ctx.beginPath(); ctx.ellipse(16, 17, 11, 10, 0, 0, TAU); iconPath('#f4efe6');
    ctx.fillStyle = '#2e2626'; ctx.beginPath(); ctx.ellipse(11, 12, 4, 3, 0.4, 0, TAU); ctx.fill();
    tri(6, 11, 2, 5, 9, 8, '#f2e6c8'); tri(26, 11, 30, 5, 23, 8, '#f2e6c8');
    ctx.beginPath(); ctx.ellipse(16, 23, 7, 5, 0, 0, TAU); iconPath('#f2b0a8', 2);
    circle(13.5, 23, 1.3, '#6a3a36'); circle(18.5, 23, 1.3, '#6a3a36');
    circle(12, 16, 1.6, OUTL); circle(20, 16, 1.6, OUTL);
  },
  wood() {
    roundRect(3, 10, 22, 13, 5); iconPath('#9a6838');
    ctx.strokeStyle = 'rgba(60,35,15,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(6, 14); ctx.lineTo(18, 14); ctx.moveTo(8, 19); ctx.lineTo(20, 19); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(24, 16.5, 5.5, 6.5, 0, 0, TAU); iconPath('#e0b27a');
    ctx.strokeStyle = '#a8764a'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(24, 16.5, 2.5, 3.2, 0, 0, TAU); ctx.stroke();
  },
  stone() {
    ctx.beginPath(); ctx.moveTo(4, 22); ctx.lineTo(7, 11); ctx.lineTo(15, 6); ctx.lineTo(24, 9); ctx.lineTo(28, 19); ctx.lineTo(22, 26); ctx.lineTo(9, 26); ctx.closePath(); iconPath('#a8a192');
    ctx.fillStyle = '#d6d0c2'; ctx.beginPath(); ctx.moveTo(8, 12); ctx.lineTo(15, 8); ctx.lineTo(19, 12); ctx.lineTo(11, 16); ctx.closePath(); ctx.fill();
  },
  gold() {
    ctx.beginPath(); ctx.arc(16, 16, 11, 0, TAU); iconPath('#ffd34a');
    ctx.strokeStyle = '#c9922a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(16, 16, 7, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#fff4b0'; ctx.beginPath(); ctx.ellipse(12, 11, 3, 2, -0.6, 0, TAU); ctx.fill();
  },
  glory() { ctx.fillStyle = '#ffd34a'; ctx.strokeStyle = OUTL; ctx.lineWidth = 2.5; star(16, 16.5, 12); },
  skull() {
    ctx.beginPath(); ctx.arc(16, 14, 10, 0, TAU); iconPath('#efeadc');
    roundRect(10, 20, 12, 7, 2); iconPath('#efeadc', 2);
    circle(12, 14, 3, OUTL); circle(20, 14, 3, OUTL);
  },
  dragon() {
    ctx.beginPath(); ctx.ellipse(17, 18, 11, 8, -0.2, 0, TAU); iconPath('#d8382a');
    tri(9, 13, 5, 3, 13, 11, '#efe0c0'); tri(17, 11, 17, 2, 21, 11, '#efe0c0');
    circle(21, 16, 2.5, '#ffe14a');
  },
  eye() {
    ctx.beginPath(); ctx.moveTo(3, 16); ctx.quadraticCurveTo(16, 3, 29, 16); ctx.quadraticCurveTo(16, 29, 3, 16); iconPath('#f6f3ea');
    circle(16, 16, 5.5, '#3a8ad0', OUTL, 2); circle(16, 16, 2.5, OUTL);
  },
  fire() {
    ctx.beginPath(); ctx.moveTo(16, 3); ctx.quadraticCurveTo(27, 15, 23, 24); ctx.quadraticCurveTo(16, 31, 9, 24); ctx.quadraticCurveTo(5, 15, 16, 3); iconPath('#ff7a2d');
    ctx.fillStyle = '#ffe07a'; ctx.beginPath(); ctx.moveTo(16, 12); ctx.quadraticCurveTo(21, 19, 19, 24); ctx.quadraticCurveTo(16, 27, 13, 24); ctx.quadraticCurveTo(11, 19, 16, 12); ctx.fill();
  },
  swords() {
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(16, 16); ctx.rotate(s * Math.PI / 4);
      roundRect(-2, -13, 4, 20, 1.5); iconPath('#d2d9e0', 2);
      ctx.fillStyle = '#c9922a'; ctx.fillRect(-5, 6, 10, 3); ctx.fillStyle = '#6b4428'; ctx.fillRect(-1.5, 9, 3, 5);
      ctx.restore();
    }
  },
  home() {
    ctx.beginPath(); ctx.moveTo(4, 15); ctx.lineTo(16, 4); ctx.lineTo(28, 15); ctx.closePath(); iconPath('#e0544a');
    ctx.beginPath(); ctx.rect(7, 15, 18, 13); iconPath('#e8d4a8');
    ctx.beginPath(); ctx.rect(13, 19, 6, 9); iconPath('#8a5a30', 2);
  },
  dash() {
    ctx.strokeStyle = '#dfe8ff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const y of [9, 16, 23]) { ctx.beginPath(); ctx.moveTo(3 + (y === 16 ? 0 : 4), y); ctx.lineTo(18, y); ctx.stroke(); }
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(18, 6); ctx.lineTo(29, 16); ctx.lineTo(18, 26); ctx.closePath(); iconPath('#c8d0d8');
  },
  volley() {
    for (const a of [-0.45, 0, 0.45]) {
      ctx.save(); ctx.translate(6, 16); ctx.rotate(a);
      ctx.strokeStyle = '#8a5a30'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(19, 0); ctx.stroke();
      tri(19, -4, 19, 4, 26, 0, '#d2d9e0'); tri(0, -3, 0, 3, 4, 0, '#e0544a');
      ctx.restore();
    }
  },
  nova() {
    ctx.strokeStyle = '#78e0ff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; ctx.beginPath(); ctx.moveTo(16, 16); ctx.lineTo(16 + Math.cos(a) * 12, 16 + Math.sin(a) * 12); ctx.stroke(); ctx.beginPath(); ctx.moveTo(16 + Math.cos(a) * 7, 16 + Math.sin(a) * 7); ctx.lineTo(16 + Math.cos(a + 0.5) * 10, 16 + Math.sin(a + 0.5) * 10); ctx.stroke(); }
    ctx.lineCap = 'butt'; circle(16, 16, 3.5, '#ffffff');
  },
  charge() {
    ctx.save(); ctx.translate(16, 16); ctx.rotate(-Math.PI / 4);
    roundRect(-13, -2, 22, 4, 1.5); iconPath('#c89060', 2);
    tri(9, -5, 9, 5, 16, 0, '#e8ecf2'); tri(-8, -2, -8, -10, -1, -6, '#3f9ff5');
    ctx.restore();
    ctx.strokeStyle = '#dfe8ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(3, 20); ctx.lineTo(10, 20); ctx.moveTo(6, 26); ctx.lineTo(13, 26); ctx.stroke();
  },
  bastion() {
    ctx.beginPath(); ctx.moveTo(6, 5); ctx.lineTo(26, 5); ctx.lineTo(26, 16); ctx.quadraticCurveTo(26, 25, 16, 29); ctx.quadraticCurveTo(6, 25, 6, 16); ctx.closePath(); iconPath('#3f9ff5');
    ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(16, 8); ctx.lineTo(16, 25); ctx.moveTo(9, 14); ctx.lineTo(23, 14); ctx.stroke();
  },
  rage() {
    ctx.beginPath(); ctx.arc(16, 17, 11, 0, TAU); iconPath('#e0544a');
    ctx.strokeStyle = OUTL; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(9, 12); ctx.lineTo(14, 15); ctx.moveTo(23, 12); ctx.lineTo(18, 15); ctx.moveTo(11, 23); ctx.quadraticCurveTo(16, 19, 21, 23); ctx.stroke();
    tri(7, 9, 4, 2, 11, 7, '#efe0c0'); tri(25, 9, 28, 2, 21, 7, '#efe0c0');
  },
  deadshot() {
    ctx.strokeStyle = '#e0544a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(16, 16, 10, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(16, 16, 4, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16, 2); ctx.lineTo(16, 9); ctx.moveTo(16, 23); ctx.lineTo(16, 30); ctx.moveTo(2, 16); ctx.lineTo(9, 16); ctx.moveTo(23, 16); ctx.lineTo(30, 16); ctx.stroke();
  },
  pack() {
    tri(7, 13, 6, 2, 14, 9, '#8a8e96'); tri(25, 13, 26, 2, 18, 9, '#8a8e96');
    ctx.beginPath(); ctx.moveTo(6, 12); ctx.quadraticCurveTo(16, 4, 26, 12); ctx.lineTo(20, 26); ctx.quadraticCurveTo(16, 30, 12, 26); ctx.closePath(); iconPath('#a0a4ac');
    circle(12, 15, 2, '#ffd34a'); circle(20, 15, 2, '#ffd34a'); circle(16, 25, 2.5, OUTL);
  },
  shadow() {
    ctx.beginPath(); ctx.arc(16, 16, 12, 0, TAU); iconPath('#3d2f4d');
    ctx.fillStyle = '#6a4a8a'; ctx.beginPath(); ctx.arc(20, 13, 9, 0, TAU); ctx.fill();
    circle(11, 17, 2.2, '#ff3a3a'); circle(17, 17, 2.2, '#ff3a3a');
  },
  storm() {
    ctx.beginPath(); ctx.moveTo(19, 2); ctx.lineTo(8, 18); ctx.lineTo(15, 18); ctx.lineTo(12, 30); ctx.lineTo(25, 12); ctx.lineTo(17, 12); ctx.closePath(); iconPath('#ffd34a');
  },
  roots() {
    ctx.strokeStyle = '#6b4428'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(16, 29); ctx.quadraticCurveTo(9, 20, 16, 13); ctx.quadraticCurveTo(22, 7, 15, 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16, 29); ctx.lineTo(7, 29); ctx.moveTo(16, 29); ctx.lineTo(25, 28); ctx.stroke(); ctx.lineCap = 'butt';
    for (const [x, y, a] of [[10, 16, -0.6], [21, 11, 0.6], [18, 21, 0.3]]) { ctx.beginPath(); ctx.ellipse(x, y, 5, 2.8, a, 0, TAU); iconPath('#66b84c', 1.5); }
  },
  bless() {
    ctx.strokeStyle = '#ffd34a'; ctx.lineWidth = 2.5;
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; ctx.beginPath(); ctx.moveTo(16 + Math.cos(a) * 10, 16 + Math.sin(a) * 10); ctx.lineTo(16 + Math.cos(a) * 14, 16 + Math.sin(a) * 14); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(16, 16, 7.5, 0, TAU); iconPath('#fff0a8');
  },
  music() {
    ctx.fillStyle = '#f4ecd8'; ctx.strokeStyle = OUTL; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(10, 24, 5, 4, -0.4, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(23, 21, 5, 4, -0.4, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillRect(13.5, 6, 3, 18); ctx.fillRect(26.5, 4, 3, 17);
    ctx.beginPath(); ctx.moveTo(13.5, 6); ctx.lineTo(29.5, 3); ctx.lineTo(29.5, 8); ctx.lineTo(13.5, 11); ctx.closePath(); ctx.fill();
  },
  sound() {
    ctx.beginPath(); ctx.moveTo(4, 12); ctx.lineTo(10, 12); ctx.lineTo(17, 5); ctx.lineTo(17, 27); ctx.lineTo(10, 20); ctx.lineTo(4, 20); ctx.closePath(); iconPath('#f4ecd8', 2);
    ctx.strokeStyle = '#f4ecd8'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(18, 16, 6, -0.9, 0.9); ctx.stroke(); ctx.beginPath(); ctx.arc(18, 16, 11, -0.9, 0.9); ctx.stroke();
  },
};
function iconURL(name) { return renderURL('i:' + name, 32, 32, () => ICON_DRAW[name]()); }
const imgCache = new Map();
function iconImg(name) {
  let im = imgCache.get(name);
  if (!im) { im = new Image(); im.src = iconURL(name); imgCache.set(name, im); }
  return im;
}
function buildingURL(type) {
  return renderURL('b:' + type, 64, 64, () => {
    const size = S.BUILDINGS[type].size;
    const k = Math.min(1.2, 58 / (size + 20));
    ctx.translate(30, 30); ctx.scale(k, k);
    drawBuilding({ type, x: 0, y: 0, hs: size / 2, lvl: 1, hp: 100, rel: 0, aim: -0.6 }, 0.6);
  });
}
function heroURL(type) {
  return renderURL('h:' + type, 110, 90, () => {
    ctx.translate(46, 45);
    ctx.scale(0.95, 0.95);
    drawHero(0, 0, type, -0.35, 0, 9, {}, 0.6, 0, false);
  });
}
function findMyRow(world) {
  for (const u of world.units) if (u.row[0] === myId && u.row[1] === "h") return u.row;
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
function resObj() { const o = {}; S.RES.forEach((r, i) => { o[r] = pf.res[i] || 0; }); return o; }
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
    const def = S.BOSSES[b[0]];
    if (!def) continue;
    const im = iconImg(def.key === 'dragon' ? 'dragon' : 'skull');
    mm.globalAlpha = b[1] ? 1 : 0.35;
    mm.imageSmoothingEnabled = false;
    if (im.complete) mm.drawImage(im, Math.round(def.x * k - im.width / 2), Math.round(def.y * k - im.height / 2));
    mm.globalAlpha = 1;
  }
  for (const cp of info.camps || []) {
    mm.globalAlpha = cp[2] ? 1 : 0.35;
    mm.fillStyle = FACTION_COL[cp[3]]; mm.strokeStyle = '#000'; mm.lineWidth = 1;
    mm.beginPath(); mm.moveTo(cp[0] * k, cp[1] * k - 5); mm.lineTo(cp[0] * k + 5, cp[1] * k + 4); mm.lineTo(cp[0] * k - 5, cp[1] * k + 4); mm.closePath(); mm.fill(); mm.stroke();
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
function ico(name, cls) { return `<img class="${cls || 'ico'}" src="${iconURL(name)}" alt="">`; }
function bldIco(type) { return `<img class="bico" src="${buildingURL(type)}" alt="">`; }
function costStr(cost) {
  const parts = [];
  for (const k of S.RES) if (cost[k]) parts.push(`${cost[k]}${ico(k)}`);
  return parts.join(' ') || 'бесплатно';
}
// server messages still use emoji; swap them for pixel icons
const EMOJI_ICONS = { '🍖': 'food', '🐄': 'cow', '🪵': 'wood', '🪨': 'stone', '🪙': 'gold', '⚔': 'swords', '☠': 'skull', '🔥': 'fire', '👁': 'eye', '✦': 'glory' };
function richText(m) {
  let out = esc(m);
  for (const [e, n] of Object.entries(EMOJI_ICONS)) out = out.split(e).join(ico(n));
  return out.replace(/\uFE0F/g, '');
}

// build bar
function renderBuildBar() {
  const bar = $('buildbar');
  if (!bar.children.length) {
    S.BUILD_ORDER.forEach((type, i) => {
      const d = S.BUILDINGS[type];
      const b = el('div', 'bslot');
      b.dataset.type = type;
      b.innerHTML = `<span class="k">F${i + 1}</span><span class="c"></span><span class="bimg">${bldIco(type)}</span><span class="cost"></span>`;
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
      cnt = '';
    } else {
      const cap = pf.th ? S.CAPS[type][pf.th[2] - 1] : 0;
      const n = (pf.counts || {})[type] || 0;
      cnt = pf.th ? `${n}/${cap}` : '';
      ok = !!pf.th && n < cap;
    }
    ok = ok && S.canAfford(resObj(), cost);
    b.classList.toggle('no', !ok);
    b.querySelector('.c').textContent = cnt;
    const ch = type === 'townhall' && pf.th ? 'построена' : costStr(cost);
    const cel = b.querySelector('.cost');
    if (cel.dataset.v !== ch) { cel.dataset.v = ch; cel.innerHTML = ch; }
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
    row.appendChild(el('span', 'skey', String(i + 1)));
    row.appendChild(el('span', 'sname', s.name));
    const bar = el('div', 'sbar');
    for (let j = 0; j < S.STAT_MAX; j++) { const c = el('i'); if (j < pf.st[i]) c.style.background = s.color; bar.appendChild(c); }
    row.appendChild(bar);
    const btn = el('button', '', '+');
    btn.disabled = pf.pts <= 0 || pf.st[i] >= S.STAT_MAX;
    btn.onclick = () => { send({ t: 'stat', i }); AUDIO.play('click'); };
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function updateHud() {
  if (!pf) return;
  const cap = pf.cap;
  const resHtml = S.RES.map((r, i) => `<div class="r ${pf.res[i] >= cap ? 'full' : ''}">${ico(r, 'rico')} ${pf.res[i]}</div>`).join('') +
    `<div class="cap">склад ${cap}</div><div class="r glory">${ico('glory', 'rico')} ${pf.glory}</div>`;
  if ($('res').dataset.v !== resHtml) { $('res').dataset.v = resHtml; $('res').innerHTML = resHtml; }
  const xpPct = pf.lvl >= S.MAX_LVL ? 100 : (pf.xp / pf.xpn) * 100;
  $('xpfill').style.width = xpPct + '%';
  $('xptext').textContent = `Ур. ${pf.lvl} · ${S.heroDef(myType()).name}` + (pf.lvl < S.MAX_LVL ? ` · ${pf.xp}/${pf.xpn}` : ' · МАКС');
  updateEvolve();
  renderStats();
  renderBuildBar();
  if (me) {
    const k = me.cd / me.cdm;
    $('ability').querySelector('.ab-cd').style.background = k > 0 ? `linear-gradient(to top, transparent ${(1 - k) * 100}%, rgba(10,6,14,0.7) 0)` : 'transparent';
    $('ability').style.borderColor = k > 0 ? '#1b1420' : '#ffd34a';
    $('ability').title = `${S.heroDef(myType()).ability.name} (Пробел / ПКМ)`;
  }
  if ($('ability').dataset.cls !== myType()) {
    $('ability').dataset.cls = myType();
    $('ability').innerHTML = `${ico(S.heroDef(myType()).icon, 'abico')}<div class="ab-cd"></div><span class="ab-key">Space</span>`;
  }
  if (!$('recall').dataset.v) { $('recall').dataset.v = 1; $('recall').innerHTML = `${ico('home', 'abico')}<span class="ab-key">R</span>`; }
  $('recall').style.opacity = pf.th ? 1 : 0.35;
  $('biome').textContent = S.BIOME_NAMES[biomeAtPos(cam.x, cam.y)];
}
$('recall').onclick = () => send({ t: 'recall' });

// class evolution at level 10
function updateEvolve() {
  const box = $('evolve');
  const show = pf && pf.lvl >= S.EVOLVE_LVL && !pf.sub && !dead;
  box.classList.toggle('hidden', !show);
  if (!show) { box.dataset.cls = ''; return; }
  if (box.dataset.cls === pf.cls) return;
  box.dataset.cls = pf.cls;
  const cards = $('evolve-cards');
  cards.innerHTML = '';
  for (const [key, d] of Object.entries(S.SUBCLASSES)) {
    if (d.base !== pf.cls) continue;
    const c = el('div', 'evo');
    c.innerHTML = `<img class="evo-img" src="${heroURL(key)}" alt=""><b>${d.name}</b><span>${d.desc}</span><em>${ico('glory')} 20 ур.: ${d.desc20}</em>`;
    c.onclick = () => send({ t: 'evolve', sub: key });
    cards.appendChild(c);
  }
}

function renderLeaderboard() {
  const list = $('lb-list');
  list.innerHTML = '';
  info.lb.forEach((r, i) => {
    const row = el('div', `lb-row ${r[5] === myId ? 'me' : ''} ${r[4] ? '' : 'off'}`);
    row.innerHTML = `<span>${i + 1}.</span><span class="n">${r[1] ? `[${esc(r[1])}] ` : ''}${esc(r[0])} <small>ур.${r[2]}</small></span><span class="g">${r[3]}</span>`;
    list.appendChild(row);
  });
  $('online').textContent = `Онлайн: ${info.online}` + (info.bots ? ` · ботов: ${info.bots}` : '');
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
    html = `<div class="tt-t">${d.name}</div><div>${d.desc}</div><div class="tt-k">${costStr(cost)}</div>`;
    const r = document.querySelector(`.bslot[data-type="${buildHover}"]`).getBoundingClientRect();
    tt.style.left = Math.min(W - 290, r.left) + 'px';
    tt.style.top = (r.top - 90) + 'px';
  } else if (hovered && !buildMode) {
    const s = hovered;
    const d = S.BUILDINGS[s.type];
    const owner = info.names[s.pid];
    html = `<div class="tt-t">${d.name} · ур. ${s.lvl}</div>`;
    if (s.rel === 0) {
      let up;
      if (s.type === 'townhall') up = s.lvl < S.TH_MAX ? S.thUpgradeCost(s.lvl + 1) : null;
      else up = s.lvl < S.BLD_MAX ? S.bldUpgradeCost(s.type, s.lvl + 1) : null;
      const blocked = s.type !== 'townhall' && pf && pf.th && s.lvl >= pf.th[2];
      html += up ? `<div><span class="tt-k">[E]</span> улучшить: ${costStr(up)}${blocked ? ' <span class="tt-m">(нужна ратуша выше)</span>' : ''}</div>` : '<div class="tt-m">Максимальный уровень</div>';
      if (s.type !== 'townhall') html += '<div><span class="tt-k">[X×2]</span> снести (вернёт 50%)</div>';
      if (s.type === 'farmhouse') html += `<div class="tt-m">Крестьян до ${S.peasantCap(s.lvl)} · найм ${S.PEASANT.hire}${ico('food')} · каждый ест 1${ico('food')} в ${S.PEASANT.eatEvery} с</div>`;
      if (s.type === 'townhall') html += `<div class="tt-m">Радиус базы ${S.thRadius(s.lvl)}, склад ${S.resCap(s.lvl)}</div>`;
    } else {
      html += s.rel === 3 && s.faction >= 0
        ? `<div class="tt-m">${S.FACTIONS[s.faction].name}</div>${s.type === 'npc_hall' ? '<div class="tt-m">Снесите — и заберёте богатую добычу</div>' : ''}`
        : `<div class="tt-m">${s.rel === 1 ? 'Союзник' : 'Враг'}: ${owner ? esc(owner[0]) : '???'}</div>`;
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
  it.innerHTML = richText(m);
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
    const pg = p.cv.getContext('2d');
    pg.setTransform(1, 0, 0, 1, 0, 0);
    pg.clearRect(0, 0, p.cv.width, p.cv.height);
    pg.translate(38, 36);
    const real = ctx;
    ctx = pg; iconMode = true;
    try { drawHero(0, 0, p.cls, Math.sin(t * 1.5) * 0.4, 0, (t * 1000 % 1400) / 350, {}, t, 0, false); } finally { ctx = real; iconMode = false; }
  }
}

function renderAudioButtons() {
  const mb = $('mus'), sb = $('snd');
  if (!mb) return;
  mb.innerHTML = ico('music', 'abico'); sb.innerHTML = ico('sound', 'abico');
  mb.classList.toggle('off', !AUDIO.settings.musicOn); sb.classList.toggle('off', !AUDIO.settings.sfxOn);
  $('vol-music').value = AUDIO.settings.music; $('vol-sfx').value = AUDIO.settings.sfx;
}
$('mus').onclick = () => { AUDIO.init(); AUDIO.toggle('musicOn'); renderAudioButtons(); };
$('snd').onclick = () => { AUDIO.init(); AUDIO.toggle('sfxOn'); renderAudioButtons(); };
$('vol-music').oninput = (e) => { AUDIO.set('music', +e.target.value); AUDIO.set('musicOn', true); renderAudioButtons(); };
$('vol-sfx').oninput = (e) => { AUDIO.set('sfx', +e.target.value); AUDIO.set('sfxOn', true); renderAudioButtons(); AUDIO.play('coin'); };
// browsers only allow audio after a user gesture
const unlockAudio = () => { AUDIO.init(); };
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

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
  $('deathby').textContent = `Убийца: ${deathInfo.by}` + (deathInfo.lost ? ` · потеряно ${deathInfo.lost} золота` : '');
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
renderAudioButtons();
resize();
connect();
requestAnimationFrame(frame);
setInterval(() => { if (!joined || $('menu').offsetParent || !$('death').classList.contains('hidden')) drawPreviews(performance.now() / 1000); }, 50);
