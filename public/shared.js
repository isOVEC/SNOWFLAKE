// Shared game constants & logic (used by both server and browser).
(function (root) {
  const S = {};

  S.W = 8000;
  S.H = 8000;
  S.TICK = 30;
  S.DT = 1 / S.TICK;
  S.TILE = 80;

  // ---------------------------------------------------------------- noise
  function hash2(x, y, seed) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 982451653)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function noise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    const u = smooth(xf), v = smooth(yf);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, seed) {
    return noise(x, y, seed) * 0.6 + noise(x * 2, y * 2, seed + 1) * 0.28 + noise(x * 4, y * 4, seed + 2) * 0.12;
  }
  S.hash2 = hash2;
  S.noise = noise;
  S.fbm = fbm;

  // --------------------------------------------------------------- biomes
  const B = { MEADOW: 0, FOREST: 1, MOUNTAIN: 2, SNOW: 3, SWAMP: 4, VOLCANO: 5 };
  S.B = B;
  S.BIOME_NAMES = ['Луга', 'Лес', 'Горы', 'Снега', 'Болота', 'Вулкан'];
  S.BIOME_COLORS = [
    ['#83b95d', '#7db357', '#88be62'],
    ['#4f8743', '#4a8140', '#548c48'],
    ['#9b958a', '#958f84', '#a29c91'],
    ['#e3ecf1', '#dbe6ec', '#eaf1f5'],
    ['#5d7550', '#58704b', '#627a55'],
    ['#4b3532', '#44302d', '#533b37'],
  ];
  // Difficulty multiplier of neutral monsters per biome
  S.BIOME_TIER = [1, 1.3, 1.6, 1.8, 1.5, 2.2];

  S.BOSSES = [
    { key: 'treant', name: 'Древний Энт', x: 2700, y: 2900, r: 70, hp: 6000, biome: B.FOREST, xp: 1600, loot: { wood: 600, stone: 150, gold: 250 } },
    { key: 'lich', name: 'Король-Лич', x: 4000, y: 700, r: 55, hp: 7000, biome: B.SNOW, xp: 2200, loot: { wood: 150, stone: 250, gold: 500 } },
    { key: 'hydra', name: 'Болотная Гидра', x: 1000, y: 5000, r: 75, hp: 7500, biome: B.SWAMP, xp: 2200, loot: { wood: 400, stone: 200, gold: 450 } },
    { key: 'colossus', name: 'Каменный Колосс', x: 6300, y: 2700, r: 85, hp: 9000, biome: B.MOUNTAIN, xp: 2600, loot: { wood: 100, stone: 700, gold: 400 } },
    { key: 'dragon', name: 'Огненный Дракон', x: 6600, y: 6600, r: 90, hp: 12000, biome: B.VOLCANO, xp: 3500, loot: { wood: 300, stone: 300, gold: 1000 } },
  ];
  S.SPAWN = { x: 4000, y: 4200 };

  S.biomeAt = function (x, y) {
    for (const b of S.BOSSES) {
      const dx = x - b.x, dy = y - b.y;
      if (dx * dx + dy * dy < 650 * 650) return b.biome;
    }
    const nx = x / S.W, ny = y / S.H;
    const warp = (fbm(x / 900, y / 900, 7) - 0.5) * 0.14;
    if (ny + warp < 0.19) return B.SNOW;
    if (Math.hypot(nx - 0.83, ny - 0.83) + warp < 0.23) return B.VOLCANO;
    if (Math.hypot(nx - 0.12, ny - 0.63) + warp * 1.2 < 0.2) return B.SWAMP;
    const dc = Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y);
    if (dc < 700) return B.MEADOW;
    if (fbm(x / 1300, y / 1300, 3) > 0.64) return B.MOUNTAIN;
    if (fbm(x / 1000, y / 1000, 11) > 0.56) return B.FOREST;
    return B.MEADOW;
  };

  // -------------------------------------------------------------- classes
  S.CLASSES = {
    warrior: {
      name: 'Воин', desc: 'Меч бьёт дугой по всем вокруг. Много здоровья. Умение — рывок.',
      hp: 230, speed: 235, r: 24, dmg: 26, cd: 0.45, range: 82, arc: 1.15,
      ability: { name: 'Рывок', cd: 7, dmg: 45 }, gather: 1.3, color: '#c9ced6',
    },
    ranger: {
      name: 'Следопыт', desc: 'Быстрые стрелы издалека. Умение — залп из 9 стрел.',
      hp: 155, speed: 255, r: 22, dmg: 15, cd: 0.3, projSpeed: 980, life: 0.75,
      ability: { name: 'Залп', cd: 6, dmg: 15 }, gather: 1.0, color: '#8fd16a',
    },
    mage: {
      name: 'Маг', desc: 'Огненные шары с уроном по области. Умение — ледяная нова.',
      hp: 135, speed: 240, r: 22, dmg: 28, cd: 0.72, projSpeed: 620, life: 1.05, splash: 75,
      ability: { name: 'Ледяная нова', cd: 7, dmg: 55, radius: 270 }, gather: 1.0, color: '#b48cff',
    },
  };

  S.STATS = [
    { key: 'dmg', name: 'Урон', color: '#ff6b5b' },
    { key: 'aspd', name: 'Скорость атаки', color: '#ffb347' },
    { key: 'hp', name: 'Здоровье', color: '#6bdc6b' },
    { key: 'regen', name: 'Регенерация', color: '#4fd6c5' },
    { key: 'speed', name: 'Скорость бега', color: '#5ab0ff' },
    { key: 'gather', name: 'Добыча', color: '#e8c95a' },
  ];
  S.STAT_MAX = 8;
  S.MAX_LVL = 40;
  S.xpFor = function (lvl) { return Math.floor(35 * Math.pow(lvl, 1.65)); };

  S.heroStats = function (cls, st, lvl) {
    const c = S.CLASSES[cls];
    const lv = 1 + (lvl - 1) * 0.02;
    return {
      maxHp: Math.round(c.hp * (1 + 0.13 * st[2]) * lv),
      dmg: c.dmg * (1 + 0.11 * st[0]) * lv,
      cd: c.cd / (1 + 0.09 * st[1]),
      regen: c.hp * (0.008 + 0.006 * st[3]),
      speed: c.speed * (1 + 0.045 * st[4]),
      gather: c.gather * (1 + 0.22 * st[5]),
    };
  };

  // ------------------------------------------------------------ buildings
  S.RES = ['wood', 'stone', 'gold'];
  S.RES_ICON = { wood: '🪵', stone: '🪨', gold: '🪙' };
  S.BUILDINGS = {
    townhall: { name: 'Ратуша', icon: '🏰', size: 130, hp: 3200, cost: {}, desc: 'Сердце базы: точка возрождения, радиус стройки и лимиты зданий.' },
    wall: { name: 'Стена', icon: '🧱', size: 44, hp: 550, cost: { stone: 12 }, desc: 'Блокирует врагов. Вы и клан проходите насквозь.' },
    tower: { name: 'Башня лучников', icon: '🏹', size: 64, hp: 950, cost: { wood: 80, stone: 50 }, range: 540, dmg: 17, rate: 0.85, desc: 'Стреляет по врагам и монстрам.' },
    magetower: { name: 'Башня магов', icon: '🔮', size: 64, hp: 750, cost: { wood: 60, stone: 90, gold: 70 }, range: 470, dmg: 34, rate: 1.8, splash: 85, desc: 'Бьёт по области и замедляет.' },
    sawmill: { name: 'Лесопилка', icon: '🪚', size: 76, hp: 650, cost: { wood: 40, stone: 30 }, income: { wood: 2 }, desc: 'Даёт дерево.' },
    quarry: { name: 'Каменоломня', icon: '⛏️', size: 76, hp: 650, cost: { wood: 70 }, income: { stone: 1.6 }, desc: 'Даёт камень.' },
    mine: { name: 'Золотой рудник', icon: '💰', size: 76, hp: 750, cost: { wood: 90, stone: 90 }, income: { gold: 1 }, desc: 'Даёт золото.' },
    barracks: { name: 'Казарма', icon: '⚔️', size: 84, hp: 1150, cost: { wood: 150, stone: 100, gold: 80 }, desc: 'Нанимает рыцарей. Они ходят за вами в набеги.' },
    shrine: { name: 'Святилище', icon: '✨', size: 60, hp: 650, cost: { stone: 120, gold: 120 }, heal: 12, range: 280, desc: 'Лечит вас, союзников и здания рядом.' },
  };
  S.BUILD_ORDER = ['townhall', 'wall', 'tower', 'magetower', 'sawmill', 'quarry', 'mine', 'barracks', 'shrine'];
  S.TH_MAX = 5;
  S.BLD_MAX = 3;
  // caps per townhall level 1..5
  S.CAPS = {
    townhall: [1, 1, 1, 1, 1],
    wall: [24, 40, 60, 80, 110],
    tower: [1, 2, 3, 4, 6],
    magetower: [0, 1, 1, 2, 3],
    sawmill: [1, 1, 2, 2, 3],
    quarry: [1, 1, 2, 2, 3],
    mine: [0, 1, 1, 2, 3],
    barracks: [0, 1, 1, 2, 2],
    shrine: [0, 0, 1, 1, 2],
  };
  S.thRadius = function (lvl) { return 380 + lvl * 110; };
  S.thUpgradeCost = function (toLvl) { return { wood: 220 * (toLvl - 1), stone: 220 * (toLvl - 1), gold: 140 * (toLvl - 1) }; };
  S.thRebuildCost = function (lvl) { return { wood: 120 * lvl, stone: 120 * lvl }; };
  S.bldUpgradeCost = function (type, toLvl) {
    const c = S.BUILDINGS[type].cost, out = {};
    for (const k in c) out[k] = Math.round(c[k] * toLvl * 1.2);
    return out;
  };
  S.lvlMul = function (lvl) { return 1 + 0.6 * (lvl - 1); };
  S.resCap = function (thLvl) { return 1000 + thLvl * 1500; };
  S.snap = function (type, v) {
    const g = type === 'wall' ? 44 : 22;
    return Math.round(v / g) * g;
  };

  S.canAfford = function (res, cost) {
    for (const k in cost) if ((res[k] || 0) < cost[k]) return false;
    return true;
  };

  // ------------------------------------------------------------- monsters
  S.MOBS = {
    wolf: { name: 'Волк', hp: 70, r: 18, speed: 195, dmg: 9, cd: 0.8, xp: 14, gold: 3, aggro: 380 },
    goblin: { name: 'Гоблин', hp: 55, r: 17, speed: 150, dmg: 10, cd: 1.3, xp: 16, gold: 5, aggro: 440, ranged: { speed: 520, life: 1.0, type: 'gob' }, keep: 290 },
    slime: { name: 'Слизень', hp: 115, r: 23, speed: 95, dmg: 12, cd: 1.0, xp: 18, gold: 4, aggro: 320 },
    skeleton: { name: 'Скелет', hp: 95, r: 19, speed: 150, dmg: 14, cd: 0.9, xp: 24, gold: 6, aggro: 400 },
    imp: { name: 'Бес', hp: 80, r: 17, speed: 175, dmg: 15, cd: 1.4, xp: 30, gold: 8, aggro: 460, ranged: { speed: 480, life: 1.1, type: 'imp' }, keep: 300 },
    golem: { name: 'Голем', hp: 330, r: 30, speed: 85, dmg: 26, cd: 1.4, xp: 45, gold: 12, aggro: 330 },
  };
  S.BIOME_MOBS = [
    ['wolf', 'goblin', 'wolf'],
    ['wolf', 'wolf', 'goblin'],
    ['golem', 'goblin'],
    ['skeleton', 'skeleton', 'wolf'],
    ['slime', 'slime', 'goblin'],
    ['imp', 'golem', 'imp'],
  ];
  S.KNIGHT = { name: 'Рыцарь', hp: 110, r: 17, speed: 215, dmg: 11, cd: 0.8 };

  // ------------------------------------------------------------ collision
  // list items: {k:'n', x, y, r} nodes or {k:'b', x, y, hs, ...} buildings.
  S.resolve = function (p, r, list, canPass) {
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.k === 'n') {
          const dx = p.x - s.x, dy = p.y - s.y;
          const min = r + s.r;
          const d2 = dx * dx + dy * dy;
          if (d2 < min * min) {
            const d = Math.sqrt(d2) || 0.001;
            p.x = s.x + (dx / d) * min;
            p.y = s.y + (dy / d) * min;
          }
        } else {
          if (canPass && canPass(s)) continue;
          const hs = s.hs;
          const cx = Math.max(s.x - hs, Math.min(p.x, s.x + hs));
          const cy = Math.max(s.y - hs, Math.min(p.y, s.y + hs));
          const dx = p.x - cx, dy = p.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r) {
            if (d2 > 0.0001) {
              const d = Math.sqrt(d2);
              p.x = cx + (dx / d) * r;
              p.y = cy + (dy / d) * r;
            } else {
              // centre inside the box: push out on the shortest axis
              const ox = p.x - s.x, oy = p.y - s.y;
              if (Math.abs(ox) > Math.abs(oy)) p.x = s.x + Math.sign(ox || 1) * (hs + r);
              else p.y = s.y + Math.sign(oy || 1) * (hs + r);
            }
          }
        }
      }
    }
    p.x = Math.max(r, Math.min(S.W - r, p.x));
    p.y = Math.max(r, Math.min(S.H - r, p.y));
  };

  S.moveHero = function (p, inp, speed, r, list, canPass) {
    let mx = inp.mx, my = inp.my;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    p.x += mx * speed * S.DT;
    p.y += my * speed * S.DT;
    S.resolve(p, r, list, canPass);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  else root.S = S;
})(typeof self !== 'undefined' ? self : this);
