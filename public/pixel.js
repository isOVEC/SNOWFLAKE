/* global S */
'use strict';
// Procedural pixel-art generator. Every sprite in the game is produced here at load time:
// small characters come from text grids, everything else is painted with a tiny pixel
// "brush" API (shaded balls, polygons, bricks) and gets an automatic 1px outline.
// 1 art pixel = 3 world units.
const PIX = (() => {
  const ART = 3;
  const OUT = '#1b1420';
  const PAL = {
    k: OUT, w: '#f4f1e8', s: '#f2c79a', S: '#c98e62', g: '#c8d0d8', G: '#8a94a0', H: '#545c68',
    b: '#8a5a30', B: '#5a3820', n: '#b88050', y: '#ffd34a', Y: '#c08a20', r: '#d8483a', R: '#8a2a20',
    l: '#5cae44', L: '#2e6b2e', m: '#8fd46a', p: '#8e5cd0', P: '#4a2a70', q: '#c8a0ff', c: '#6ad8ff',
    C: '#2a5a9a', o: '#ff9a3d', O: '#c05a1a', e: '#101018', z: '#e9e4d6', Z: '#b8b09a', x: '#9c9282',
    X: '#5e564b', v: '#c0b8a8', a: '#ffe89a', f: '#ff6a3d',
  };
  const TEAM = [
    { T: '#3d9df3', t: '#1f5a9a', U: '#9fd4ff' },
    { T: '#45c46a', t: '#1f7a3a', U: '#a8f0b8' },
    { T: '#e8514a', t: '#8a2420', U: '#ffb0a8' },
    { T: '#9a9a9a', t: '#5a5a5a', U: '#d0d0d0' },
  ];
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[((y & 3) << 2) | (x & 3)];
  const rgbCache = new Map();
  function rgb(hex) {
    let c = rgbCache.get(hex);
    if (!c) { const n = parseInt(hex.slice(1), 16); c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
    return c;
  }
  function rnd(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  // ------------------------------------------------------------------ brush
  class Pix {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
    set(x, y, c) { x = Math.round(x); y = Math.round(y); if (c && x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.d[y * this.w + x] : null; }
    rect(x, y, w, h, c) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, typeof c === 'function' ? c(x + i, y + j, i, j) : c);
    }
    // filled ellipse, colour or fn(x, y, nx, ny)
    ell(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const nx = (x - cx) / (rx + 0.3), ny = (y - cy) / (ry + 0.3);
          if (nx * nx + ny * ny <= 1) this.set(x, y, typeof c === 'function' ? c(x, y, nx, ny) : c);
        }
      }
    }
    // shaded ball lit from the top-left, dithered between the given shades (dark -> light)
    ball(cx, cy, rx, ry, shades, bias) {
      this.ell(cx, cy, rx, ry, (x, y, nx, ny) => shadeAt(x, y, nx, ny, shades, bias));
    }
    poly(pts, c) {
      let y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] <= y + 0.5 && b[1] > y + 0.5) || (b[1] <= y + 0.5 && a[1] > y + 0.5)) {
            xs.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          for (let x = Math.round(xs[i]); x < Math.round(xs[i + 1]); x++) this.set(x, y, typeof c === 'function' ? c(x, y) : c);
        }
      }
    }
    line(x0, y0, x1, y1, c, t) {
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
      for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
        if (t && t > 1) this.ell(x, y, t / 2 - 0.2, t / 2 - 0.2, c); else this.set(x, y, c);
      }
    }
    outline(c) {
      const src = this.d.slice();
      const at = (x, y) => (x >= 0 && y >= 0 && x < this.w && y < this.h ? src[y * this.w + x] : null);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (src[y * this.w + x]) continue;
        if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) this.d[y * this.w + x] = c || OUT;
      }
      return this;
    }
    flipped() {
      const p = new Pix(this.w, this.h);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) p.d[y * this.w + x] = this.d[y * this.w + (this.w - 1 - x)];
      return p;
    }
    canvas(mode) {
      const c = document.createElement('canvas');
      c.width = this.w; c.height = this.h;
      const g = c.getContext('2d');
      const img = g.createImageData(this.w, this.h);
      for (let i = 0; i < this.d.length; i++) {
        const col = this.d[i];
        if (!col) continue;
        const [r, gg, b] = mode ? rgb(mode) : rgb(col);
        img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
  }
  function shadeAt(x, y, nx, ny, shades, bias) {
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    let l = -0.5 * nx - 0.62 * ny + 0.6 * nz;
    l = (l + 0.55) / 1.55 + (bias || 0);
    const i = Math.floor(l * shades.length + bayer(x, y) - 0.5);
    return shades[Math.max(0, Math.min(shades.length - 1, i))];
  }
  function fromRows(rows, pal) {
    const p = new Pix(rows[0].length + 2, rows.length + 2);
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch !== '.') p.set(x + 1, y + 1, pal[ch] || PAL[ch]); } });
    return p;
  }

  // sprite = { c, w, h, ax, ay } where (ax, ay) is the anchor inside the image
  const cache = new Map();
  function sprite(key, make) {
    let s = cache.get(key);
    if (!s) {
      const r = make();
      const pix = r.pix.outline(r.outline);
      s = { pix, c: pix.canvas(), w: pix.w, h: pix.h, ax: r.ax, ay: r.ay };
      cache.set(key, s);
    }
    return s;
  }
  function variant(base, key, fn) {
    // flipped / tinted variants of an existing sprite
    const k = base.key + key;
    let s = cache.get(k);
    if (!s) { s = fn(base); cache.set(k, s); }
    return s;
  }
  function flip(s) {
    return variant(s, '|f', () => {
      const pix = s.pix.flipped();
      return { pix, c: pix.canvas(), w: s.w, h: s.h, ax: s.w - 1 - s.ax, ay: s.ay, key: s.key + '|f' };
    });
  }
  function tint(s, color) {
    return variant(s, '|t' + color, () => ({ c: s.pix.canvas(color), w: s.w, h: s.h, ax: s.ax, ay: s.ay }));
  }
  function keyed(key, make) { const s = sprite(key, make); s.key = key; return s; }

  // ------------------------------------------------------------------ heroes
  const LEGS = {
    warrior: [['...HH..HH...', '...HH..HH...', '..BBB..BBB..'], ['..HH....HH..', '..HH...HH...', '.BBB...BBB..']],
    ranger: [['...bb..bb...', '...bb..bb...', '...BB..BB...'], ['..bb....bb..', '..bb...bb...', '..BB...BB...']],
    mage: [['..TTTTTTTTT.', '...BB...BB..'], ['..TTTTTTTTT.', '..BB....BB..']],
  };
  const HERO = {
    warrior: [
      'w..........w',
      'ww.gggggg.ww',
      '.wgggggggggw',
      '..gGGGGGGGg.',
      '..gsssssesg.',
      '..gSssssssg.',
      '...gGGGGGg..',
      '..tTTyTTTt..',
      '.gtTTTTTTtg.',
      '.gtTTyyTTtg.',
      '..tTTTTTTt..',
    ],
    ranger: [
      '....LLLL....',
      '...LllllL...',
      '..LllllllL..',
      '.LllsssssL..',
      '.LlssssesL..',
      'LllsssssSL..',
      '.LlLSSSSL...',
      '..tTTTTTTt..',
      '.stTTbTTTts.',
      '..tTTbbTTt..',
      '..tTTTTTTt..',
    ],
    mage: [
      '......PP....',
      '.....PpP....',
      '....PppP....',
      '....PpypP...',
      '...PpppppP..',
      '.PPPPPPPPPP.',
      '...sssssss..',
      '...sssseses.',
      '...wwwwwww..',
      '..TwwwwwwwT.',
      '.sTTwwwwwTTs',
      '..TTTwwwTTT.',
      '..TTTTTTTTT.',
    ],
  };
  function hero(cls, rel, frame) {
    return keyed(`h:${cls}:${rel}:${frame}`, () => {
      const rows = HERO[cls].concat(LEGS[cls][frame]);
      const p = fromRows(rows, Object.assign({}, PAL, TEAM[rel]));
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }
  const WEAPON = {
    warrior: { rows: ['..Y..........', 'BBygggggggggw', '..Y..........'], px: 1, py: 1 },
    knight: { rows: ['.Y.......', 'Bygggggga', '.Y.......'], px: 0, py: 1 },
    ranger: { rows: ['nb..', 'w.b.', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w.b.', 'nb..'], px: 0, py: 5 },
    mage: { rows: ['............OO.', '...........OyyO', 'Bbbbbbbbbbbnyay', '...........OyyO', '............OO.'], px: 2, py: 2 },
  };
  function weapon(kind) {
    return keyed('w:' + kind, () => {
      const d = WEAPON[kind];
      const p = fromRows(d.rows, PAL);
      return { pix: p, ax: d.px + 1, ay: d.py + 1 };
    });
  }

  // ------------------------------------------------------------------ monsters
  const MOB = {
    wolf: [[
      '...........G.G.',
      '..........GGGG.',
      'H...GGGGGGGGyGG',
      '.HHGGGGGGGGGGGe',
      '...GgggggggGG..',
      '...GG.G...GG.G.',
      '...H..H...H..H.',
    ], [
      '...........G.G.',
      '..........GGGG.',
      '.H..GGGGGGGGyGG',
      'H.HGGGGGGGGGGGe',
      '...GgggggggGG..',
      '..GG..GG.GG..G.',
      '..H...H..H...H.',
    ]],
    goblin: [[
      '...llllll...',
      'l.llllllll.l',
      'lllllllllyll',
      '.llllllllll.',
      '..llllRRll..',
      '...bbbbbb...',
      '..lbbbbbbl..',
      '...bbbbbb...',
      '...BB..BB...',
    ], [
      '...llllll...',
      'l.llllllll.l',
      'lllllllllyll',
      '.llllllllll.',
      '..llllRRll..',
      '...bbbbbb...',
      '..lbbbbbbl..',
      '...bbbbbb...',
      '..BB....BB..',
    ]],
    slime: [[
      '....mmmm....',
      '..mmwwmmmm..',
      '.mmwwmmmmmm.',
      '.mmmmmmmmmm.',
      'mmmmmmemmeme',
      'mmmmmmmmmmmm',
      'lmmmmmmmmmml',
      '.llllllllll.',
    ], [
      '............',
      '...mmmmmm...',
      '.mmwwmmmmmm.',
      'mmwwmmmmmmmm',
      'mmmmmmemmemm',
      'mmmmmmmmmmmm',
      'lmmmmmmmmmml',
      'llllllllllll',
    ]],
    skeleton: [[
      '...zzzzzz...',
      '..zzzzzzzz..',
      '..zzzzeZze..',
      '..zzzzzzzz..',
      '...zZzZzZ...',
      '....zzzz....',
      '..z.zZZz.z..',
      '.z..zZZz..z.',
      '....zzzz....',
      '....z..z....',
      '...zz..zz...',
    ], [
      '...zzzzzz...',
      '..zzzzzzzz..',
      '..zzzzeZze..',
      '..zzzzzzzz..',
      '...zZzZzZ...',
      '....zzzz....',
      '.z..zZZz..z.',
      '..z.zZZz.z..',
      '....zzzz....',
      '...z....z...',
      '..zz....zz..',
    ]],
    imp: [[
      '..H.....H...',
      '..HrrrrrH...',
      '.rrrrrrrrr..',
      '.rrrryrryr..',
      '.rrrrrrrrr..',
      'R.rrRRRrr..R',
      'RRrrrrrrrrRR',
      '.RRrrrrrrRR.',
      '...rr..rr...',
      '...R....R...',
    ], [
      '..H.....H...',
      '..HrrrrrH...',
      '.rrrrrrrrr..',
      '.rrrryrryr..',
      'RrrrrrrrrrR.',
      'RRrrRRRrrRR.',
      '.RrrrrrrrrR.',
      '..rrrrrrr...',
      '...rr..rr...',
      '...R....R...',
    ]],
    golem: [[
      '......xxxxxx......',
      '....xxxxxxxxxx....',
      '...xxvvxxxxxxxx...',
      '...xvvxxxxxlxxx...',
      '...xxxxxoxxxoxx...',
      '...xxxxxxxxxxxx...',
      '.xxxXxxxxxxxxXxxx.',
      'xxxxXxxlxxxxxXxxxx',
      'xxx.XxxxxxxxxX.xxx',
      'xxx.XxxxxxxxxX.xxx',
      '.x..XXxxxxxxXX..x.',
      '....xxxx..xxxx....',
      '....xxxx..xxxx....',
      '....XXXX..XXXX....',
    ], [
      '......xxxxxx......',
      '....xxxxxxxxxx....',
      '...xxvvxxxxxxxx...',
      '...xvvxxxxxlxxx...',
      '...xxxxxoxxxoxx...',
      '.x.xxxxxxxxxxxx.x.',
      'xxxXxxxxxxxxxxXxxx',
      'xxxXxxxlxxxxxxXxxx',
      'xx..XxxxxxxxxX..xx',
      '....XxxxxxxxxX....',
      '....XXxxxxxxXX....',
      '...xxxx....xxxx...',
      '...xxxx....xxxx...',
      '...XXXX....XXXX...',
    ]],
  };
  const KNIGHT = [[
    '....TT......',
    '...TTgggg...',
    '..ggggggggg.',
    '..gGGeGGeGg.',
    '..ggggggggg.',
    '..gGGGGGGGg.',
    '..TTTTTTTT..',
    '.gTTTwwTTTg.',
    '.gTTTwwTTTg.',
    '..TTTTTTTT..',
    '...HH..HH...',
    '...BB..BB...',
  ], [
    '....TT......',
    '...TTgggg...',
    '..ggggggggg.',
    '..gGGeGGeGg.',
    '..ggggggggg.',
    '..gGGGGGGGg.',
    '..TTTTTTTT..',
    '.gTTTwwTTTg.',
    '.gTTTwwTTTg.',
    '..TTTTTTTT..',
    '..HH....HH..',
    '..BB....BB..',
  ]];
  function mob(type, frame) {
    return keyed(`m:${type}:${frame}`, () => {
      const p = fromRows(MOB[type][frame], PAL);
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }
  function knight(rel, frame) {
    return keyed(`k:${rel}:${frame}`, () => {
      const p = fromRows(KNIGHT[frame], Object.assign({}, PAL, TEAM[rel]));
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }

  // ------------------------------------------------------------------ nature
  const LEAF = {
    [S.B.MEADOW]: ['#2c5a26', '#3f7f33', '#56a043', '#78c05a', '#a3dd7a'],
    [S.B.FOREST]: ['#1d4020', '#2a5a2a', '#377236', '#4c8e44', '#6aac58'],
    [S.B.SWAMP]: ['#26361f', '#34492a', '#445c36', '#587246', '#728c5a'],
  };
  function tree(biome, v, size) {
    return keyed(`t:${biome}:${v % 5}:${size}`, () => {
      const R = rnd(v * 7919 + biome * 31 + size);
      const W = size * 2 + 8, Hh = Math.round(size * 2.6) + 6;
      const p = new Pix(W, Hh);
      const cx = W / 2 - 0.5;
      const baseY = Hh - 2;
      if (biome === S.B.SNOW) {
        // pine: stacked dithered triangles with snow caps
        const trunkH = Math.max(3, Math.round(size * 0.35));
        p.rect(Math.round(cx) - 1, baseY - trunkH, 3, trunkH + 1, (x) => (x > cx ? '#4a2e1a' : '#6b4428'));
        const tiers = 3, top = 1;
        for (let i = 0; i < tiers; i++) {
          const ty = top + i * (baseY - trunkH - top) / (tiers + 0.4);
          const by = ty + (baseY - trunkH - top) / (tiers - 0.6);
          const hw = size * (0.55 + i * 0.25);
          p.poly([[cx, ty], [cx + hw, by], [cx - hw, by]], (x, y) => {
            const k = (x - cx) / hw + (y - ty) / (by - ty) * 0.3;
            const sh = ['#3d7a5a', '#2f6649', '#224f38', '#183a2a'];
            return sh[Math.max(0, Math.min(3, Math.floor(k * 2 + 1.4 + bayer(x, y) - 0.5)))];
          });
          for (let x = -hw; x <= hw; x++) {
            const yy = by - 1 - Math.floor(Math.abs(x) * 0.15);
            if (R() < 0.75) p.set(cx + x, yy, '#f4f8fa');
          }
          p.line(cx, ty, cx - hw * 0.6, by - 2, '#e9f1f5');
        }
        return { pix: p, ax: Math.round(cx), ay: baseY };
      }
      if (biome === S.B.VOLCANO) {
        // dead, charred tree
        const col = ['#2a1a14', '#3d2a20', '#5a4032'];
        p.line(cx, baseY, cx, baseY - size * 1.8, col[1], 3);
        p.line(cx + 1, baseY, cx + 1, baseY - size * 1.8, col[0], 1);
        for (let i = 0; i < 4; i++) {
          const y0 = baseY - size * (0.8 + i * 0.3);
          const dir = i % 2 ? 1 : -1;
          const x1 = cx + dir * size * (0.6 + R() * 0.4), y1 = y0 - size * (0.4 + R() * 0.3);
          p.line(cx, y0, x1, y1, col[1], 2);
          p.line(x1, y1, x1 + dir * 2, y1 - 2, col[2]);
        }
        for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, baseY - R() * size * 1.5, '#ff6a3d');
        return { pix: p, ax: Math.round(cx), ay: baseY };
      }
      const leaf = LEAF[biome] || LEAF[S.B.MEADOW];
      const trunkH = Math.round(size * 0.7);
      p.rect(Math.round(cx) - 1, baseY - trunkH, 3, trunkH + 1, (x) => (x > cx ? '#5a3820' : '#8a5a30'));
      p.set(Math.round(cx) - 2, baseY, '#5a3820'); p.set(Math.round(cx) + 2, baseY, '#5a3820');
      const ccy = baseY - trunkH - size * 0.75;
      const blobs = [[0, 0, 1]];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + R();
        blobs.push([Math.cos(a) * size * 0.45, Math.sin(a) * size * 0.35, 0.6 + R() * 0.2]);
      }
      // canopy shading uses the whole canopy as one lit sphere so blobs merge nicely
      for (const [bx, by, br] of blobs) {
        p.ell(cx + bx, ccy + by, size * 0.62 * br + 1, size * 0.55 * br + 1, (x, y) => {
          const nx = (x - cx) / (size * 1.05), ny = (y - ccy) / (size * 0.95);
          return shadeAt(x, y, Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)), leaf, 0);
        });
      }
      if (biome === S.B.SWAMP) {
        for (let i = 0; i < 7; i++) {
          const x = cx + (R() - 0.5) * size * 1.6;
          const y0 = ccy + size * 0.3;
          p.line(x, y0, x, y0 + 2 + R() * size * 0.6, leaf[1]);
        }
      } else if (R() < 0.5) {
        for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, ccy + (R() - 0.3) * size * 0.6, biome === S.B.FOREST ? '#c9423a' : '#ffd0e0');
      }
      return { pix: p, ax: Math.round(cx), ay: baseY };
    });
  }
  const ROCK = {
    default: ['#5e584f', '#7a7469', '#958f84', '#b3ada0', '#cfc9bb'],
    snow: ['#5d6a78', '#7d8a98', '#9eabb8', '#c3ced8', '#e8eef2'],
    volcano: ['#1d1720', '#2e2530', '#40354a', '#574a64', '#6e6080'],
    gold: ['#3a322b', '#4a4038', '#5a4f47', '#6e625a', '#83776e'],
  };
  function rockShape(p, cx, cy, rx, ry, R, shades) {
    const n = 7, pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + R() * 0.5;
      const k = 0.75 + R() * 0.25;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    p.poly(pts, (x, y) => {
      // faceted: shade by the facet the pixel belongs to
      const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
      const facet = Math.floor(((a + Math.PI) / (Math.PI * 2)) * n);
      const fa = ((facet + 0.5) / n) * Math.PI * 2 - Math.PI;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      const nx = Math.cos(fa) * Math.min(1, d * 1.2), ny = Math.sin(fa) * Math.min(1, d * 1.2);
      return shadeAt(x, y, nx * 0.9, ny * 0.9, shades, 0.05);
    });
  }
  function rock(biome, v, size) {
    return keyed(`r:${biome}:${v % 5}:${size}`, () => {
      const R = rnd(v * 104729 + biome);
      const W = size * 2 + 6, Hh = Math.round(size * 1.7) + 6;
      const p = new Pix(W, Hh);
      const cx = W / 2 - 0.5, cy = Hh - 3 - size * 0.7;
      const shades = biome === S.B.SNOW ? ROCK.snow : biome === S.B.VOLCANO ? ROCK.volcano : ROCK.default;
      rockShape(p, cx, cy, size, size * 0.8, R, shades);
      if (biome === S.B.SNOW) p.ell(cx - size * 0.2, cy - size * 0.5, size * 0.5, size * 0.22, '#f4f8fa');
      if (biome === S.B.VOLCANO) { p.line(cx - size * 0.5, cy + 1, cx, cy + size * 0.3, '#ff6a3d'); p.line(cx, cy + size * 0.3, cx + size * 0.4, cy - 1, '#ffb040'); }
      if (biome === S.B.MOUNTAIN || biome === S.B.FOREST) for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, cy - size * 0.4 + R() * 2, '#6e8a4a');
      return { pix: p, ax: Math.round(cx), ay: Hh - 2 };
    });
  }
  function goldVein(v, size) {
    return keyed(`g:${v % 5}:${size}`, () => {
      const R = rnd(v * 7 + 3);
      const W = size * 2 + 6, Hh = Math.round(size * 1.9) + 6;
      const p = new Pix(W, Hh);
      const cx = W / 2 - 0.5, cy = Hh - 3 - size * 0.6;
      rockShape(p, cx, cy, size, size * 0.7, R, ROCK.gold);
      const gold = ['#9a6a10', '#d89a20', '#ffd34a', '#fff1a0'];
      for (let i = 0; i < 3; i++) {
        const x = cx + (i - 1) * size * 0.5 + (R() - 0.5) * 2, y = cy - size * 0.2 + (R() - 0.5) * 2;
        const h = size * (0.7 + R() * 0.5), w = Math.max(1.5, size * 0.28);
        p.poly([[x, y - h], [x + w, y - h * 0.4], [x + w * 0.6, y + 1], [x - w * 0.6, y + 1], [x - w, y - h * 0.4]], (px, py) => {
          const k = (px - x) / w;
          return gold[Math.max(0, Math.min(3, Math.floor(1.8 - k * 1.3 + bayer(px, py) - 0.5)))];
        });
        p.set(x - 1, y - h * 0.6, '#ffffff');
      }
      return { pix: p, ax: Math.round(cx), ay: Hh - 2 };
    });
  }
  function node(n) {
    const size = Math.max(6, Math.round(n.r / ART));
    if (n.type === 'tree') return tree(n.biome, n.v, size);
    if (n.type === 'rock') return rock(n.biome, n.v, size);
    return goldVein(n.v, size);
  }

  // ------------------------------------------------------------------ buildings
  const STONE = { hi: '#cdc4b2', a: '#aca290', b: '#958b79', mortar: '#6b6357', dark: '#554d42' };
  const PSTONE = { hi: '#b8aec8', a: '#948aa6', b: '#7e7490', mortar: '#5a526a', dark: '#453e52' };
  function bricks(st, ox, oy) {
    return (x, y) => {
      const yy = y - (oy || 0), xx = x - (ox || 0);
      const row = Math.floor(yy / 3);
      if (yy % 3 === 2) return st.mortar;
      if ((xx + (row % 2) * 3) % 6 === 5) return st.mortar;
      return (xx + row) % 7 === 0 ? st.hi : row % 3 === 0 ? st.b : st.a;
    };
  }
  function planks(x, y) { return x % 4 === 3 ? '#5a3820' : (y + x * 3) % 9 === 0 ? '#6b4428' : '#9a6a3a'; }
  function roof(p, x0, x1, yTop, yBase, team) {
    const cx = (x0 + x1) / 2;
    p.poly([[cx, yTop], [x1 + 1, yBase], [x0, yBase]], (x, y) => {
      const stripe = (y - yTop) % 3 === 2;
      if (stripe) return team.t;
      return x < cx - 1 ? team.U : x > cx + 1 ? team.T : team.T;
    });
    p.line(cx, yTop, x0, yBase - 1, team.U);
  }
  function merlons(p, x0, x1, y, st) {
    for (let x = x0; x <= x1; x++) if ((x - x0) % 4 < 2) p.rect(x, y - 2, 1, 2, st.a);
  }
  function flag(p, x, y, team, h) {
    p.line(x, y, x, y - h, '#3a2a1a');
    p.rect(x + 1, y - h, 5, 3, (xx, yy) => (yy === y - h ? team.U : team.T));
    p.set(x + 6, y - h + 1, team.T);
  }
  function building(type, rel) {
    return keyed(`b:${type}:${rel}`, () => {
      const team = TEAM[rel];
      const f = Math.round(S.BUILDINGS[type].size / ART);
      const extra = { townhall: 30, wall: 8, tower: 20, magetower: 26, sawmill: 16, quarry: 6, mine: 12, barracks: 16, shrine: 18 }[type];
      const W = f + 2, Hh = f + extra + 2;
      const p = new Pix(W, Hh);
      const B = Hh - 2; // bottom row of the footprint
      const L = 1, Rr = f; // left / right columns
      switch (type) {
        case 'townhall': {
          // keep
          const k0 = L + Math.round(f * 0.26), k1 = Rr - Math.round(f * 0.26);
          p.rect(k0, B - 36, k1 - k0 + 1, 24, bricks(STONE, k0, B - 36));
          p.rect(k1 - 2, B - 36, 3, 24, STONE.b);
          roof(p, k0 - 2, k1 + 2, B - 54, B - 35, team);
          p.rect(Math.round((k0 + k1) / 2) - 1, B - 30, 3, 4, '#2a2230');
          flag(p, Math.round((k0 + k1) / 2), B - 54, team, 8);
          // courtyard floor behind the front wall
          p.rect(L + 2, B - 14, f - 4, 3, STONE.hi);
          // side towers
          for (const tx of [L, Rr - 10]) {
            p.rect(tx, B - 26, 11, 27, bricks(STONE, tx, B - 26));
            p.rect(tx + 8, B - 26, 3, 27, STONE.b);
            roof(p, tx - 1, tx + 11, B - 40, B - 25, team);
            p.rect(tx + 5, B - 20, 1, 3, '#2a2230');
          }
          // front curtain wall with gate
          p.rect(L + 11, B - 12, f - 22, 13, bricks(STONE, L + 11, B - 12));
          merlons(p, L + 11, Rr - 11, B - 12, STONE);
          const gx = Math.round(W / 2) - 4;
          p.rect(gx, B - 8, 8, 9, '#2a2230');
          p.ell(gx + 3.5, B - 8, 4, 2.5, '#2a2230');
          for (let x = gx + 1; x < gx + 8; x += 2) p.line(x, B - 9, x, B, '#6b6357');
          p.rect(gx - 2, B - 11, 12, 1, team.T);
          break;
        }
        case 'wall': {
          p.rect(L, B - f - 7, f, 8, (x, y) => ((x + y) % 5 === 0 ? STONE.hi : STONE.a));
          p.rect(L, B - f + 1, f, f, bricks(STONE, L, B - f + 1));
          p.rect(L, B - f + 1, f, 1, team.T);
          p.rect(L, B, f, 1, STONE.dark);
          break;
        }
        case 'tower':
        case 'magetower': {
          const mage = type === 'magetower';
          const st = mage ? PSTONE : STONE;
          const b0 = L + 3, b1 = Rr - 3;
          p.rect(b0, B - 24, b1 - b0 + 1, 25, bricks(st, b0, B - 24));
          p.rect(b1 - 2, B - 24, 3, 25, st.b);
          p.rect(Math.round(W / 2) - 1, B - 18, 2, 4, '#2a2230');
          if (mage) {
            p.rect(L + 1, B - 28, f - 2, 5, st.hi);
            p.poly([[W / 2 - 0.5, B - f - extra + 2], [Rr, B - 27], [L, B - 27]], (x, y) => ((y + x) % 4 === 0 ? '#6b3fa0' : x < W / 2 ? '#a070e0' : '#7a4ac0'));
            p.rect(Math.round(W / 2) - 2, B - 12, 4, 6, team.T);
            p.set(Math.round(W / 2) - 1, B - 7, team.U);
          } else {
            p.rect(L, B - 30, f, 7, (x, y) => (y === B - 30 ? st.hi : st.a));
            merlons(p, L, Rr, B - 30, st);
            // archer
            p.rect(Math.round(W / 2) - 2, B - 35, 5, 5, team.T);
            p.rect(Math.round(W / 2) - 1, B - 34, 3, 2, '#f2c79a');
            p.rect(Math.round(W / 2) - 3, B - 13, 6, 8, team.T);
            p.rect(Math.round(W / 2) - 3, B - 13, 6, 1, team.U);
            p.set(Math.round(W / 2) - 1, B - 5, team.T); p.set(Math.round(W / 2), B - 5, team.T);
          }
          break;
        }
        case 'sawmill': {
          p.rect(L + 1, B - 14, f - 9, 15, planks);
          roof(p, L - 1, Rr - 7, B - 30, B - 13, { T: '#8a4a2a', t: '#5a2e18', U: '#b06a3a' });
          p.rect(L + 6, B - 8, 4, 9, '#3a2418');
          // log pile
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3 - i; j++) {
            const x = Rr - 6 + j * 3 - i * 0 + i * 1.5, y = B - 2 - i * 3;
            p.ell(x, y, 1.6, 1.6, '#c89060');
            p.set(x, y, '#8a5a30');
          }
          p.ell(L + 11, B - 20, 3, 3, (x, y) => ((x + y) % 2 ? '#c8d0d8' : '#8a94a0'));
          flag(p, Rr - 1, B - 10, team, 7);
          break;
        }
        case 'quarry': {
          p.ell(W / 2, B - f / 2, f / 2, f / 2 - 2, (x, y) => ((x * 3 + y * 5) % 11 === 0 ? '#4a443c' : '#6e675c'));
          p.ell(W / 2, B - f / 2 + 2, f / 2 - 4, f / 2 - 6, '#4f493f');
          const stones = [[-5, -2], [1, -3], [-2, 2], [4, 1], [-6, 3]];
          for (const [dx, dy] of stones) {
            const x = W / 2 + dx, y = B - f / 2 + dy;
            p.rect(x - 2, y - 2, 5, 4, (xx, yy) => (yy === y - 2 ? STONE.hi : xx === x + 2 ? STONE.b : STONE.a));
          }
          p.line(Rr - 6, B - f + 6, Rr - 3, B - f + 12, '#8a5a30', 1);
          p.line(Rr - 8, B - f + 7, Rr - 4, B - f + 5, '#c8d0d8', 1);
          flag(p, L + 3, B - 4, team, 8);
          break;
        }
        case 'mine': {
          p.ell(W / 2, B - 10, f / 2, 14, (x, y, nx, ny) => shadeAt(x, y, nx, ny, ['#4a3f34', '#5e5145', '#746556', '#8a7a68'], 0));
          p.rect(W / 2 - 5, B - 14, 10, 15, '#1b1510');
          p.ell(W / 2 - 0.5, B - 14, 5, 4, '#1b1510');
          p.line(W / 2 - 6, B, W / 2 - 6, B - 15, '#8a5a30', 2);
          p.line(W / 2 + 6, B, W / 2 + 6, B - 15, '#8a5a30', 2);
          p.line(W / 2 - 7, B - 16, W / 2 + 7, B - 16, '#a06a36', 2);
          for (let i = 0; i < 4; i++) p.ell(W / 2 - 3 + i * 2, B - 2 - (i % 2), 1, 1, '#ffd34a');
          flag(p, Rr - 3, B - 18, team, 7);
          break;
        }
        case 'barracks': {
          const cx = W / 2;
          p.rect(L + 1, B - 6, f - 2, 7, '#8a7a64');
          p.poly([[cx, B - f - 8], [Rr - 2, B - 2], [L + 2, B - 2]], (x, y) => (Math.floor((x - L) / 3) % 2 ? team.T : team.U));
          p.poly([[cx, B - 14], [cx + 4, B - 2], [cx - 4, B - 2]], '#2a2230');
          p.line(cx, B - f - 8, cx, B - f - 12, '#3a2a1a');
          p.rect(cx + 1, B - f - 12, 4, 2, team.T);
          for (let i = 0; i < 3; i++) p.line(L + 2 + i * 2, B, L + 2 + i * 2, B - 12, '#8a5a30');
          p.rect(L + 1, B - 12, 6, 1, '#c8d0d8');
          p.ell(Rr - 4, B - 5, 3, 3, (x, y) => (x === Rr - 4 || y === B - 5 ? '#ffd34a' : team.T));
          break;
        }
        case 'shrine': {
          const cx = W / 2 - 0.5;
          p.ell(cx, B - f / 2, f / 2, f / 2 - 3, (x, y, nx, ny) => shadeAt(x, y, nx, ny, ['#8a8374', '#b0a898', '#d8d2c4', '#f0ece2'], 0.1));
          for (const [dx, dy] of [[-7, -4], [7, -4], [-5, 3], [5, 3]]) {
            p.rect(cx + dx - 1, B - f / 2 + dy - 8, 3, 9, (x) => (x === cx + dx + 1 ? '#b0a898' : '#f0ece2'));
          }
          p.poly([[cx, B - f - 14], [cx + 3, B - f / 2 - 6], [cx, B - f / 2 + 1], [cx - 3, B - f / 2 - 6]], (x) => (x < cx ? '#bfffd8' : x > cx ? '#3ecf7a' : '#7dffb0'));
          p.set(cx - 1, B - f - 6, '#ffffff');
          p.set(cx + 5, B - f / 2 + 4, team.T); p.set(cx - 5, B - f / 2 + 4, team.T);
          break;
        }
      }
      return { pix: p, ax: Math.round(W / 2), ay: B };
    });
  }
  function star() {
    return keyed('star', () => ({ pix: fromRows(['.y.', 'yay', '.y.'], PAL), ax: 2, ay: 2 }));
  }

  // ------------------------------------------------------------------ bosses
  function boss(key, frame) {
    return keyed(`B:${key}:${frame}`, () => {
      const ph = (frame / 4) * Math.PI * 2;
      const wob = Math.sin(ph);
      let p, ax, ay;
      if (key === 'treant') {
        p = new Pix(60, 66); ax = 30; ay = 63;
        const bark = ['#3a2414', '#523420', '#6b4428', '#8a5a34'];
        for (const s of [-1, 1]) {
          const ex = 30 + s * (22 + wob * 2), ey = 34 + wob * 3 * s;
          p.line(30 + s * 8, 40, ex, ey, bark[1], 5);
          p.line(ex, ey, ex + s * 5, ey - 6, bark[2], 3);
          p.line(ex, ey, ex + s * 6, ey + 2, bark[2], 2);
        }
        p.line(24, 58, 18, 63, bark[1], 4); p.line(36, 58, 42, 63, bark[1], 4); p.line(30, 60, 30, 64, bark[1], 4);
        p.ball(30, 42, 12, 18, bark);
        for (let y = 28; y < 60; y += 4) p.line(22 + (y % 8), y, 26 + (y % 8), y + 2, bark[0]);
        const leaf = LEAF[S.B.FOREST];
        const blobs = [[30, 16, 14, 11], [18, 20, 9, 8], [42, 20, 9, 8], [24, 10, 8, 7], [37, 9, 8, 7], [30, 26, 10, 6]];
        for (const [x, y, rx, ry] of blobs) p.ell(x, y + wob * 0.6, rx, ry, (xx, yy) => shadeAt(xx, yy, (xx - 30) / 20, (yy - 16) / 15, leaf, 0));
        p.rect(33, 36, 3, 2, '#b4ff6a'); p.rect(38, 36, 3, 2, '#b4ff6a');
        p.rect(34, 44, 6, 2, '#1e120a');
        p.set(20, 14, '#ffd0e0'); p.set(40, 12, '#ffd0e0'); p.set(28, 22, '#ffd0e0');
      } else if (key === 'lich') {
        p = new Pix(48, 58); ax = 24; ay = 55;
        const robe = ['#150e20', '#23183a', '#34245a', '#4a3478'];
        const hem = 52 + wob;
        p.poly([[24, 18], [38, 30], [42, hem], [6, hem], [10, 30]], (x, y) => shadeAt(x, y, (x - 24) / 20, (y - 36) / 24, robe, 0));
        for (let x = 6; x <= 42; x += 4) p.poly([[x, hem - 1], [x + 2, hem + 3 + ((x / 4 + frame) % 2) * 2], [x + 4, hem - 1]], robe[1]);
        p.ball(24, 16, 8, 8, ['#8a8474', '#b8b09a', '#e9e4d6', '#fffaf0']);
        p.rect(24, 14, 3, 3, '#101018'); p.rect(29, 14, 3, 3, '#101018');
        p.set(25, 15, '#6ad8ff'); p.set(30, 15, '#6ad8ff');
        p.rect(24, 20, 6, 1, '#4a4438');
        for (let i = 0; i < 5; i++) p.poly([[16 + i * 4, 10], [18 + i * 4, 2 + (i % 2) * 2], [20 + i * 4, 10]], i % 2 ? '#c08a20' : '#ffd34a');
        p.rect(16, 9, 17, 2, '#ffd34a');
        p.line(40, 20, 40, 54, '#6b4428', 2);
        p.ball(40, 17, 4, 4, ['#2a5a9a', '#6ad8ff', '#c8f4ff', '#ffffff']);
        p.line(34, 32, 40, 30, robe[2], 3);
      } else if (key === 'hydra') {
        p = new Pix(66, 58); ax = 30; ay = 55;
        const sk = ['#1f3a1d', '#2e5a2a', '#3e6b3a', '#4f8a45', '#6fae5a'];
        p.ball(28, 44, 20, 12, sk);
        for (let i = 0; i < 6; i++) p.ell(18 + i * 4, 44 + (i % 2), 1.5, 1.5, '#a0c870');
        p.line(10, 48, 2, 52 + wob, sk[1], 4);
        const heads = [[-1, 44, 8], [0, 57, 20], [1, 47, 32]];
        heads.forEach(([i, hx, hy], idx) => {
          const b = Math.sin(ph + idx * 2) * 2;
          const x = hx, y = hy + b;
          p.line(28 + i * 6, 40, x - 4, y + 4, sk[1], 7);
          p.line(28 + i * 6, 40, x - 4, y + 4, sk[3], 4);
          p.ball(x, y, 7, 5, sk);
          p.poly([[x + 3, y + 1], [x + 9, y + 2], [x + 3, y + 4]], sk[2]);
          p.set(x + 2, y - 2, '#ffe14a'); p.set(x + 3, y - 2, '#ffe14a');
          p.set(x + 7, y + 3, '#f4f1e8');
          p.poly([[x - 3, y - 4], [x - 6, y - 8], [x - 1, y - 5]], sk[0]);
        });
      } else if (key === 'colossus') {
        p = new Pix(70, 66); ax = 35; ay = 63;
        const st = ['#3e3a33', '#5e584f', '#7a7469', '#958f84', '#b3ada0'];
        const up = wob * 3;
        p.rect(24, 50, 8, 13, (x) => (x > 29 ? st[1] : st[2])); p.rect(38, 50, 8, 13, (x) => (x > 43 ? st[1] : st[2]));
        rockShape(p, 35, 36, 20, 18, rnd(5), st);
        p.ball(8, 36 - up, 7, 8, st); p.ball(62, 36 + up, 7, 8, st);
        p.line(14, 30, 20, 32, st[2], 5); p.line(56, 30, 50, 32, st[2], 5);
        rockShape(p, 35, 14, 9, 8, rnd(9), st);
        p.rect(34, 13, 2, 2, '#5ac8ff'); p.rect(39, 13, 2, 2, '#5ac8ff');
        p.ell(28, 28, 5, 3, '#6e8a4a'); p.ell(42, 44, 4, 2, '#6e8a4a'); p.ell(33, 7, 3, 1.5, '#6e8a4a');
        p.line(30, 34, 36, 40, '#5ac8ff'); p.line(36, 40, 32, 46, '#5ac8ff'); p.line(40, 30, 44, 36, '#5ac8ff');
      } else if (key === 'dragon') {
        p = new Pix(76, 64); ax = 36; ay = 60;
        const sc = ['#4a0e08', '#7a1a10', '#a8261a', '#cc3a24', '#e86040'];
        const wy = wob * 6;
        for (const [wx, dir] of [[30, -1], [40, 1]]) {
          const tipY = 4 + wy, midY = 14 + wy * 0.6;
          p.poly([[wx, 30], [wx + dir * 6, midY], [wx + dir * 16, tipY], [wx + dir * 26, 12 + wy * 0.4], [wx + dir * 22, 22], [wx + dir * 14, 26], [wx + dir * 4, 34]], (x, y) => ((x + y) % 7 === 0 ? sc[0] : dir < 0 ? sc[1] : sc[2]));
          p.line(wx, 30, wx + dir * 16, tipY, sc[0]); p.line(wx, 30, wx + dir * 26, 12 + wy * 0.4, sc[0]);
        }
        p.line(18, 42, 8, 50, sc[2], 5); p.line(8, 50, 2, 44, sc[2], 3); p.poly([[0, 42], [4, 40], [3, 46]], '#efe0c0');
        p.ball(34, 42, 16, 11, sc);
        for (let x = 24; x < 44; x += 3) p.rect(x, 46, 2, 3, '#e8a040');
        p.rect(24, 50, 5, 8, sc[1]); p.rect(40, 50, 5, 8, sc[1]);
        p.line(44, 36, 54, 26, sc[2], 6);
        p.ball(58, 24, 8, 6, sc);
        p.poly([[62, 26], [70, 27], [62, 29]], sc[1]);
        p.poly([[54, 19], [50, 12], [57, 18]], '#efe0c0'); p.poly([[58, 18], [56, 11], [61, 17]], '#efe0c0');
        p.rect(60, 21, 2, 2, '#ffe14a');
        p.set(69, 28, '#ff9a3d');
      }
      return { pix: p, ax, ay };
    });
  }

  // ------------------------------------------------------------------ projectiles
  function arrow(mine) {
    return keyed('a:' + mine, () => ({ pix: fromRows([mine ? 'c.....G.' : 'r.....G.', '.cbbbbGG'.replace('c', mine ? 'c' : 'r'), mine ? 'c.....G.' : 'r.....G.'], PAL), ax: 5, ay: 2 }));
  }
  function rockProj(big) {
    return keyed('rp:' + big, () => {
      const r = big ? 8 : 4;
      const p = new Pix(r * 2 + 4, r * 2 + 4);
      rockShape(p, r + 1.5, r + 1.5, r, r, rnd(big ? 3 : 4), ROCK.default);
      return { pix: p, ax: r + 2, ay: r + 2 };
    });
  }
  function seed() {
    return keyed('seed', () => ({ pix: fromRows(['.mm.', 'mbbL', 'bbBL', '.BB.'], PAL), ax: 2, ay: 2 }));
  }

  // ------------------------------------------------------------------ ground
  const GROUND = [
    ['#5c9a45', '#6aa84f', '#76b457', '#82c060'],
    ['#356c31', '#3f7a3a', '#47843f', '#4f8f45'],
    ['#7c766b', '#8b857a', '#958f84', '#a09a8e'],
    ['#cbd8e1', '#dfe9ef', '#e9f1f5', '#f4f8fa'],
    ['#445a3e', '#4e6647', '#56704e', '#5f7a55'],
    ['#2e201e', '#3e2c2a', '#46322f', '#503a36'],
  ];
  const CH = 256;
  function decor(g, b, h, x, y, h2) {
    // tiny hand-placed pixel props stamped into the ground
    const put = (dx, dy, c) => { g.fillStyle = c; g.fillRect(x + dx, y + dy, 1, 1); };
    if (b === S.B.MEADOW || b === S.B.FOREST) {
      if (h < 0.35) { const c = b === S.B.FOREST ? '#2a5a2a' : '#4f8f3c'; put(0, 0, c); put(2, -1, c); put(1, -2, c); put(4, 0, c); put(3, -1, c); }
      else if (h < 0.45 && b === S.B.MEADOW) { const c = ['#fff3a8', '#ff9fbf', '#ffffff', '#a8d4ff'][(h2 * 4) | 0]; put(0, -1, c); put(-1, 0, c); put(1, 0, c); put(0, 1, c); put(0, 0, '#e8a93a'); }
      else if (h < 0.5 && b === S.B.FOREST) { put(0, 0, '#e8dcc0'); put(0, -1, '#c9423a'); put(-1, -1, '#c9423a'); put(1, -1, '#c9423a'); put(0, -2, '#e05a4a'); }
    } else if (b === S.B.MOUNTAIN) {
      if (h < 0.35) { put(0, 0, '#6b655b'); put(1, 0, '#6b655b'); put(0, -1, '#a8a296'); }
      else if (h < 0.45) { for (let i = 0; i < 5; i++) put(i, (i * 7 + ((h2 * 10) | 0)) % 2, '#6f695e'); }
    } else if (b === S.B.SNOW) {
      if (h < 0.3) { for (let i = -3; i <= 3; i++) put(i, 0, '#ffffff'); for (let i = -2; i <= 2; i++) put(i, 1, '#c5d3dd'); }
      else if (h < 0.38) { put(0, 0, '#ffffff'); put(-1, 0, '#bfe6ff'); put(1, 0, '#bfe6ff'); put(0, -1, '#bfe6ff'); put(0, 1, '#bfe6ff'); }
    } else if (b === S.B.SWAMP) {
      if (h < 0.2) { g.fillStyle = '#2f4a44'; g.fillRect(x - 4, y - 1, 9, 3); g.fillRect(x - 2, y - 2, 5, 5); put(-2, -1, '#5f8a80'); }
      else if (h < 0.32) { put(0, 0, '#2c4020'); put(0, -1, '#2c4020'); put(0, -2, '#3c5a2c'); put(2, 0, '#2c4020'); put(2, -1, '#3c5a2c'); put(2, -3, '#6b4a2a'); }
      else if (h < 0.4) { put(0, 0, '#6f9a4a'); put(1, 0, '#6f9a4a'); put(0, 1, '#6f9a4a'); put(1, 1, '#4f7a3a'); }
    } else if (b === S.B.VOLCANO) {
      if (h < 0.16) { let cx = x, cy = y; for (let i = 0; i < 7; i++) { g.fillStyle = i % 3 === 0 ? '#ffb040' : '#ff5a1a'; g.fillRect(cx, cy, 1, 1); cx += 1; cy += ((h2 * 97 + i * 13) | 0) % 3 - 1; } }
      else if (h < 0.3) { put(0, 0, '#1e1414'); put(1, 0, '#1e1414'); put(0, -1, '#5a4540'); }
      else if (h < 0.34) { put(0, 0, '#e9e4d6'); put(1, 0, '#e9e4d6'); put(2, 0, '#e9e4d6'); put(0, -1, '#e9e4d6'); put(2, -1, '#e9e4d6'); }
    }
  }
  function groundChunk(cx, cy, biomeAtPos) {
    const c = document.createElement('canvas');
    c.width = CH; c.height = CH;
    const g = c.getContext('2d');
    const img = g.createImageData(CH, CH);
    const x0 = cx * CH, y0 = cy * CH;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CH; x++) {
        const ax = x0 + x, ay = y0 + y;
        const jx = (S.noise(ax / 9, ay / 9, 91) - 0.5) * 40, jy = (S.noise(ax / 9, ay / 9, 92) - 0.5) * 40;
        const b = biomeAtPos(ax * ART + jx, ay * ART + jy);
        const n = S.noise(ax / 14, ay / 14, 5) * 0.7 + S.noise(ax / 4, ay / 4, 6) * 0.3;
        const pal = GROUND[b];
        const i = Math.max(0, Math.min(3, Math.floor(n * 4.4 - 0.7 + bayer(ax, ay) * 0.9 - 0.45)));
        const [r, gg, bb] = rgb(pal[i]);
        const k = (y * CH + x) * 4;
        img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = bb; img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const cell = 12;
    for (let ty = Math.floor(y0 / cell); ty < (y0 + CH) / cell; ty++) {
      for (let tx = Math.floor(x0 / cell); tx < (x0 + CH) / cell; tx++) {
        const h = S.hash2(tx, ty, 41), h2 = S.hash2(tx, ty, 42);
        const px = tx * cell + Math.floor(S.hash2(tx, ty, 43) * cell), py = ty * cell + Math.floor(S.hash2(tx, ty, 44) * cell);
        decor(g, biomeAtPos(px * ART, py * ART), h, px - x0, py - y0, h2);
      }
    }
    return c;
  }

  return { ART, TEAM, PAL, Pix, hero, weapon, mob, knight, node, building, boss, arrow, rockProj, seed, star, flip, tint, groundChunk, CH };
})();
