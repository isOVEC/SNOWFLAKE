// Shared game constants & logic (used by both server and browser).
(function (root) {
  const S = {};

  // ~10x the area of the original 8000x8000 map
  S.W = 25000;
  S.H = 25000;
  S.MOB_CAP = 1000;
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

  // two lairs of every boss; positions are fractions of the map size
  const BOSS_TYPES = {
    treant: { name: 'Древний Энт', r: 70, hp: 6000, biome: B.FOREST, xp: 1600, loot: { wood: 600, stone: 150, gold: 250 } },
    lich: { name: 'Король-Лич', r: 55, hp: 7000, biome: B.SNOW, xp: 2200, loot: { wood: 150, stone: 250, gold: 500 } },
    hydra: { name: 'Болотная Гидра', r: 75, hp: 7500, biome: B.SWAMP, xp: 2200, loot: { wood: 400, stone: 200, gold: 450 } },
    colossus: { name: 'Каменный Колосс', r: 85, hp: 9000, biome: B.MOUNTAIN, xp: 2600, loot: { wood: 100, stone: 700, gold: 400 } },
    dragon: { name: 'Огненный Дракон', r: 90, hp: 12000, biome: B.VOLCANO, xp: 3500, loot: { wood: 300, stone: 300, gold: 1000 } },
  };
  const LAIRS = [
    ['treant', 0.34, 0.36], ['lich', 0.5, 0.07], ['hydra', 0.1, 0.6], ['colossus', 0.79, 0.33], ['dragon', 0.84, 0.84],
    ['treant', 0.66, 0.56], ['lich', 0.18, 0.1], ['hydra', 0.2, 0.74], ['colossus', 0.38, 0.86], ['dragon', 0.93, 0.7],
  ];
  S.BOSSES = LAIRS.map(([key, fx, fy]) => Object.assign({ key, x: Math.round(fx * S.W), y: Math.round(fy * S.H) }, BOSS_TYPES[key]));
  S.SPAWN = { x: Math.round(S.W * 0.5), y: Math.round(S.H * 0.52) };

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
  S.START_PTS = 5;
  S.MAX_LVL = 40;
  S.xpFor = function (lvl) { return Math.floor(35 * Math.pow(lvl, 1.65)); };

  // Advanced classes: unlocked at level 10, empowered at level 20 (tier 2)
  S.EVOLVE_LVL = 10;
  S.EMPOWER_LVL = 20;
  S.SUBCLASSES = {
    cavalier: {
      base: 'warrior', name: 'Кавалерист', icon: 'charge', r: 26,
      desc: 'Верхом на коне: самый быстрый, бьёт копьём издалека. Умение — таран сквозь врагов.',
      desc20: 'Таран перезаряжается быстрее, бьёт в 1.5 раза сильнее и в конце даёт ударную волну.',
      hp: 1.15, speed: 1.35, dmg: 1.15, cd: 1.1, range: 125, arc: 0.5, ability: { name: 'Таран', cd: 6, dmg: 70 },
    },
    guardian: {
      base: 'warrior', name: 'Щитоносец', icon: 'bastion', r: 25,
      desc: 'Огромный щит срезает 40% урона спереди. Умение — бастион: 3 с почти неуязвим и отбрасывает врагов.',
      desc20: 'Бастион отражает вражеские снаряды обратно.',
      hp: 1.6, speed: 0.92, dmg: 0.95, cd: 1, range: 78, arc: 1.2, ability: { name: 'Бастион', cd: 10, dmg: 25 },
    },
    berserker: {
      base: 'warrior', name: 'Берсерк', icon: 'rage', r: 24,
      desc: 'Топор и вампиризм 12%. Умение — ярость: атаки на 80% чаще, бег на 30% быстрее.',
      desc20: 'В ярости сам крутит смертельный вихрь вокруг себя.',
      hp: 1.1, speed: 1.05, dmg: 1.1, cd: 0.8, range: 86, arc: 1.3, ability: { name: 'Ярость', cd: 12 },
    },
    sniper: {
      base: 'ranger', name: 'Снайпер', icon: 'deadshot', r: 22,
      desc: 'Арбалет: тяжёлые болты летят далеко и пробивают двоих. Умение — смертельный выстрел.',
      desc20: 'Болты пробивают четверых, смертельный выстрел — три болта веером.',
      hp: 1.0, speed: 1.0, dmg: 2.5, cd: 2.3, projSpeed: 1500, life: 0.85, ability: { name: 'Смертельный выстрел', cd: 7, dmg: 5 },
    },
    beastmaster: {
      base: 'ranger', name: 'Зверолов', icon: 'pack', r: 22,
      desc: 'Рядом всегда 2 ручных волка. Умение — клич стаи: ещё 3 волка на 12 с и лечение зверей.',
      desc20: 'Постоянных волков трое и они сильнее, клич зовёт пятерых.',
      hp: 1.15, speed: 1.05, dmg: 0.95, cd: 1, ability: { name: 'Клич стаи', cd: 14 },
    },
    shadow: {
      base: 'ranger', name: 'Ловчий теней', icon: 'shadow', r: 21,
      desc: 'Метает веер из трёх кинжалов. Умение — шаг в тень: рывок и невидимость, первый удар двойной.',
      desc20: 'Невидимость дольше, удар из тени тройной, перезарядка короче.',
      hp: 0.95, speed: 1.15, dmg: 1.0, cd: 0.9, ability: { name: 'Шаг в тень', cd: 6 },
    },
    storm: {
      base: 'mage', name: 'Маг молний', icon: 'storm', r: 22,
      desc: 'Цепная молния бьёт мгновенно и перескакивает на 3 цели. Умение — гроза из 10 разрядов.',
      desc20: 'Молния перескакивает на 4 цели, гроза из 16 разрядов оглушает.',
      hp: 1.0, speed: 1.0, dmg: 0.9, cd: 0.85, ability: { name: 'Гроза', cd: 10, dmg: 45 },
    },
    druid: {
      base: 'mage', name: 'Друид', icon: 'roots', r: 22,
      desc: 'Шипы пробивают и замедляют, регенерация вдвое выше. Умение — корни: сковывают врагов и лечат своих.',
      desc20: 'Корни держат дольше и призывают двух энтов-защитников.',
      hp: 1.25, speed: 1.0, dmg: 0.95, cd: 0.8, ability: { name: 'Корни природы', cd: 10, dmg: 30, radius: 280 },
    },
    holy: {
      base: 'mage', name: 'Святой маг', icon: 'bless', r: 22,
      desc: 'Сферы света лечат союзников рядом с попаданием, аура лечит отряд. Умение — благословение.',
      desc20: 'Благословение ещё и выжигает врагов вокруг.',
      hp: 1.15, speed: 1.0, dmg: 1.0, cd: 0.9, ability: { name: 'Благословение', cd: 12, dmg: 70, radius: 350 },
    },
  };
  S.subOf = function (cls, sub) {
    const d = sub && Object.prototype.hasOwnProperty.call(S.SUBCLASSES, sub) ? S.SUBCLASSES[sub] : null;
    return d && d.base === cls ? d : null;
  };
  // sprite / radius / name for a hero type key (base class or subclass)
  S.heroDef = function (key) {
    if (Object.prototype.hasOwnProperty.call(S.SUBCLASSES, key)) {
      const d = S.SUBCLASSES[key];
      return { name: d.name, r: d.r || S.CLASSES[d.base].r, base: d.base, ability: d.ability, icon: d.icon };
    }
    const c = S.CLASSES[key] || S.CLASSES.warrior;
    return { name: c.name, r: c.r, base: key, ability: c.ability, icon: { warrior: 'dash', ranger: 'volley', mage: 'nova' }[key] };
  };
  S.abilityCd = function (cls, sub, lvl) {
    const d = S.subOf(cls, sub);
    if (!d) return S.CLASSES[cls].ability.cd;
    const t2 = lvl >= S.EMPOWER_LVL;
    return d.ability.cd * (t2 && (sub === 'cavalier' || sub === 'shadow' || sub === 'sniper') ? 0.65 : 1);
  };

  S.heroStats = function (cls, st, lvl, sub) {
    const c = S.CLASSES[cls];
    const d = S.subOf(cls, sub);
    const t2 = d && lvl >= S.EMPOWER_LVL;
    const lv = 1 + (lvl - 1) * 0.02;
    return {
      maxHp: Math.round(c.hp * (1 + 0.13 * st[2]) * lv * (d ? d.hp : 1) * (t2 ? 1.1 : 1)),
      dmg: c.dmg * (1 + 0.11 * st[0]) * lv * (d ? d.dmg : 1) * (t2 ? 1.15 : 1),
      cd: (c.cd / (1 + 0.09 * st[1])) * (d ? d.cd : 1),
      regen: c.hp * (0.008 + 0.006 * st[3]) * (sub === 'druid' && d ? 2 : 1),
      speed: c.speed * (1 + 0.045 * st[4]) * (d ? d.speed : 1),
      gather: c.gather * (1 + 0.22 * st[5]),
    };
  };

  // ------------------------------------------------------------ buildings
  S.RES = ['wood', 'stone', 'gold'];
  S.BUILDINGS = {
    townhall: { name: 'Ратуша', size: 130, hp: 3200, cost: {}, desc: 'Сердце базы: точка возрождения, радиус стройки и лимиты зданий.' },
    wall: { name: 'Стена', size: 44, hp: 550, cost: { stone: 12 }, desc: 'Блокирует врагов. Вы и клан проходите насквозь.' },
    tower: { name: 'Башня лучников', size: 64, hp: 950, cost: { wood: 80, stone: 50 }, range: 540, dmg: 17, rate: 0.85, desc: 'Стреляет по врагам и монстрам.' },
    magetower: { name: 'Башня магов', size: 64, hp: 750, cost: { wood: 60, stone: 90, gold: 70 }, range: 470, dmg: 34, rate: 1.8, splash: 85, desc: 'Бьёт по области и замедляет.' },
    sawmill: { name: 'Лесопилка', size: 76, hp: 650, cost: { wood: 40, stone: 30 }, income: { wood: 2 }, desc: 'Даёт дерево.' },
    quarry: { name: 'Каменоломня', size: 76, hp: 650, cost: { wood: 70 }, income: { stone: 1.6 }, desc: 'Даёт камень.' },
    mine: { name: 'Золотой рудник', size: 76, hp: 750, cost: { wood: 90, stone: 90 }, income: { gold: 1 }, desc: 'Даёт золото.' },
    barracks: { name: 'Казарма', size: 84, hp: 1150, cost: { wood: 150, stone: 100, gold: 80 }, desc: 'Нанимает рыцарей. Они ходят за вами в набеги.' },
    shrine: { name: 'Святилище', size: 60, hp: 650, cost: { stone: 120, gold: 120 }, heal: 12, range: 280, desc: 'Лечит вас, союзников и здания рядом.' },
    warcamp: { name: 'Лагерь наёмников', size: 80, hp: 1000, cost: { wood: 180, stone: 120, gold: 140 }, desc: 'Нанимает наёмников: они сами бегут бить ближайших врагов.' },
  };
  S.BUILD_ORDER = ['townhall', 'wall', 'tower', 'magetower', 'sawmill', 'quarry', 'mine', 'barracks', 'shrine', 'warcamp'];
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
    warcamp: [0, 1, 1, 2, 2],
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
  // other allied units that share the knight AI
  S.ALLY_UNITS = {
    knight: S.KNIGHT,
    merc: { name: 'Наёмник', hp: 150, r: 17, speed: 230, dmg: 15, cd: 0.9 },
    wolf: { name: 'Волк', hp: 90, r: 17, speed: 270, dmg: 10, cd: 0.7 },
    ent: { name: 'Энт', hp: 240, r: 22, speed: 150, dmg: 17, cd: 1.2 },
  };

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
