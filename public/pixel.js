/* global S */
'use strict';
// Procedural pixel-art generator. Every sprite in the game is produced here at load time:
// characters come from palette-coded text grids, everything else is painted with a tiny
// pixel "brush" (lit dithered balls, polygons, bricks, shingles) and gets an automatic outline.
// 1 art pixel = 3 world units.
const PIX = (() => {
  const ART = 3;
  const OUT = '#2b2138';
  const PAL = {
    k: OUT, w: '#f6f3ea', s: '#f5cfa3', S: '#d39a6c', g: '#d2d9e0', G: '#97a1ad', H: '#5f6875',
    b: '#9a6838', B: '#654226', n: '#c89060', y: '#ffd84f', Y: '#c9922a', r: '#e0544a', R: '#963228',
    l: '#66b84c', L: '#387a34', m: '#9ada74', p: '#9a68dc', P: '#553488', q: '#d2acff', c: '#78e0ff',
    C: '#2f67aa', o: '#ffa24a', O: '#cc6424', e: '#16121c', z: '#efeadc', Z: '#c2b9a2', x: '#a89e8e',
    X: '#6b6255', v: '#cdc5b5', a: '#fff0a8', f: '#ff7447', d: '#3d2f4d', D: '#241b30', i: '#ffffff',
  };
  const TEAM = [
    { T: '#3f9ff5', t: '#22609f', U: '#a5d7ff' },
    { T: '#48c86c', t: '#227c3e', U: '#adf2bc' },
    { T: '#ea554e', t: '#912a24', U: '#ffb4ac' },
    { T: '#a0a0a0', t: '#606060', U: '#d4d4d4' },
  ];
  // roof / cloth ramps per team (dark -> light)
  const RAMP = [
    ['#1d4a86', '#2a64ad', '#3a80d0', '#5a9fe8', '#8cc4f8'],
    ['#1c5e33', '#27804a', '#36a05c', '#56bf76', '#8ee0a2'],
    ['#7c2220', '#a8332c', '#cc473c', '#e46a5a', '#f69e8c'],
    ['#474747', '#616161', '#7b7b7b', '#979797', '#bdbdbd'],
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
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------ brush
  class Pix {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Array(w * h).fill(null); }
    set(x, y, c) { x = Math.round(x); y = Math.round(y); if (c && x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.d[y * this.w + x] : null; }
    rect(x, y, w, h, c) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, typeof c === 'function' ? c(x + i, y + j, i, j) : c);
    }
    ell(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const nx = (x - cx) / (rx + 0.3), ny = (y - cy) / (ry + 0.3);
          if (nx * nx + ny * ny <= 1) this.set(x, y, typeof c === 'function' ? c(x, y, nx, ny) : c);
        }
      }
    }
    ball(cx, cy, rx, ry, shades, bias) { this.ell(cx, cy, rx, ry, (x, y, nx, ny) => shadeAt(x, y, nx, ny, shades, bias)); }
    poly(pts, c) {
      let y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] <= y + 0.5 && b[1] > y + 0.5) || (b[1] <= y + 0.5 && a[1] > y + 0.5)) xs.push(a[0] + ((y + 0.5 - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
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
    canvas(mode, scale) {
      const k = scale || 1;
      const c = document.createElement('canvas');
      c.width = this.w * k; c.height = this.h * k;
      const g = c.getContext('2d');
      const img = g.createImageData(this.w * k, this.h * k);
      for (let y = 0; y < this.h * k; y++) for (let x = 0; x < this.w * k; x++) {
        const col = this.d[Math.floor(y / k) * this.w + Math.floor(x / k)];
        if (!col) continue;
        const [r, gg, b] = mode ? rgb(mode) : rgb(col);
        const i = (y * this.w * k + x) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
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
    return shades[clamp(i, 0, shades.length - 1)];
  }
  function fromRows(rows, pal) {
    const w = Math.max(...rows.map((r) => r.length));
    const p = new Pix(w + 2, rows.length + 2);
    rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch !== '.') p.set(x + 1, y + 1, pal[ch] || PAL[ch]); } });
    return p;
  }

  // sprite = { c, w, h, ax, ay, lights, smoke } with (ax, ay) the anchor inside the image
  const cache = new Map();
  function keyed(key, make) {
    let s = cache.get(key);
    if (!s) {
      const r = make();
      const pix = r.noOutline ? r.pix : r.pix.outline(r.outline);
      s = { pix, c: pix.canvas(), w: pix.w, h: pix.h, ax: r.ax, ay: r.ay, lights: r.lights || [], smoke: r.smoke || null, key };
      cache.set(key, s);
    }
    return s;
  }
  function variant(base, key, fn) {
    const k = base.key + key;
    let s = cache.get(k);
    if (!s) { s = fn(base); s.key = k; cache.set(k, s); }
    return s;
  }
  function flip(s) {
    return variant(s, '|f', () => {
      const pix = s.pix.flipped();
      return { pix, c: pix.canvas(), w: s.w, h: s.h, ax: s.w - 1 - s.ax, ay: s.ay };
    });
  }
  function tint(s, color) { return variant(s, '|t' + color, () => ({ pix: s.pix, c: s.pix.canvas(color), w: s.w, h: s.h, ax: s.ax, ay: s.ay })); }

  // ------------------------------------------------------------------ heroes
  const LEGS = {
    warrior: [['...HH..HH...', '...HH..HH...', '..BBB..BBB..'], ['..HH....HH..', '..HH...HH...', '.BBB...BBB..']],
    ranger: [['...bb..bb...', '...bb..bb...', '...BB..BB...'], ['..bb....bb..', '..bb...bb...', '..BB...BB...']],
    mage: [['..TTTTTTTTT.', '...BB...BB..'], ['..TTTTTTTTT.', '..BB....BB..']],
    robe: [['..wwwwwwwww.', '...BB...BB..'], ['..wwwwwwwww.', '..BB....BB..']],
    green: [['..LLLLLLLLL.', '...BB...BB..'], ['..LLLLLLLLL.', '..BB....BB..']],
    storm: [['..CCCCCCCCC.', '...BB...BB..'], ['..CCCCCCCCC.', '..BB....BB..']],
    dark: [['...DD..DD...', '...DD..DD...', '...ee..ee...'], ['..DD....DD..', '..DD...DD...', '..ee...ee...']],
  };
  const HERO = {
    warrior: { legs: 'warrior', rows: ['w..........w', 'ww.gggggg.ww', '.wgggggggggw', '..gGGGGGGGg.', '..gsssssesg.', '..gSssssssg.', '...gGGGGGg..', '..tTTyTTTt..', '.gtTTTTTTtg.', '.gtTTyyTTtg.', '..tTTTTTTt..'] },
    ranger: { legs: 'ranger', rows: ['....LLLL....', '...LllllL...', '..LllllllL..', '.LllsssssL..', '.LlssssesL..', 'LllsssssSL..', '.LlLSSSSL...', '..tTTTTTTt..', '.stTTbTTTts.', '..tTTbbTTt..', '..tTTTTTTt..'] },
    mage: { legs: 'mage', rows: ['......PP....', '.....PpP....', '....PppP....', '....PpypP...', '...PpppppP..', '.PPPPPPPPPP.', '...sssssss..', '...sssseses.', '...wwwwwww..', '..TwwwwwwwT.', '.sTTwwwwwTTs', '..TTTwwwTTT.', '..TTTTTTTTT.'] },
    guardian: { legs: 'warrior', rows: ['....TTT.....', '...gggggg...', '..gggggggg..', '..gGGGGGGg..', '..gHeHHeHg..', '..gggggggg..', '.gGtTTTTtGg.', 'gGtTTyyTTtGg', '.gtTTTTTTtg.', '..tTTTTTTt..', '..HHHHHHHH..'] },
    berserker: { legs: 'warrior', rows: ['w..........w', 'ww.HHHHHH.ww', '.wHHHHHHHHw.', '..sssssses..', '..sssssssS..', '..oooooooo..', '..soooooos..', '.sssSssSsss.', '.sTsssssssTs', '..bbybbbbb..', '..tTTTTTTt..'] },
    sniper: { legs: 'ranger', rows: ['...BBBBB....', '..BBBBBBBB..', '.BBBBBBBBBBB', '...cccsccc..', '...sssesss..', '...ssssss...', '..tTTTTTTt..', '.btTTbTTTtb.', '..tTTbbTTt..', '..bbbbbbbb..', '..tTTTTTTt..'] },
    beastmaster: { legs: 'ranger', rows: ['..G....G....', '..GGGGGG....', '.GGgggggG...', '.GgssssesG..', '.GGsssssGG..', 'GGGSSSSSGGG.', '..tTTTTTTt..', '.stTTbTTTts.', '..tTTbbTTt..', '..tTTTTTTt..', '..GGGGGGGG..'] },
    shadow: { legs: 'dark', rows: ['....dddd....', '...dddddd...', '..dddddddd..', '..ddHHHrHr..', '..ddHHHHHH..', '...dddddd...', '..tddddddt..', '.sddTdddds..', '..dddTTddd..', '..dddddddd..', '..eeeeeeee..'] },
    storm: { legs: 'storm', rows: ['......CC....', '.....CcC....', '....CccC....', '....CcycC...', '...CcccccC..', '.CCCCCCCCCC.', '...sssssss..', '...sssseses.', '...wwwwwww..', '..CwwwwwwwC.', '.sCCwwwwwCCs', '..CCTwwwTCC.', '..CCCCCCCCC.'] },
    druid: { legs: 'green', rows: ['n.n.....n.n.', '.nn.....nn..', '..nlllllln..', '..lmlmlmll..', '...sssssss..', '...sssseses.', '...bbbbbbb..', '..LbbbbbbbL.', '.sLLbbbbbLLs', '..LLTLLLTLL.', '..LLLLLLLLL.'] },
    holy: { legs: 'robe', rows: ['...yyyyyy...', '..y......y..', '...wwwwww...', '..wwwwwwww..', '..wwsssssw..', '..wssseses..', '...ssssss...', '..yTwwwwTy..', '.swwwyywwws.', '..wwwyywww..', '..wwwwwwww..', '..yyyyyyyy..'] },
  };
  const CAVALIER = [[
    '......TT..........',
    '.....gggg.........',
    '.....ggeg.........',
    '.....gggg.........',
    '....tTTTTt....BB..',
    '....tTyTTt...Bnnn.',
    '..BbnTTTTnnnnBnnen',
    '.B.nnTTTTTnnnnnnnn',
    '...nnnnnnnnnnnbb..',
    '...nnnnnnnnnnn....',
    '...nb.nb..nb.nb...',
    '...nb.nb..nb.nb...',
    '...BB.BB..BB.BB...',
  ], [
    '......TT..........',
    '.....gggg.........',
    '.....ggeg.........',
    '.....gggg.........',
    '....tTTTTt....BB..',
    '....tTyTTt...Bnnn.',
    '.BBbnTTTTnnnnBnnen',
    '...nnTTTTTnnnnnnnn',
    '...nnnnnnnnnnnbb..',
    '...nnnnnnnnnnn....',
    '..nb..nb..nb..nb..',
    '.nb....nbnb....nb.',
    '.BB....BBBB....BB.',
  ]];
  function hero(type, rel, frame) {
    return keyed(`h:${type}:${rel}:${frame}`, () => {
      const pal = Object.assign({}, PAL, TEAM[rel]);
      if (type === 'cavalier') {
        const p = fromRows(CAVALIER[frame], pal);
        return { pix: p, ax: 9, ay: p.h - 1 };
      }
      const d = HERO[type] || HERO.warrior;
      const p = fromRows(d.rows.concat(LEGS[d.legs][frame]), pal);
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }
  const WEAPON = {
    warrior: { rows: ['..Y..........', 'BBygggggggggw', '..Y..........'], px: 1, py: 1 },
    knight: { rows: ['.Y.......', 'Bygggggga', '.Y.......'], px: 0, py: 1 },
    ranger: { rows: ['nb..', 'w.b.', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w..b', 'w.b.', 'nb..'], px: 0, py: 5 },
    mage: { rows: ['............OO.', '...........OyyO', 'Bbbbbbbbbbbnyay', '...........OyyO', '............OO.'], px: 2, py: 2 },
    lance: { rows: ['..TTT...............', 'BBbnnnnnnnnnnnnnggGw', '..y.................'], px: 2, py: 1 },
    axe: { rows: ['.........GG', '........GggG', 'BBbbbbbbbGgg', '........GggG', '.........GG'], px: 1, py: 2 },
    merc: { rows: ['.......GG', 'Bbbbbbbggg', '.......GG'], px: 1, py: 1 },
    crossbow: { rows: ['......b..', '.....b...', 'BBBBBBBgG', '.....b...', '......b..'], px: 2, py: 2 },
    dagger: { rows: ['.Y....', 'BYgggw', '.Y....'], px: 0, py: 1 },
    stormstaff: { rows: ['............CC.', '...........CccC', 'Bbbbbbbbbbbnciw', '...........CccC', '............CC.'], px: 2, py: 2 },
    druidstaff: { rows: ['...........lL..', '..........lmlL.', 'BbBbbBbbbbbbnml', '..........lLl..', '...........l...'], px: 2, py: 2 },
    holystaff: { rows: ['............y.y', '.............a.', 'YyyyyyyyyyyyaiA', '.............a.', '............y.y'], px: 2, py: 2 },
  };
  WEAPON.holystaff.rows = WEAPON.holystaff.rows.map((r) => r.replace('A', 'a'));
  function weapon(kind) {
    return keyed('w:' + kind, () => {
      const d = WEAPON[kind];
      const p = fromRows(d.rows, PAL);
      return { pix: p, ax: d.px + 1, ay: d.py + 1 };
    });
  }
  function shieldSprite(rel) {
    return keyed('shield:' + rel, () => {
      const p = fromRows(['yyyyyy', 'yTTTTy', 'yTUyTy', 'yTyyTy', 'yTTyTy', 'yTTTTy', '.yTTy.', '..yy..'], Object.assign({}, PAL, TEAM[rel]));
      return { pix: p, ax: 4, ay: 5 };
    });
  }

  // ------------------------------------------------------------------ monsters & allies
  const MOB = {
    wolf: [['...........G.G.', '..........GGGG.', 'H...GGGGGGGGyGG', '.HHGGGGGGGGGGGe', '...GgggggggGG..', '...GG.G...GG.G.', '...H..H...H..H.'],
      ['...........G.G.', '..........GGGG.', '.H..GGGGGGGGyGG', 'H.HGGGGGGGGGGGe', '...GgggggggGG..', '..GG..GG.GG..G.', '..H...H..H...H.']],
    goblin: [['...llllll...', 'l.llllllll.l', 'lllllllllyll', '.llllllllll.', '..llllRRll..', '...bbbbbb...', '..lbbbbbbl..', '...bbbbbb...', '...BB..BB...'],
      ['...llllll...', 'l.llllllll.l', 'lllllllllyll', '.llllllllll.', '..llllRRll..', '...bbbbbb...', '..lbbbbbbl..', '...bbbbbb...', '..BB....BB..']],
    slime: [['....mmmm....', '..mmwwmmmm..', '.mmwwmmmmmm.', '.mmmmmmmmmm.', 'mmmmmmemmeme', 'mmmmmmmmmmmm', 'lmmmmmmmmmml', '.llllllllll.'],
      ['............', '...mmmmmm...', '.mmwwmmmmmm.', 'mmwwmmmmmmmm', 'mmmmmmemmemm', 'mmmmmmmmmmmm', 'lmmmmmmmmmml', 'llllllllllll']],
    skeleton: [['...zzzzzz...', '..zzzzzzzz..', '..zzzzeZze..', '..zzzzzzzz..', '...zZzZzZ...', '....zzzz....', '..z.zZZz.z..', '.z..zZZz..z.', '....zzzz....', '....z..z....', '...zz..zz...'],
      ['...zzzzzz...', '..zzzzzzzz..', '..zzzzeZze..', '..zzzzzzzz..', '...zZzZzZ...', '....zzzz....', '.z..zZZz..z.', '..z.zZZz.z..', '....zzzz....', '...z....z...', '..zz....zz..']],
    imp: [['..H.....H...', '..HrrrrrH...', '.rrrrrrrrr..', '.rrrryrryr..', '.rrrrrrrrr..', 'R.rrRRRrr..R', 'RRrrrrrrrrRR', '.RRrrrrrrRR.', '...rr..rr...', '...R....R...'],
      ['..H.....H...', '..HrrrrrH...', '.rrrrrrrrr..', '.rrrryrryr..', 'RrrrrrrrrrR.', 'RRrrRRRrrRR.', '.RrrrrrrrrR.', '..rrrrrrr...', '...rr..rr...', '...R....R...']],
    golem: [['......xxxxxx......', '....xxxxxxxxxx....', '...xxvvxxxxxxxx...', '...xvvxxxxxlxxx...', '...xxxxxoxxxoxx...', '...xxxxxxxxxxxx...', '.xxxXxxxxxxxxXxxx.', 'xxxxXxxlxxxxxXxxxx', 'xxx.XxxxxxxxxX.xxx', 'xxx.XxxxxxxxxX.xxx', '.x..XXxxxxxxXX..x.', '....xxxx..xxxx....', '....xxxx..xxxx....', '....XXXX..XXXX....'],
      ['......xxxxxx......', '....xxxxxxxxxx....', '...xxvvxxxxxxxx...', '...xvvxxxxxlxxx...', '...xxxxxoxxxoxx...', '.x.xxxxxxxxxxxx.x.', 'xxxXxxxxxxxxxxXxxx', 'xxxXxxxlxxxxxxXxxx', 'xx..XxxxxxxxxX..xx', '....XxxxxxxxxX....', '....XXxxxxxxXX....', '...xxxx....xxxx...', '...xxxx....xxxx...', '...XXXX....XXXX...']],
  };
  const ALLY = {
    knight: [['....TT......', '...TTgggg...', '..ggggggggg.', '..gGGeGGeGg.', '..ggggggggg.', '..gGGGGGGGg.', '..TTTTTTTT..', '.gTTTwwTTTg.', '.gTTTwwTTTg.', '..TTTTTTTT..', '...HH..HH...', '...BB..BB...'],
      ['....TT......', '...TTgggg...', '..ggggggggg.', '..gGGeGGeGg.', '..ggggggggg.', '..gGGGGGGGg.', '..TTTTTTTT..', '.gTTTwwTTTg.', '.gTTTwwTTTg.', '..TTTTTTTT..', '..HH....HH..', '..BB....BB..']],
    merc: [['...TTTTT....', '..TTTTTTTU..', '..ssssses...', '..sssssss...', '..BBBBBB....', '..bBBBBb....', '.sbbTTbbs...', '.sbbTTbbs...', '..bbbbbb....', '..BBBBBB....', '...bb..bb...', '...BB..BB...'],
      ['...TTTTT....', '..TTTTTTTU..', '..ssssses...', '..sssssss...', '..BBBBBB....', '..bBBBBb....', '.sbbTTbbs...', '.sbbTTbbs...', '..bbbbbb....', '..BBBBBB....', '..bb....bb..', '..BB....BB..']],
    wolf: MOB.wolf.map((fr) => fr.map((row, y) => (y === 3 ? row.slice(0, 10) + 'TT' + row.slice(12) : y === 4 ? row.slice(0, 10) + 'T' + row.slice(11) : row))),
    ent: [['...LlllL....', '..LlmmllL...', '.LlllmlllL..', '..LlllllL...', '...bbbbb....', '..bbybyb....', '..bbbbbb....', '.b.bTbb.b...', 'b..bbbb..b..', '...b..b.....', '..bb..bb....'],
      ['...LlllL....', '..LlmmllL...', '.LlllmlllL..', '..LlllllL...', '...bbbbb....', '..bbybyb....', '..bbbbbb....', 'b..bTbb..b..', '.b.bbbb.b...', '...b..b.....', '.bb....bb...']],
  };
  function mob(type, frame) {
    return keyed(`m:${type}:${frame}`, () => {
      const p = fromRows(MOB[type][frame], PAL);
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }
  function ally(type, rel, frame) {
    return keyed(`k:${type}:${rel}:${frame}`, () => {
      const p = fromRows((ALLY[type] || ALLY.knight)[frame], Object.assign({}, PAL, TEAM[rel]));
      return { pix: p, ax: Math.floor(p.w / 2), ay: p.h - 1 };
    });
  }

  // ------------------------------------------------------------------ nature
  const LEAF = {
    [S.B.MEADOW]: ['#3f7e37', '#54a044', '#6cba52', '#8cd066', '#b4e68c'],
    [S.B.FOREST]: ['#2e6a30', '#3e823a', '#4f9a47', '#68b058', '#8ccb72'],
    [S.B.SWAMP]: ['#3f5a36', '#4e6e42', '#5e8250', '#72965e', '#8eae74'],
  };
  function tree(biome, v, size) {
    return keyed(`t:${biome}:${v % 5}:${size}`, () => {
      const R = rnd(v * 7919 + biome * 31 + size);
      const W = size * 2 + 8, Hh = Math.round(size * 2.6) + 6;
      const p = new Pix(W, Hh);
      const cx = W / 2 - 0.5;
      const baseY = Hh - 2;
      if (biome === S.B.SNOW) {
        const trunkH = Math.max(3, Math.round(size * 0.35));
        p.rect(Math.round(cx) - 1, baseY - trunkH, 3, trunkH + 1, (x) => (x > cx ? '#5a3a22' : '#7b5234'));
        const tiers = 3, top = 1;
        for (let i = 0; i < tiers; i++) {
          const ty = top + (i * (baseY - trunkH - top)) / (tiers + 0.4);
          const by = ty + (baseY - trunkH - top) / (tiers - 0.6);
          const hw = size * (0.55 + i * 0.25);
          p.poly([[cx, ty], [cx + hw, by], [cx - hw, by]], (x, y) => {
            const k = (x - cx) / hw + ((y - ty) / (by - ty)) * 0.3;
            const sh = ['#4f9470', '#3f7f5e', '#30684b', '#24533a'];
            return sh[clamp(Math.floor(k * 2 + 1.4 + bayer(x, y) - 0.5), 0, 3)];
          });
          for (let x = -hw; x <= hw; x++) if (R() < 0.75) p.set(cx + x, by - 1 - Math.floor(Math.abs(x) * 0.15), '#f8fbfd');
          p.line(cx, ty, cx - hw * 0.6, by - 2, '#eef5f9');
        }
        return { pix: p, ax: Math.round(cx), ay: baseY };
      }
      if (biome === S.B.VOLCANO) {
        const col = ['#3e2a20', '#5a4032', '#7a5a46'];
        p.line(cx, baseY, cx, baseY - size * 1.8, col[1], 3);
        p.line(cx + 1, baseY, cx + 1, baseY - size * 1.8, col[0], 1);
        for (let i = 0; i < 4; i++) {
          const y0 = baseY - size * (0.8 + i * 0.3);
          const dir = i % 2 ? 1 : -1;
          const x1 = cx + dir * size * (0.6 + R() * 0.4), y1 = y0 - size * (0.4 + R() * 0.3);
          p.line(cx, y0, x1, y1, col[1], 2);
          p.line(x1, y1, x1 + dir * 2, y1 - 2, col[2]);
        }
        for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, baseY - R() * size * 1.5, '#ff7447');
        return { pix: p, ax: Math.round(cx), ay: baseY };
      }
      const leaf = LEAF[biome] || LEAF[S.B.MEADOW];
      const trunkH = Math.round(size * 0.7);
      p.rect(Math.round(cx) - 1, baseY - trunkH, 3, trunkH + 1, (x) => (x > cx ? '#6b4428' : '#9a6838'));
      p.set(Math.round(cx) - 2, baseY, '#6b4428'); p.set(Math.round(cx) + 2, baseY, '#6b4428');
      const ccy = baseY - trunkH - size * 0.75;
      const blobs = [[0, 0, 1]];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + R();
        blobs.push([Math.cos(a) * size * 0.45, Math.sin(a) * size * 0.35, 0.6 + R() * 0.2]);
      }
      for (const [bx, by, br] of blobs) {
        p.ell(cx + bx, ccy + by, size * 0.62 * br + 1, size * 0.55 * br + 1, (x, y) => {
          const nx = (x - cx) / (size * 1.05), ny = (y - ccy) / (size * 0.95);
          return shadeAt(x, y, clamp(nx, -1, 1), clamp(ny, -1, 1), leaf, 0.05);
        });
      }
      if (biome === S.B.SWAMP) {
        for (let i = 0; i < 7; i++) {
          const x = cx + (R() - 0.5) * size * 1.6, y0 = ccy + size * 0.3;
          p.line(x, y0, x, y0 + 2 + R() * size * 0.6, leaf[1]);
        }
      } else if (R() < 0.55) {
        for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, ccy + (R() - 0.3) * size * 0.6, biome === S.B.FOREST ? '#e0544a' : '#ffd6e6');
      }
      return { pix: p, ax: Math.round(cx), ay: baseY };
    });
  }
  const ROCK = {
    default: ['#6e675c', '#8a8378', '#a49d91', '#c0b9ac', '#dcd6c9'],
    snow: ['#6c7a88', '#8c99a8', '#adbac6', '#cfd9e2', '#f0f5f8'],
    volcano: ['#2e2530', '#40354a', '#554862', '#6c5e7c', '#857696'],
    gold: ['#4a4038', '#5c5148', '#6e6258', '#82756a', '#978a7e'],
  };
  function rockShape(p, cx, cy, rx, ry, R, shades) {
    const n = 7, pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + R() * 0.5;
      const k = 0.75 + R() * 0.25;
      pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
    }
    p.poly(pts, (x, y) => {
      const a = Math.atan2((y - cy) / ry, (x - cx) / rx);
      const facet = Math.floor(((a + Math.PI) / (Math.PI * 2)) * n);
      const fa = ((facet + 0.5) / n) * Math.PI * 2 - Math.PI;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return shadeAt(x, y, Math.cos(fa) * Math.min(1, d * 1.2) * 0.9, Math.sin(fa) * Math.min(1, d * 1.2) * 0.9, shades, 0.05);
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
      if (biome === S.B.SNOW) p.ell(cx - size * 0.2, cy - size * 0.5, size * 0.5, size * 0.22, '#f8fbfd');
      if (biome === S.B.VOLCANO) { p.line(cx - size * 0.5, cy + 1, cx, cy + size * 0.3, '#ff7447'); p.line(cx, cy + size * 0.3, cx + size * 0.4, cy - 1, '#ffb84a'); }
      if (biome === S.B.MOUNTAIN || biome === S.B.FOREST || biome === S.B.MEADOW) for (let i = 0; i < 3; i++) p.set(cx + (R() - 0.5) * size, cy - size * 0.4 + R() * 2, '#7a9c52');
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
      const gold = ['#a8761a', '#e0a428', '#ffd84f', '#fff4b0'];
      for (let i = 0; i < 3; i++) {
        const x = cx + (i - 1) * size * 0.5 + (R() - 0.5) * 2, y = cy - size * 0.2 + (R() - 0.5) * 2;
        const h = size * (0.7 + R() * 0.5), w = Math.max(1.5, size * 0.28);
        p.poly([[x, y - h], [x + w, y - h * 0.4], [x + w * 0.6, y + 1], [x - w * 0.6, y + 1], [x - w, y - h * 0.4]], (px, py) => gold[clamp(Math.floor(1.8 - ((px - x) / w) * 1.3 + bayer(px, py) - 0.5), 0, 3)]);
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

  // ------------------------------------------------------------------ building helpers
  const STONE = ['#6f675b', '#8e8574', '#aca28f', '#c7bea9', '#e0d9c6'];
  const PSTONE = ['#4f4764', '#665d80', '#81779c', '#9d93b8', '#bcb3d4'];
  const WOOD = ['#4e321c', '#6b4628', '#8a5c34', '#a8764a', '#c79464'];
  const PLASTER = ['#d8c8a4', '#e8dcbe', '#f4ecd6'];
  const MORTAR = '#5e574c';
  function bricks(ramp, x0, x1, oy) {
    // cylinder-ish shading across [x0, x1] with offset brick courses
    return (x, y) => {
      const yy = y - oy, row = Math.floor(yy / 3);
      if (yy % 3 === 2) return MORTAR;
      if ((x + (row % 2) * 3) % 6 === 5) return MORTAR;
      const k = (x - x0) / Math.max(1, x1 - x0);
      let i = k < 0.12 ? 3 : k < 0.55 ? 2 : k < 0.85 ? 1 : 0;
      if ((x * 7 + row * 13) % 11 === 0) i = Math.min(4, i + 1);
      return ramp[i + (bayer(x, y) > 0.8 && i < 4 ? 0 : 0)];
    };
  }
  function shingles(ramp, x0, x1, yTop) {
    return (x, y) => {
      const row = Math.floor((y - yTop) / 2);
      if ((y - yTop) % 2 === 1 && (x + row * 2) % 4 === 0) return ramp[0];
      if ((y - yTop) % 2 === 1) return ramp[1];
      const k = (x - x0) / Math.max(1, x1 - x0);
      return k < 0.3 ? ramp[3] : k < 0.75 ? ramp[2] : ramp[1];
    };
  }
  function roofTrap(p, x0, x1, yTop, yBase, ramp, inset) {
    // roof seen from the front: trapezoid with shingle rows and a lit ridge
    const h = yBase - yTop;
    p.poly([[x0 + inset, yTop], [x1 + 1 - inset, yTop], [x1 + 1, yBase], [x0, yBase]], shingles(ramp, x0, x1, yTop));
    p.rect(x0 + inset, yTop, x1 - x0 + 1 - inset * 2, 1, ramp[4]);
    p.rect(x0, yBase - 1, x1 - x0 + 1, 1, ramp[0]);
    void h;
  }
  function cone(p, cx, yTop, yBase, hw, ramp) {
    p.poly([[cx, yTop], [cx + hw + 0.5, yBase], [cx - hw - 0.5, yBase]], (x, y) => {
      const k = (x - cx) / hw;
      const row = Math.floor((y - yTop) / 2);
      if ((y - yTop) % 2 === 1 && (x + row) % 3 === 0) return ramp[0];
      return ramp[clamp(Math.floor(2.6 - k * 1.8 + bayer(x, y) * 0.8 - 0.4), 0, 4)];
    });
    p.rect(Math.round(cx - hw), yBase - 1, Math.round(hw * 2) + 1, 1, ramp[0]);
  }
  function windowLit(p, x, y, w, h, arch) {
    p.rect(x - 1, y - 1, w + 2, h + 2, '#3a2e24');
    p.rect(x, y, w, h, (xx, yy) => (yy === y ? '#fff2b8' : yy < y + h / 2 ? '#ffd86a' : '#f2a844'));
    if (w >= 3) p.rect(x + Math.floor(w / 2), y, 1, h, '#6b4428');
    if (h >= 4) p.rect(x, y + Math.floor(h / 2), w, 1, '#6b4428');
    if (arch) p.rect(x, y - 1, w, 1, '#3a2e24');
    p.rect(x - 1, y + h + 1, w + 2, 1, STONE[4]);
  }
  function door(p, x, y, w, h) {
    p.rect(x - 1, y - 1, w + 2, h + 1, STONE[1]);
    p.ell(x + (w - 1) / 2, y + 1, w / 2 + 0.5, 2, STONE[1]);
    p.rect(x, y, w, h, (xx) => ((xx - x) % 2 ? WOOD[2] : WOOD[3]));
    p.ell(x + (w - 1) / 2, y + 1, w / 2 - 0.3, 1.6, (xx) => ((xx - x) % 2 ? WOOD[2] : WOOD[3]));
    p.rect(x, y + 2, w, 1, '#3b3444'); p.rect(x, y + h - 3, w, 1, '#3b3444');
    p.set(x + w - 2, y + Math.floor(h / 2), '#ffd84f');
  }
  function timber(p, x0, y0, w, h) {
    p.rect(x0, y0, w, h, (x, y) => PLASTER[(x * 3 + y * 5) % 7 === 0 ? 0 : (x + y) % 5 === 0 ? 2 : 1]);
    p.rect(x0, y0, w, 1, WOOD[1]); p.rect(x0, y0 + h - 1, w, 1, WOOD[1]);
    for (let x = x0; x < x0 + w; x += 6) p.rect(x, y0, 1, h, WOOD[1]);
    p.rect(x0 + w - 1, y0, 1, h, WOOD[1]);
    for (let x = x0; x + 6 <= x0 + w; x += 12) p.line(x, y0 + h - 1, x + 6, y0, WOOD[2]);
  }
  function grass(p, x0, x1, y, R) {
    for (let x = x0; x <= x1; x++) {
      if (R() < 0.45) p.set(x, y, R() < 0.5 ? '#5aa044' : '#7cc05a');
      if (R() < 0.18) p.set(x, y - 1, '#7cc05a');
      if (R() < 0.05) p.set(x, y - 1, ['#fff3a8', '#ffb0cc', '#ffffff'][Math.floor(R() * 3)]);
    }
  }
  function banner(p, x, y, h, ramp) {
    p.rect(x - 1, y, 5, 1, WOOD[1]);
    p.rect(x, y + 1, 3, h, (xx, yy) => (xx === x ? ramp[3] : ramp[2]));
    p.set(x + 1, y + 3, '#ffd84f'); p.set(x + 1, y + 4, '#ffd84f'); p.set(x, y + 4, '#ffd84f'); p.set(x + 2, y + 4, '#ffd84f');
    p.set(x, y + h + 1, ramp[2]); p.set(x + 2, y + h + 1, ramp[2]);
  }
  function flag(p, x, y, ramp, h) {
    p.line(x, y, x, y - h, '#4a3624');
    p.set(x, y - h - 1, '#ffd84f');
    p.rect(x + 1, y - h, 5, 3, (xx, yy) => (yy === y - h ? ramp[4] : xx > x + 3 ? ramp[2] : ramp[3]));
    p.set(x + 6, y - h + 1, ramp[2]);
  }
  function torch(p, x, y, lights) {
    p.set(x, y, '#4a3624'); p.set(x, y + 1, '#4a3624'); p.set(x - 1, y + 2, '#3b3444');
    lights.push([x, y - 1]);
  }
  function cylinder(p, x0, x1, y0, y1, ramp) { p.rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1, bricks(ramp, x0, x1, y0)); }

  // ------------------------------------------------------------------ buildings
  const EXTRA = { townhall: 36, wall: 11, tower: 28, magetower: 34, sawmill: 24, quarry: 14, mine: 18, barracks: 22, shrine: 24, warcamp: 20 };
  function building(type, rel) {
    return keyed(`b:${type}:${rel}`, () => {
      const ramp = RAMP[rel];
      const f = Math.round(S.BUILDINGS[type].size / ART);
      const extra = EXTRA[type];
      const W = f + 2, Hh = f + extra + 2;
      const p = new Pix(W, Hh);
      const B = Hh - 2, L = 1, Rr = f;
      const cx = Math.round(W / 2) - 1 + (W % 2 ? 0 : 0.5);
      const R = rnd(type.length * 977 + rel);
      const lights = [];
      let smoke = null;
      switch (type) {
        case 'townhall': {
          const k0 = L + 11, k1 = Rr - 11;
          cylinder(p, k0, k1, B - 44, B - 13, STONE);
          windowLit(p, k0 + 3, B - 38, 3, 4, true); windowLit(p, k1 - 5, B - 38, 3, 4, true);
          windowLit(p, Math.round(cx) - 1, B - 30, 3, 5, true);
          roofTrap(p, k0 - 2, k1 + 2, B - 60, B - 43, ramp, 6);
          flag(p, Math.round(cx), B - 60, ramp, 9);
          for (const tx of [L, Rr - 10]) {
            cylinder(p, tx, tx + 10, B - 30, B, STONE);
            windowLit(p, tx + 4, B - 23, 2, 3, true);
            cone(p, tx + 5, B - 46, B - 29, 7, ramp);
            p.set(tx + 5, B - 47, '#ffd84f');
            banner(p, tx + 4, B - 16, 7, ramp);
          }
          cylinder(p, L + 11, Rr - 11, B - 12, B, STONE);
          for (let x = L + 11; x <= Rr - 11; x++) if ((x - L - 11) % 4 < 2) p.rect(x, B - 14, 1, 2, STONE[3]);
          door(p, Math.round(cx) - 4, B - 9, 9, 10);
          torch(p, Math.round(cx) - 7, B - 8, lights); torch(p, Math.round(cx) + 7, B - 8, lights);
          p.rect(L, B, f, 1, STONE[0]);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'wall': {
          const top = B - f - 8;
          p.rect(L, top + 3, f, 9, (x, y) => ((x * 3 + y * 7) % 13 === 0 ? STONE[3] : y === top + 3 ? STONE[4] : STONE[3]));
          p.rect(L, top, 4, 3, STONE[3]); p.rect(Rr - 3, top, 4, 3, STONE[3]);
          p.rect(L, top, 4, 1, STONE[4]); p.rect(Rr - 3, top, 4, 1, STONE[4]);
          cylinder(p, L, Rr, top + 12, B, STONE);
          p.rect(L, top + 12, f, 1, ramp[2]);
          for (let i = 0; i < 3; i++) p.set(L + 2 + Math.floor(R() * (f - 4)), top + 14 + Math.floor(R() * (f - 4)), '#6e9a4a');
          p.rect(L, B, f, 1, STONE[0]);
          break;
        }
        case 'tower': {
          cylinder(p, L + 3, Rr - 3, B - 27, B, STONE);
          door(p, Math.round(cx) - 2, B - 6, 5, 7);
          windowLit(p, Math.round(cx) - 1, B - 18, 2, 3, true);
          // wooden fighting platform
          p.rect(L, B - 31, f, 4, (x, y) => (y === B - 31 ? WOOD[4] : x % 3 === 0 ? WOOD[1] : WOOD[2]));
          p.line(L + 1, B - 27, L + 3, B - 24, WOOD[1]); p.line(Rr - 1, B - 27, Rr - 3, B - 24, WOOD[1]);
          for (const x of [L + 1, Rr - 1]) p.rect(x, B - 40, 1, 9, WOOD[1]);
          for (let x = L; x <= Rr; x += 2) p.rect(x, B - 33, 1, 2, WOOD[3]);
          p.rect(L, B - 34, f, 1, WOOD[2]);
          // archer under the roof
          p.rect(Math.round(cx) - 1, B - 38, 3, 3, ramp[3]);
          p.rect(Math.round(cx), B - 37, 1, 1, '#f5cfa3');
          p.rect(Math.round(cx) - 2, B - 35, 5, 2, ramp[2]);
          cone(p, cx, B - 52, B - 39, 12, ramp);
          banner(p, Math.round(cx) - 1, B - 26, 8, ramp);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'magetower': {
          cylinder(p, L + 4, Rr - 4, B - 32, B, PSTONE);
          for (const y of [B - 31, B - 17]) p.rect(L + 4, y, f - 8, 1, '#e0b44a');
          door(p, Math.round(cx) - 2, B - 6, 5, 7);
          // stained glass
          p.rect(Math.round(cx) - 2, B - 28, 5, 8, (x, y) => ['#78e0ff', '#c89cff', '#ff9ac8', '#9cf0b8'][(x + y) % 4]);
          p.rect(Math.round(cx), B - 28, 1, 8, '#3a2e44'); p.rect(Math.round(cx) - 2, B - 24, 5, 1, '#3a2e44');
          p.rect(L + 2, B - 35, f - 4, 3, (x, y) => (y === B - 35 ? PSTONE[4] : PSTONE[2]));
          p.rect(L + 2, B - 36, f - 4, 1, ramp[2]);
          cone(p, cx, B - 58, B - 36, 10, ['#3e2270', '#5a3294', '#7848bc', '#9a6ae0', '#c29cff']);
          for (let i = 0; i < 5; i++) p.set(cx + (R() - 0.5) * 10, B - 38 - R() * 16, '#ffd84f');
          for (const x of [L + 1, Rr - 1]) { p.poly([[x, B - 5], [x + 1.5, B], [x - 1.5, B]], '#78e0ff'); p.set(x, B - 3, '#e6fbff'); }
          grass(p, L, Rr, B, R);
          break;
        }
        case 'sawmill': {
          timber(p, L + 1, B - 14, 16, 15);
          windowLit(p, L + 3, B - 10, 3, 3);
          door(p, L + 11, B - 8, 4, 9);
          roofTrap(p, L - 1, L + 18, B - 28, B - 13, ['#5e2a1a', '#7e3a24', '#a04e30', '#c06a42', '#dc9068'], 3);
          cylinder(p, L + 13, L + 15, B - 32, B - 24, STONE);
          smoke = [L + 14, B - 33];
          // open shed with a big blade
          for (const x of [Rr - 7, Rr]) p.rect(x, B - 17, 1, 18, WOOD[1]);
          p.poly([[Rr - 8, B - 19], [Rr + 1, B - 17], [Rr + 1, B - 15], [Rr - 8, B - 16]], (x) => (x % 2 ? WOOD[3] : WOOD[2]));
          p.ell(Rr - 3.5, B - 8, 3.5, 3.5, (x, y) => ((x + y) % 2 ? '#dfe5ec' : '#aab4c0'));
          p.set(Rr - 3.5, B - 8, '#5f6875');
          p.rect(Rr - 7, B - 4, 8, 2, WOOD[3]); p.rect(Rr - 7, B - 3, 8, 1, WOOD[1]);
          for (let i = 0; i < 3; i++) { p.ell(L + 3 + i * 3, B - 1, 1.4, 1.4, WOOD[4]); p.set(L + 3 + i * 3, B - 1, WOOD[2]); }
          flag(p, L + 8, B - 28, ramp, 6);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'quarry': {
          const cy = B - 10;
          p.ell(cx, cy, 12, 9, (x, y) => ((x * 5 + y * 3) % 9 === 0 ? '#7cc05a' : '#5aa044'));
          p.ell(cx, cy + 0.5, 10.5, 7.5, STONE[3]);
          p.ell(cx, cy + 1.5, 8, 5.5, STONE[2]);
          p.ell(cx, cy + 2.5, 5, 3.5, STONE[1]);
          p.ell(cx, cy + 3, 2.5, 1.8, STONE[0]);
          for (const [dx, dy] of [[6, 2], [9, 0], [7.5, -2]]) {
            const x = Math.round(cx + dx), y = Math.round(cy + dy);
            p.rect(x - 2, y - 1, 4, 3, STONE[2]); p.rect(x - 2, y - 2, 4, 1, STONE[4]); p.rect(x + 1, y - 1, 1, 3, STONE[1]);
          }
          // crane
          p.line(L + 2, B - 2, L + 6, B - 22, WOOD[2]); p.line(L + 10, B - 2, L + 6, B - 22, WOOD[1]);
          p.line(L + 6, B - 22, L + 16, B - 19, WOOD[3]);
          p.line(L + 16, B - 19, L + 16, B - 12, '#d8cfae');
          p.rect(L + 15, B - 12, 3, 3, STONE[3]);
          flag(p, Rr - 1, B - 6, ramp, 7);
          break;
        }
        case 'mine': {
          p.ell(cx, B - 8, 12.5, 16, (x, y, nx, ny) => (y < B - 17 + Math.sin(x) * 1.5 ? shadeAt(x, y, nx, ny, ['#3f7a36', '#54a044', '#6cba52', '#8cd066'], 0) : shadeAt(x, y, nx, ny, ['#5c5044', '#74665a', '#8e8070', '#a89a88'], 0)));
          p.rect(Math.round(cx) - 3, B - 11, 7, 12, '#241a14');
          p.rect(Math.round(cx) - 5, B - 12, 2, 13, WOOD[2]); p.rect(Math.round(cx) + 4, B - 12, 2, 13, WOOD[2]);
          p.rect(Math.round(cx) - 6, B - 14, 13, 2, WOOD[3]); p.rect(Math.round(cx) - 6, B - 13, 13, 1, WOOD[1]);
          p.set(Math.round(cx), B - 16, '#3b3444');
          lights.push([Math.round(cx), B - 16]);
          for (let x = Math.round(cx) - 3; x <= Math.round(cx) + 3; x++) p.set(x, B, x % 2 ? '#8a8378' : WOOD[1]);
          p.rect(Rr - 7, B - 5, 7, 4, WOOD[2]); p.rect(Rr - 7, B - 5, 7, 1, WOOD[4]);
          for (let i = 0; i < 4; i++) p.set(Rr - 6 + i * 2, B - 6, i % 2 ? '#fff4b0' : '#ffd84f');
          p.set(Rr - 6, B - 1, '#3b3444'); p.set(Rr - 2, B - 1, '#3b3444');
          flag(p, Math.round(cx) + 2, B - 23, ramp, 6);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'barracks': {
          p.rect(L, B - 2, f, 3, (x, y) => (y === B - 2 ? STONE[3] : STONE[2]));
          timber(p, L + 1, B - 15, f - 2, 13);
          door(p, Math.round(cx) - 2, B - 10, 5, 8);
          windowLit(p, L + 4, B - 11, 3, 3); windowLit(p, Rr - 6, B - 11, 3, 3);
          torch(p, Math.round(cx) - 4, B - 9, lights); torch(p, Math.round(cx) + 4, B - 9, lights);
          roofTrap(p, L - 1, Rr + 1, B - 30, B - 14, ramp, 5);
          for (const x of [L + 9, Rr - 9]) { p.ell(x, B - 7, 1.6, 1.6, ramp[2]); p.set(x, B - 7, '#ffd84f'); }
          flag(p, Math.round(cx), B - 30, ramp, 7);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'shrine': {
          p.ell(cx, B - 6, 10, 6, (x, y, nx, ny) => shadeAt(x, y, nx, ny, ['#8e8676', '#b4ac9c', '#d6d0c2', '#f2eee4'], 0));
          p.ell(cx, B - 7, 8.5, 4.5, (x, y, nx, ny) => shadeAt(x, y, nx, ny, ['#b4ac9c', '#d6d0c2', '#f2eee4', '#ffffff'], 0.1));
          const pillar = (x, yb) => {
            p.rect(x - 1, yb - 13, 3, 13, (xx) => (xx === x + 1 ? '#c4bcaa' : xx === x ? '#f2eee4' : '#ffffff'));
            p.rect(x - 1, yb - 14, 3, 1, '#e0b44a'); p.rect(x - 1, yb, 3, 1, '#c4bcaa');
          };
          pillar(Math.round(cx) - 7, B - 9); pillar(Math.round(cx) + 7, B - 9);
          p.rect(Math.round(cx) - 8, B - 24, 17, 2, (x, y) => (y === B - 24 ? '#ffe89a' : '#e0b44a'));
          p.poly([[cx, B - 21], [cx + 3, B - 14], [cx, B - 8], [cx - 3, B - 14]], (x) => (x < cx ? '#c8ffdc' : x > cx ? '#48d884' : '#8cffb8'));
          p.set(cx - 1, B - 16, '#ffffff');
          pillar(Math.round(cx) - 5, B - 3); pillar(Math.round(cx) + 5, B - 3);
          p.set(cx, B - 2, ramp[3]);
          grass(p, L, Rr, B, R);
          break;
        }
        case 'warcamp': {
          // palisade
          for (let x = L; x <= Rr; x += 2) {
            const h = 7 + ((x * 7) % 3);
            p.rect(x, B - h, 2, h + 1, (xx) => (xx === x ? WOOD[3] : WOOD[1]));
            p.set(x, B - h - 1, WOOD[4]);
          }
          // hide tent
          p.poly([[cx - 1, B - 26], [Rr - 3, B - 8], [L + 3, B - 8]], (x, y) => ((x + y) % 5 === 0 ? '#8a5a38' : x < cx ? '#c89066' : '#a8704a'));
          p.poly([[cx - 1, B - 18], [cx + 3, B - 8], [cx - 5, B - 8]], '#3a2a20');
          p.line(cx - 1, B - 26, cx - 4, B - 30, WOOD[2]); p.line(cx - 1, B - 26, cx + 2, B - 30, WOOD[2]);
          // weapon rack with axes
          p.rect(L + 1, B - 13, 6, 1, WOOD[2]);
          for (const x of [L + 2, L + 5]) { p.line(x, B - 16, x, B - 9, WOOD[1]); p.rect(x - 1, B - 16, 3, 2, '#c9d0d8'); }
          // campfire
          p.ell(Rr - 5, B - 2, 2.5, 1.2, '#6b6255');
          p.set(Rr - 6, B - 3, WOOD[1]); p.set(Rr - 4, B - 3, WOOD[1]);
          lights.push([Rr - 5, B - 4]);
          smoke = [Rr - 5, B - 6];
          flag(p, Rr - 1, B - 12, ramp, 12);
          grass(p, L, Rr, B, R);
          break;
        }
      }
      return { pix: p, ax: Math.round(W / 2), ay: B, lights, smoke };
    });
  }
  function star() { return keyed('star', () => ({ pix: fromRows(['.y.', 'yay', '.y.'], PAL), ax: 2, ay: 2 })); }

  // ------------------------------------------------------------------ bosses
  // anim: 'move' (6-frame walk / hover cycle) or 'atk' (3-frame attack)
  function boss(key, anim, frame) {
    return keyed(`B:${key}:${anim}:${frame}`, () => {
      const atk = anim === 'atk' ? frame : -1;
      const cyc = anim === 'atk' ? 0 : (frame / 6) * Math.PI * 2;
      const step = anim === 'atk' ? 0 : Math.sin(cyc);
      const bob = anim === 'atk' ? 0 : Math.round(Math.abs(Math.sin(cyc)) * 1.4);
      let p, ax, ay;
      if (key === 'treant') {
        p = new Pix(64, 72); ax = 32; ay = 69;
        const bark = ['#4e321c', '#6b4628', '#8a5c34', '#a8764a', '#c49062'];
        const leaf = ['#2e6a30', '#3e823a', '#4f9a47', '#68b058', '#8ccb72'];
        const by = 46 - bob + (atk === 2 ? 2 : 0);
        p.line(26, by + 14, 19, 68 - 3 * Math.max(0, step), bark[1], 4); p.line(19, 68 - 3 * Math.max(0, step), 14, 69 - 3 * Math.max(0, step), bark[1], 2);
        p.line(38, by + 14, 45, 68 - 3 * Math.max(0, -step), bark[1], 4); p.line(45, 68 - 3 * Math.max(0, -step), 50, 69 - 3 * Math.max(0, -step), bark[1], 2);
        p.line(32, by + 16, 32, 69, bark[2], 4);
        let hl, hr;
        if (atk === 0) { hl = [12, 8]; hr = [52, 8]; } else if (atk === 1) { hl = [8, 26]; hr = [56, 26]; } else if (atk === 2) { hl = [8, 64]; hr = [56, 64]; } else { hl = [7, by + 2 + step * 5]; hr = [57, by + 2 - step * 5]; }
        for (const [sx, h] of [[22, hl], [42, hr]]) {
          p.line(sx, by - 6, h[0], h[1], bark[1], 5);
          p.line(sx, by - 7, h[0], h[1] - 1, bark[3], 1);
          for (const a of [-0.7, 0, 0.7]) p.line(h[0], h[1], h[0] + Math.cos(a + (h[0] < 32 ? Math.PI : 0)) * 4, h[1] + Math.sin(a) * 3 - 1, bark[2], 1);
        }
        p.ball(32, by, 12, 17, bark);
        for (let y = by - 12; y < by + 14; y += 4) p.line(26 + ((y * 3) % 6), y, 29 + ((y * 3) % 6), y + 2, bark[0]);
        for (let i = 0; i < 4; i++) p.set(26 + i * 4, by + 8 - (i % 2) * 5, '#7a9c52');
        const eye = atk >= 0 ? '#eaff9a' : '#c8ff7a';
        p.rect(35, by - 7, 3, atk >= 0 ? 3 : 2, eye); p.rect(40, by - 7, 3, atk >= 0 ? 3 : 2, eye);
        p.set(36, by - 7, '#ffffff'); p.set(41, by - 7, '#ffffff');
        p.rect(36, by + 2, 6, atk >= 0 ? 4 : 2, '#2a160c');
        const sway = Math.round(step * 1.5);
        const cy = by - 26;
        for (const [x, y, rx, ry] of [[32, cy, 15, 11], [19, cy + 5, 9, 8], [45, cy + 5, 9, 8], [25, cy - 6, 8, 7], [39, cy - 7, 8, 7], [32, cy + 10, 10, 5]]) {
          p.ell(x + sway, y, rx, ry, (xx, yy) => shadeAt(xx, yy, (xx - 32 - sway) / 21, (yy - cy) / 16, leaf, 0.05));
        }
        for (const [x, y] of [[22, cy - 2], [42, cy - 4], [30, cy + 6], [36, cy - 10]]) p.set(x + sway, y, '#ffd6e6');
      } else if (key === 'lich') {
        p = new Pix(56, 66); ax = 28; ay = 63;
        const fy = Math.round(Math.sin((frame / (anim === 'atk' ? 3 : 6)) * Math.PI * 2) * 2);
        const robe = ['#241838', '#352654', '#4c3876', '#66509a', '#8670bc'];
        const sway = Math.round(Math.sin(cyc) * 1.5);
        const hem = 58 + fy;
        p.poly([[28, 22 + fy], [42, 32 + fy], [46 + sway, hem], [10 + sway, hem], [14, 32 + fy]], (x, y) => shadeAt(x, y, (x - 28) / 20, (y - 40 - fy) / 24, robe, 0));
        for (let x = 10 + sway; x <= 44 + sway; x += 4) p.poly([[x, hem - 1], [x + 2, hem + 2 + ((x / 4 + frame) % 3)], [x + 4, hem - 1]], robe[1]);
        p.poly([[20, 30 + fy], [28, 26 + fy], [36, 30 + fy], [28, 36 + fy]], '#d8b64a');
        // staff
        let top, bot, orbR = 4, orbC = ['#2f67aa', '#78e0ff', '#d4f6ff', '#ffffff'];
        if (atk === 0) { top = [45, 4 + fy]; bot = [43, 46 + fy]; orbR = 5; } else if (atk === 1) { top = [54, 12 + fy]; bot = [40, 42 + fy]; orbR = 5; orbC = ['#78e0ff', '#d4f6ff', '#ffffff', '#ffffff']; } else if (atk === 2) { top = [45, 6 + fy]; bot = [43, 48 + fy]; orbR = 4; orbC = ['#78e0ff', '#ffffff', '#ffffff', '#ffffff']; } else { top = [44, 16 + fy]; bot = [44, 60 + fy]; }
        p.line(bot[0], bot[1], top[0], top[1], '#7b5234', 2);
        p.ball(top[0], top[1] - orbR + 1, orbR, orbR, orbC);
        if (atk >= 0) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + frame; p.set(top[0] + Math.cos(a) * (orbR + 3), top[1] - orbR + 1 + Math.sin(a) * (orbR + 3), '#d4f6ff'); }
        p.line(38, 34 + fy, (top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2 + 4, robe[3], 3);
        // bony hand
        const lh = atk >= 0 ? [10, 26 + fy] : [12, 38 + fy];
        p.line(18, 34 + fy, lh[0], lh[1], robe[3], 3);
        p.rect(lh[0] - 1, lh[1] - 2, 3, 3, '#efeadc');
        p.ball(28, 20 + fy, 8, 8, ['#a09884', '#c2b9a2', '#efeadc', '#ffffff']);
        const eye = atk >= 0 ? '#c8f8ff' : '#78e0ff';
        p.rect(25, 18 + fy, 3, 3, '#16121c'); p.rect(30, 18 + fy, 3, 3, '#16121c');
        p.set(26, 19 + fy, eye); p.set(31, 19 + fy, eye);
        if (atk >= 0) { p.rect(26, 19 + fy, 2, 2, eye); p.rect(31, 19 + fy, 2, 2, eye); }
        p.rect(26, 24 + fy, 6, atk >= 0 ? 2 : 1, '#4a4438');
        for (let i = 0; i < 5; i++) p.poly([[20 + i * 4, 13 + fy], [22 + i * 4, 5 + fy + (i % 2) * 2], [24 + i * 4, 13 + fy]], i % 2 ? '#c9922a' : '#ffd84f');
        p.rect(20, 12 + fy, 17, 2, '#ffd84f');
        p.set(28, 12 + fy, '#e0544a');
      } else if (key === 'hydra') {
        p = new Pix(76, 64); ax = 32; ay = 61;
        const sk = ['#2c4e28', '#3c6e36', '#4e8e46', '#66aa58', '#8cc876'];
        const breath = Math.round(Math.sin(cyc));
        p.line(12, 50, 5, 55 + Math.round(Math.sin(cyc + 1) * 3), sk[1], 4);
        p.line(5, 55 + Math.round(Math.sin(cyc + 1) * 3), 1, 50 + Math.round(Math.sin(cyc + 2) * 3), sk[1], 3);
        for (const [x, s] of [[20, 1], [36, -1]]) p.rect(x, 55 - Math.max(0, Math.round(step * s * 2)), 4, 5, sk[1]);
        p.ball(30, 47, 20, 12 + breath, sk);
        for (let i = 0; i < 6; i++) p.ell(20 + i * 4, 50 + (i % 2), 1.5, 1.5, '#b4d890');
        const heads = [[44, 8], [60, 20], [50, 34]];
        heads.forEach(([hx, hy], i) => {
          const ph = i * 2.1;
          let x = hx + (anim === 'atk' ? 0 : Math.round(Math.sin(cyc + ph) * 2)), y = hy + (anim === 'atk' ? 0 : Math.round(Math.cos(cyc + ph) * 2));
          if (atk === 0) x -= 3; else if (atk === 1) x += 7; else if (atk === 2) x += 4;
          p.line(28 + (i - 1) * 6, 42, x - 4, y + 4, sk[1], 7);
          p.line(28 + (i - 1) * 6, 42, x - 4, y + 4, sk[3], 4);
          p.ball(x, y, 7, 5, sk);
          const open = atk >= 1;
          if (open) {
            p.poly([[x + 3, y - 1], [x + 11, y - 3], [x + 4, y + 1]], sk[2]);
            p.poly([[x + 3, y + 2], [x + 10, y + 6], [x + 3, y + 4]], sk[1]);
            p.poly([[x + 4, y + 1], [x + 9, y], [x + 9, y + 4], [x + 4, y + 3]], '#c83a3a');
            p.set(x + 6, y, '#f6f3ea'); p.set(x + 8, y + 4, '#f6f3ea');
          } else {
            p.poly([[x + 3, y + 1], [x + 10, y + 2], [x + 3, y + 4]], sk[2]);
            p.set(x + 8, y + 3, '#f6f3ea');
          }
          p.set(x + 2, y - 2, '#ffe14a'); p.set(x + 3, y - 2, '#ffe14a');
          p.poly([[x - 3, y - 4], [x - 6, y - 8], [x - 1, y - 5]], sk[0]);
        });
      } else if (key === 'colossus') {
        p = new Pix(80, 72); ax = 40; ay = 69;
        const st = ['#58534a', '#78726a', '#96907f', '#b3ad9c', '#d0cab9'];
        const low = atk === 2 ? 2 : 0;
        const by = 38 - bob + low;
        p.rect(29, 52 - bob, 8, 17 - Math.round(2 * Math.max(0, step)), (x) => (x > 34 ? st[1] : st[2]));
        p.rect(43, 52 - bob, 8, 17 - Math.round(2 * Math.max(0, -step)), (x) => (x > 48 ? st[1] : st[2]));
        let fl, fr;
        if (atk === 0) { fl = [24, 6]; fr = [56, 6]; } else if (atk === 1) { fl = [14, 20]; fr = [66, 20]; } else if (atk === 2) { fl = [10, 62]; fr = [70, 62]; } else { fl = [10, by + step * 3]; fr = [70, by - step * 3]; }
        p.line(22, by - 8, fl[0], fl[1], st[2], 6); p.line(58, by - 8, fr[0], fr[1], st[2], 6);
        rockShape(p, 40, by, 20, 18, rnd(5), st);
        rockShape(p, 40, by - 22, 9, 8, rnd(9), st);
        p.ball(fl[0], fl[1], 7, 8, st); p.ball(fr[0], fr[1], 7, 8, st);
        const rune = atk >= 0 ? '#e6faff' : ['#5ac8ff', '#8adcff', '#bff0ff', '#8adcff', '#5ac8ff', '#3aa8e8'][frame % 6];
        p.rect(38, by - 23, 2, 2, rune); p.rect(43, by - 23, 2, 2, rune);
        p.ell(32, by - 10, 5, 3, '#7a9c52'); p.ell(47, by + 6, 4, 2, '#7a9c52'); p.ell(37, by - 29, 3, 1.5, '#7a9c52');
        p.line(35, by - 4, 41, by + 2, rune); p.line(41, by + 2, 37, by + 8, rune); p.line(45, by - 8, 49, by - 2, rune);
      } else if (key === 'dragon') {
        p = new Pix(90, 70); ax = 40; ay = 66;
        const sc = ['#781c12', '#a42c1e', '#c8422c', '#e26444', '#f4946a'];
        const wf = anim === 'atk' ? [-0.8, -1, -0.8][frame] : [-1, -0.4, 0.5, 1, 0.5, -0.4][frame];
        const by = 46 - bob;
        const wing = (wx, dir, shade) => {
          const tipY = 14 + wf * 12, midY = 20 + wf * 7;
          const pts = [[wx, by - 12], [wx + dir * 6, midY], [wx + dir * 16, tipY], [wx + dir * 27, 16 + wf * 5], [wx + dir * 23, by - 18 + wf * 2], [wx + dir * 15, by - 14], [wx + dir * 5, by - 6]];
          p.poly(pts, (x, y) => ((x * 2 + y) % 7 === 0 ? sc[0] : shade));
          p.line(wx, by - 12, wx + dir * 16, tipY, sc[0]); p.line(wx, by - 12, wx + dir * 27, 16 + wf * 5, sc[0]);
          p.line(wx + dir * 16, tipY, wx + dir * 16, tipY - 2, '#efe0c0');
        };
        wing(32, -1, sc[1]);
        const tw = Math.round(Math.sin(cyc + 1) * 3);
        p.line(20, by, 10, by + 6 + tw, sc[2], 5); p.line(10, by + 6 + tw, 3, by + tw, sc[2], 3);
        p.poly([[0, by - 2 + tw], [5, by - 4 + tw], [4, by + 3 + tw]], '#efe0c0');
        p.rect(26, by + 6, 5, 9 - Math.round(2 * Math.max(0, step)), sc[1]); p.rect(42, by + 6, 5, 9 - Math.round(2 * Math.max(0, -step)), sc[1]);
        p.ball(36, by, 16, 11, sc);
        for (let x = 26; x < 46; x += 3) p.rect(x, by + 4, 2, 3, '#ecae4a');
        for (let x = 24; x < 46; x += 4) p.poly([[x, by - 10], [x + 2, by - 14], [x + 4, by - 10]], sc[0]);
        const hx = atk >= 0 ? 66 : 62, hy = (atk >= 0 ? by - 10 : by - 22) + (anim === 'atk' ? 0 : Math.round(Math.sin(cyc) * 1));
        p.line(46, by - 6, hx - 4, hy + 2, sc[2], 6);
        p.ball(hx, hy, 8, 6, sc);
        if (atk >= 0) {
          p.poly([[hx + 4, hy - 2], [hx + 13, hy - 2], [hx + 4, hy + 1]], sc[2]);
          p.poly([[hx + 4, hy + 3], [hx + 12, hy + 7], [hx + 4, hy + 5]], sc[1]);
          p.poly([[hx + 5, hy + 1], [hx + 12, hy], [hx + 12, hy + 5], [hx + 5, hy + 4]], '#ffb84a');
          p.set(hx + 8, hy + 2, '#fff4b0'); p.set(hx + 9, hy + 2, '#fff4b0');
          if (atk >= 1) p.ball(hx + 16, hy + 2, 3 + atk, 3 + atk, ['#e0543a', '#ffa24a', '#ffd84f', '#fff4b0']);
        } else {
          p.poly([[hx + 4, hy + 1], [hx + 13, hy + 2], [hx + 4, hy + 4]], sc[1]);
          p.set(hx + 12, hy + 2, '#ffa24a');
        }
        p.poly([[hx - 4, hy - 5], [hx - 8, hy - 12], [hx - 1, hy - 6]], '#efe0c0'); p.poly([[hx, hy - 6], [hx - 2, hy - 13], [hx + 3, hy - 6]], '#efe0c0');
        p.rect(hx + 2, hy - 3, 2, 2, '#ffe14a');
        wing(40, 1, sc[2]);
      }
      return { pix: p, ax, ay };
    });
  }

  // ------------------------------------------------------------------ projectiles
  function arrow(mine) {
    return keyed('a:' + mine, () => ({ pix: fromRows([mine ? 'c.....G.' : 'r.....G.', mine ? '.cbbbbGG' : '.rbbbbGG', mine ? 'c.....G.' : 'r.....G.'], PAL), ax: 5, ay: 2 }));
  }
  function boltProj(big) {
    return keyed('bx:' + big, () => ({ pix: fromRows(big ? ['yy.........GG..', 'yybbbbbbbbbGGGw', 'yy.........GG..'] : ['y.....G.', 'ybbbbbGG', 'y.....G.'], PAL), ax: big ? 8 : 4, ay: 2 }));
  }
  function daggerProj() { return keyed('dg', () => ({ pix: fromRows(['.Y...', 'BYggw', '.Y...'], PAL), ax: 3, ay: 2 })); }
  function thornProj() { return keyed('th', () => ({ pix: fromRows(['..l...', 'LLllmG', '..l...'], PAL), ax: 3, ay: 2 })); }
  function rockProj(big) {
    return keyed('rp:' + big, () => {
      const r = big ? 8 : 4;
      const p = new Pix(r * 2 + 4, r * 2 + 4);
      rockShape(p, r + 1.5, r + 1.5, r, r, rnd(big ? 3 : 4), ROCK.default);
      return { pix: p, ax: r + 2, ay: r + 2 };
    });
  }
  function seed() { return keyed('seed', () => ({ pix: fromRows(['.mm.', 'mbbL', 'bbBL', '.BB.'], PAL), ax: 2, ay: 2 })); }

  // ------------------------------------------------------------------ UI icons
  const ICONS = {
    wood: ['.bbbbbnn.', 'bBbbBbnbn', 'bbbBbbnbn', '.bbbbbnn.'],
    stone: ['..vvvx...', '.vvvxxxx.', 'vvxxxxxxX', 'xxxxxxxXX', '.XxxxxXX.'],
    gold: ['..yyy..', '.yaayY.', 'yayyyYY', 'yayYyYY', 'yyyyYYY', '.yYYYY.', '..YYY..'],
    glory: ['...y...', '..yay..', 'yyyayyy', '.yyyyy.', '..yyy..', '.yy.yy.', 'y.....y'],
    skull: ['.zzzzz.', 'zzzzzzz', 'zeezeez', 'zeezeez', 'zzzZzzz', '.zZzZz.', '.z.z.z.'],
    dragon: ['r....r..', 'rr..rr..', 'rrrrrrr.', 'rryrrrrr', 'rrrrrrrR', '.rrrRRR.', '..R.R...'],
    eye: ['..ccc..', '.cwwwc.', 'cwwewwc', '.cwwwc.', '..ccc..'],
    fire: ['...o...', '..oo...', '..ooo.o', '.oyooo.', 'oyyaoo.', 'oyaayo.', '.oyyo..'],
    swords: ['g.....g', '.g...g.', '..g.g..', '...g...', '..g.g..', 'YY...YY', 'Y.....Y'],
    home: ['...r...', '..rrr..', '.rrrrr.', 'rrrrrrr', '.nnnnn.', '.nBnwn.', '.nBnnn.'],
    heart: ['.rr.rr.', 'rwrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'],
    dash: ['....gggw.', '......gw.', 'ggggggggw', '......gw.', '....gggw.'],
    volley: ['.......G.', '.bbbbbbGG', '.......G.', '.........', 'Gbbbbbb..', '.........', '.......G.', '.bbbbbbGG', '.......G.'],
    nova: ['....c....', '.c..c..c.', '..c.c.c..', '...ccc...', 'cccciccc.', '...ccc...', '..c.c.c..', '.c..c..c.', '....c....'],
    charge: ['.......gw', '......gg.', '.....nn..', '....nn...', '...nn....', '..nn.....', 'TTn......', 'TT.......'],
    bastion: ['yyyyyyy', 'yTTTTTy', 'yTUyUTy', 'yTyyyTy', 'yTTyTTy', '.yTTTy.', '..yTy..', '...y...'],
    rage: ['r.r.r.r', 'rrrrrrr', '.rfffr.', '.rfaff.', 'rrfffrr', '.rrrrr.', '..r.r..'],
    deadshot: ['...r...', '..rrr..', '.r.r.r.', 'rrrrrrr', '.r.r.r.', '..rrr..', '...r...'],
    pack: ['G...G..', 'GG.GG..', 'GGGGGG.', 'GgyGgy.', 'GGGGGGe', '.GGGGG.', '..GGG..'],
    shadow: ['..ddd..', '.dPPPd.', 'dPPrPrd', 'dPPPPPd', '.dPPPd.', '..ddd..'],
    storm: ['....yy.', '...yy..', '..yy...', '.yyyyy.', '...yy..', '..yy...', '.yy....'],
    roots: ['..l.l..', '.lml.l.', '..lLl..', 'l..b..l', '.bbbbb.', 'b..b..b', '..b.b..'],
    bless: ['y..y..y', '.y.y.y.', '..aaa..', 'yyaiayy', '..aaa..', '.y.y.y.', 'y..y..y'],
  };
  function icon(name, rel) {
    return keyed(`i:${name}:${rel || 0}`, () => ({ pix: fromRows(ICONS[name], Object.assign({}, PAL, TEAM[rel || 0])), ax: 0, ay: 0 }));
  }
  const urlCache = new Map();
  function iconURL(name, scale) {
    const k = name + ':' + (scale || 2);
    let u = urlCache.get(k);
    if (!u) { u = icon(name).pix.canvas(null, scale || 2).toDataURL(); urlCache.set(k, u); }
    return u;
  }
  function buildingURL(type) {
    const k = 'b:' + type;
    let u = urlCache.get(k);
    if (!u) { u = building(type, 0).pix.canvas(null, 1).toDataURL(); urlCache.set(k, u); }
    return u;
  }
  function heroURL(type, scale) {
    const k = 'h:' + type + scale;
    let u = urlCache.get(k);
    if (!u) { u = hero(type, 0, 0).pix.canvas(null, scale).toDataURL(); urlCache.set(k, u); }
    return u;
  }

  // ------------------------------------------------------------------ ground
  const GROUND = [
    ['#7cbc5c', '#88c664', '#94d06c', '#a2da78'],
    ['#559648', '#60a251', '#6aac59', '#76b663'],
    ['#a39d8f', '#afa99b', '#bbb5a7', '#c7c1b3'],
    ['#d8e5ee', '#e5eff5', '#eff6fa', '#f9fcfd'],
    ['#687f5c', '#728a64', '#7c946d', '#879f76'],
    ['#6a4b42', '#77554b', '#846054', '#916b5e'],
  ];
  const CH = 256;
  function decor(g, b, h, x, y, h2) {
    const put = (dx, dy, c) => { g.fillStyle = c; g.fillRect(x + dx, y + dy, 1, 1); };
    if (b === S.B.MEADOW || b === S.B.FOREST) {
      if (h < 0.35) { const c = b === S.B.FOREST ? '#44843c' : '#62a64a'; put(0, 0, c); put(2, -1, c); put(1, -2, c); put(4, 0, c); put(3, -1, c); }
      else if (h < 0.46 && b === S.B.MEADOW) { const c = ['#fff3a8', '#ffa8c8', '#ffffff', '#b0dcff'][(h2 * 4) | 0]; put(0, -1, c); put(-1, 0, c); put(1, 0, c); put(0, 1, c); put(0, 0, '#f0b040'); }
      else if (h < 0.5 && b === S.B.FOREST) { put(0, 0, '#efe2c4'); put(0, -1, '#e0544a'); put(-1, -1, '#e0544a'); put(1, -1, '#e0544a'); put(0, -2, '#f07a6a'); }
    } else if (b === S.B.MOUNTAIN) {
      if (h < 0.35) { put(0, 0, '#857e72'); put(1, 0, '#857e72'); put(0, -1, '#cfc8ba'); }
      else if (h < 0.45) { for (let i = 0; i < 5; i++) put(i, (i * 7 + ((h2 * 10) | 0)) % 2, '#8f887b'); }
      else if (h < 0.5) { put(0, 0, '#7cb05a'); put(1, -1, '#7cb05a'); }
    } else if (b === S.B.SNOW) {
      if (h < 0.3) { for (let i = -3; i <= 3; i++) put(i, 0, '#ffffff'); for (let i = -2; i <= 2; i++) put(i, 1, '#c9d7e2'); }
      else if (h < 0.38) { put(0, 0, '#ffffff'); put(-1, 0, '#bfe6ff'); put(1, 0, '#bfe6ff'); put(0, -1, '#bfe6ff'); put(0, 1, '#bfe6ff'); }
    } else if (b === S.B.SWAMP) {
      if (h < 0.2) { g.fillStyle = '#4c7470'; g.fillRect(x - 4, y - 1, 9, 3); g.fillRect(x - 2, y - 2, 5, 5); put(-2, -1, '#86b0a8'); }
      else if (h < 0.32) { put(0, 0, '#40582e'); put(0, -1, '#40582e'); put(0, -2, '#587a3e'); put(2, 0, '#40582e'); put(2, -1, '#587a3e'); put(2, -3, '#8a6a3a'); }
      else if (h < 0.4) { put(0, 0, '#86b25a'); put(1, 0, '#86b25a'); put(0, 1, '#86b25a'); put(1, 1, '#669248'); }
    } else if (b === S.B.VOLCANO) {
      if (h < 0.16) { let cx = x, cy = y; for (let i = 0; i < 7; i++) { g.fillStyle = i % 3 === 0 ? '#ffc44a' : '#ff6a2a'; g.fillRect(cx, cy, 1, 1); cx += 1; cy += ((h2 * 97 + i * 13) | 0) % 3 - 1; } }
      else if (h < 0.3) { put(0, 0, '#4a3430'); put(1, 0, '#4a3430'); put(0, -1, '#9a7a6e'); }
      else if (h < 0.34) { put(0, 0, '#efeadc'); put(1, 0, '#efeadc'); put(2, 0, '#efeadc'); put(0, -1, '#efeadc'); put(2, -1, '#efeadc'); }
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
        const i = clamp(Math.floor(n * 4.4 - 0.7 + bayer(ax, ay) * 0.9 - 0.45), 0, 3);
        const [r, gg, bb] = rgb(GROUND[b][i]);
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

  return {
    ART, TEAM, RAMP, PAL, GROUND, CH, Pix, hero, weapon, shieldSprite, mob, ally, node, building, boss, arrow, boltProj,
    daggerProj, thornProj, rockProj, seed, star, icon, iconURL, buildingURL, heroURL, flip, tint, groundChunk,
  };
})();
