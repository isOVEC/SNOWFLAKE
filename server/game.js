// Authoritative world simulation.
const S = require('../public/shared.js');
const { BotManager } = require('./bots');

const DT = S.DT;
let nextId = 1;
const newId = () => nextId++;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// ------------------------------------------------------------ spatial grid
class Grid {
  constructor(cell) { this.cell = cell; this.map = new Map(); this.stamp = 0; }
  key(cx, cy) { return cx * 65536 + cy; }
  cells(e, fn) {
    const ext = e.k === 'b' ? e.hs : e.r;
    const c = this.cell;
    const x0 = Math.floor((e.x - ext) / c), x1 = Math.floor((e.x + ext) / c);
    const y0 = Math.floor((e.y - ext) / c), y1 = Math.floor((e.y + ext) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(this.key(x, y));
  }
  add(e) {
    this.cells(e, (k) => {
      let a = this.map.get(k);
      if (!a) this.map.set(k, (a = []));
      a.push(e);
    });
  }
  remove(e) {
    this.cells(e, (k) => {
      const a = this.map.get(k);
      if (!a) return;
      const i = a.indexOf(e);
      if (i >= 0) a.splice(i, 1);
    });
  }
  clear() { this.map.clear(); }
  query(x, y, r, out = []) {
    const c = this.cell, st = ++this.stamp;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const a = this.map.get(this.key(cx, cy));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) {
          const e = a[i];
          if (e._q === st) continue;
          e._q = st;
          out.push(e);
        }
      }
    }
    return out;
  }
}

class Game {
  constructor(opts) {
    this.opts = opts || {};
    this.time = 0;
    this.tickN = 0;
    this.units = new Map(); // heroes, mobs, bosses, knights
    this.projs = new Map();
    this.statics = new Map(); // resource nodes & buildings
    this.profiles = new Map(); // pid -> profile
    this.tokens = new Map(); // token -> pid
    this.clients = new Set();
    this.sgrid = new Grid(160);
    this.ugrid = new Grid(160);
    this.fx = [];
    this.nodeRespawns = [];
    this.bosses = [];
    this.mobCount = 0;
  }

  // ================================================================ world gen
  init(saved) {
    if (saved) this.load(saved);
    this.genNodes();
    for (const def of S.BOSSES) this.spawnBoss(def);
    this.camps = [];
    this.genCamps();
    this.botMgr = new BotManager(this, this.opts.bots || 0);
    this.botMgr.start();
    for (let i = 0; i < S.MOB_CAP * 3 && this.mobCount < S.MOB_CAP; i++) this.spawnMobPack();
  }

  genNodes() {
    const step = 150;
    for (let gx = 0; gx < S.W; gx += step) {
      for (let gy = 0; gy < S.H; gy += step) {
        const x = gx + rand(20, step - 20), y = gy + rand(20, step - 20);
        const b = S.biomeAt(x, y);
        const r = Math.random();
        let type = null;
        switch (b) {
          case S.B.MEADOW: type = r < 0.07 ? 'tree' : r < 0.1 ? 'rock' : r < 0.11 ? 'gold' : null; break;
          case S.B.FOREST: type = r < 0.42 ? 'tree' : r < 0.45 ? 'rock' : r < 0.46 ? 'gold' : null; break;
          case S.B.MOUNTAIN: type = r < 0.25 ? 'rock' : r < 0.33 ? 'gold' : r < 0.35 ? 'tree' : null; break;
          case S.B.SNOW: type = r < 0.16 ? 'tree' : r < 0.23 ? 'rock' : r < 0.26 ? 'gold' : null; break;
          case S.B.SWAMP: type = r < 0.2 ? 'tree' : r < 0.23 ? 'rock' : r < 0.24 ? 'gold' : null; break;
          case S.B.VOLCANO: type = r < 0.1 ? 'rock' : r < 0.2 ? 'gold' : r < 0.23 ? 'tree' : null; break;
        }
        if (!type) continue;
        this.addNode(type, x, y);
      }
    }
  }

  genCamps() {
    const R = Math.random;
    const want = this.opts.camps !== undefined ? this.opts.camps : S.CAMP_COUNT;
    for (let tries = 0; tries < 400 && this.camps.length < want; tries++) {
      const x = 900 + R() * (S.W - 1800), y = 900 + R() * (S.H - 1800);
      if (Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y) < 3200) continue;
      if (S.BOSSES.some((b) => Math.hypot(b.x - x, b.y - y) < 1700)) continue;
      if (this.camps.some((c) => Math.hypot(c.x - x, c.y - y) < 3000)) continue;
      let bad = false;
      for (const s of this.statics.values()) if (s.k === 'b' && s.pid && Math.hypot(s.x - x, s.y - y) < 1300) { bad = true; break; }
      if (bad) continue;
      const biome = S.biomeAt(x, y);
      const fi = S.FACTIONS.findIndex((f) => f.biomes.includes(biome));
      if (fi < 0) continue;
      const camp = { id: this.camps.length, fi, x: Math.round(x), y: Math.round(y), hallId: 0, respawnAt: 0 };
      this.camps.push(camp);
      this.buildCamp(camp);
    }
  }

  buildCamp(camp) {
    const f = S.FACTIONS[camp.fi];
    // clear the ground and any leftovers of the previous camp
    for (const s of [...this.statics.values()]) {
      if ((s.k === 'n' && Math.hypot(s.x - camp.x, s.y - camp.y) < 420) || s.camp === camp.id) this.removeStatic(s);
    }
    const lvl = camp.fi + 1;
    const add = (type, x, y) => {
      const def = S.BUILDINGS[type];
      const maxHp = Math.round(def.hp * S.lvlMul(lvl) * (type === 'npc_hall' ? f.tier : 1));
      const b = {
        id: newId(), k: 'b', type, x: Math.round(x), y: Math.round(y), hs: def.size / 2, r: def.size / 2, lvl, hp: maxHp, maxHp,
        pid: 0, team: 'mob', camp: camp.id, faction: camp.fi, cd: rand(0, 1), lastHurt: -99, acc: 0, aim: 0,
      };
      this.statics.set(b.id, b);
      this.sgrid.add(b);
      return b;
    };
    const hall = add('npc_hall', camp.x, camp.y);
    camp.hallId = hall.id;
    for (let i = 0; i < f.towers; i++) {
      const a = (i / f.towers) * Math.PI * 2 + 0.4;
      add('tower', camp.x + Math.cos(a) * 190, camp.y + Math.sin(a) * 190);
    }
    const n = 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (Math.abs(Math.atan2(Math.sin(a - Math.PI / 2), Math.cos(a - Math.PI / 2))) < 0.3) continue; // gate
      add('wall', camp.x + Math.cos(a) * 330, camp.y + Math.sin(a) * 330);
    }
    for (let i = 0; i < f.guards; i++) this.spawnKnight(hall, 'merc');
  }

  addNode(type, x, y) {
    if (Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y) < 260) return null;
    for (const b of S.BOSSES) if (Math.hypot(x - b.x, y - b.y) < 420) return null;
    const r = type === 'tree' ? rand(26, 38) : type === 'rock' ? rand(28, 40) : rand(22, 30);
    // don't overlap buildings or other nodes
    const near = this.sgrid.query(x, y, r + 90);
    for (const s of near) {
      if (s.k === 'n' && Math.hypot(s.x - x, s.y - y) < s.r + r + 10) return null;
      if (s.k === 'b' && Math.abs(s.x - x) < s.hs + r + 10 && Math.abs(s.y - y) < s.hs + r + 10) return null;
    }
    const hp = type === 'tree' ? 90 : type === 'rock' ? 150 : 220;
    const n = { id: newId(), k: 'n', type, x, y, r, hp, maxHp: hp, biome: S.biomeAt(x, y), v: (Math.random() * 1000) | 0 };
    this.statics.set(n.id, n);
    this.sgrid.add(n);
    return n;
  }

  // ================================================================ profiles
  load(saved) {
    nextId = Math.max(nextId, saved.nextId || 1);
    for (const p of saved.profiles || []) {
      p.online = false;
      p.thId = 0;
      if (!p.startPts) { p.pts += S.START_PTS; p.startPts = true; }
      this.profiles.set(p.pid, p);
      this.tokens.set(p.token, p.pid);
    }
    for (const b of saved.buildings || []) {
      const prof = this.profiles.get(b.pid);
      if (!prof) continue;
      this.addBuilding(prof, b.type, b.x, b.y, b.lvl, b.hp);
    }
  }

  serialize() {
    const profiles = [];
    for (const p of this.profiles.values()) {
      profiles.push({
        pid: p.pid, token: p.token, name: p.name, clan: p.clan, cls: p.cls, sub: p.sub || null, lvl: p.lvl, xp: p.xp, pts: p.pts,
        st: p.st, res: p.res, glory: p.glory, kills: p.kills, thLvl: p.thLvl, lastSeen: p.lastSeen, startPts: true, empowered: !!p.empowered, bot: !!p.bot,
      });
    }
    const buildings = [];
    for (const s of this.statics.values()) {
      if (s.k === 'b' && s.pid) buildings.push({ type: s.type, x: s.x, y: s.y, lvl: s.lvl, hp: Math.round(s.hp), pid: s.pid });
    }
    return { nextId, profiles, buildings };
  }

  teamOf(prof) {
    return prof.clan ? 'c:' + prof.clan.toUpperCase() : 'p:' + prof.pid;
  }

  getProfile(token, name, clan, cls) {
    let pid = token && this.tokens.get(token);
    let prof = pid && this.profiles.get(pid);
    if (!prof) {
      pid = newId();
      token = [...Array(24)].map(() => 'abcdefghijklmnopqrstuvwxyz0123456789'[(Math.random() * 36) | 0]).join('');
      prof = {
        pid, token, name, clan, cls, lvl: 1, xp: 0, pts: S.START_PTS, startPts: true, st: [0, 0, 0, 0, 0, 0],
        res: { wood: 60, stone: 40, gold: 20 }, glory: 0, kills: 0, thLvl: 0, thId: 0, online: false, sub: null,
      };
      this.profiles.set(pid, prof);
      this.tokens.set(token, pid);
    }
    prof.name = name;
    const oldTeam = this.teamOf(prof);
    prof.clan = clan;
    prof.cls = cls;
    const team = this.teamOf(prof);
    if (team !== oldTeam) {
      for (const s of this.statics.values()) if (s.k === 'b' && s.pid === prof.pid) s.team = team;
      for (const u of this.units.values()) if (u.kind === 'knight' && u.pid === prof.pid) u.team = team;
    }
    return prof;
  }

  // ================================================================ clients
  join(client, msg) {
    const name = String(msg.name || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Странник';
    const clan = String(msg.clan || '').replace(/[^0-9A-Za-zА-Яа-яЁё]/g, '').slice(0, 5).toUpperCase();
    const cls = own(S.CLASSES, msg.cls) ? msg.cls : 'warrior';
    const prof = this.getProfile(msg.token, name, clan, cls);
    // kick an older connection of the same profile
    for (const c of this.clients) {
      if (c !== client && c.pid === prof.pid) {
        this.leave(c);
        try { c.ws.close(); } catch (e) { /* ignore */ }
      }
    }
    client.pid = prof.pid;
    client.prof = prof;
    client.inputs = [];
    client.ack = 0;
    client.events = [];
    prof.online = true;
    this.clients.add(client);
    this.spawnHero(client);
    client.send({ t: 'welcome', id: prof.pid, token: prof.token, tm: Math.round(this.time * 1000) });
    if (!msg.quiet) this.feed(`${this.dispName(prof)} вошёл в мир`);
  }

  leave(client) {
    if (!this.clients.has(client)) return;
    this.clients.delete(client);
    const prof = client.prof;
    if (prof) {
      prof.online = false;
      prof.lastSeen = Date.now();
      if (client.hero) this.units.delete(client.hero.id);
      this.feed(`${this.dispName(prof)} покинул мир`);
    }
    client.hero = null;
  }

  dispName(prof) { return (prof.clan ? `[${prof.clan}] ` : '') + prof.name; }

  thOf(prof) {
    const th = prof.thId && this.statics.get(prof.thId);
    return th && th.k === 'b' ? th : null;
  }

  spawnHero(client, cls) {
    const prof = client.prof;
    if (cls && own(S.CLASSES, cls) && cls !== prof.cls) { prof.cls = cls; prof.sub = null; prof.empowered = false; }
    if (!S.subOf(prof.cls, prof.sub)) prof.sub = null;
    const c = S.heroDef(prof.sub || prof.cls);
    const stats = S.heroStats(prof.cls, prof.st, prof.lvl, prof.sub);
    let x, y;
    const th = this.thOf(prof);
    if (th) {
      const a = Math.random() * Math.PI * 2;
      x = th.x + Math.cos(a) * (th.hs + 50);
      y = th.y + Math.sin(a) * (th.hs + 50);
    } else {
      const a = Math.random() * Math.PI * 2, d = rand(0, 220);
      x = S.SPAWN.x + Math.cos(a) * d;
      y = S.SPAWN.y + Math.sin(a) * d;
    }
    const h = {
      id: prof.pid, kind: 'hero', type: prof.sub || prof.cls, cls: prof.cls, sub: prof.sub,
      tier: prof.sub ? (prof.lvl >= S.EMPOWER_LVL ? 2 : 1) : 0, pid: prof.pid, team: this.teamOf(prof),
      rageT: 0, bastionT: 0, shieldT: 0, stealthT: 0, ambush: 0, stormN: 0, stormT: 0, whirlT: 0, petT: 0,
      x, y, r: c.r, hp: stats.maxHp, maxHp: stats.maxHp, stats,
      aim: 0, firing: false, abil: false, cd: 0, acd: 0, slowT: 0, slowF: 1, kbx: 0, kby: 0,
      dashT: 0, dashVx: 0, dashVy: 0, dashHit: null, lastHurt: -99, invulnT: 2.5, atkN: 0,
      dead: false, recallT: 0, client,
    };
    const p = { x: h.x, y: h.y };
    S.resolve(p, h.r, this.sgrid.query(p.x, p.y, 200), (s) => this.passable(s, h.team));
    h.x = p.x; h.y = p.y;
    client.hero = h;
    client.deadInfo = null;
    this.units.set(h.id, h);
  }

  refreshHeroStats(h) {
    const prof = h.client.prof;
    const s = S.heroStats(prof.cls, prof.st, prof.lvl, prof.sub);
    const ratio = h.hp / h.maxHp;
    h.cls = prof.cls; h.sub = prof.sub; h.type = prof.sub || prof.cls;
    h.tier = prof.sub ? (prof.lvl >= S.EMPOWER_LVL ? 2 : 1) : 0;
    h.r = S.heroDef(h.type).r;
    h.stats = s;
    h.maxHp = s.maxHp;
    h.hp = Math.min(h.maxHp, Math.max(1, ratio * h.maxHp));
  }

  passable(s, team) { return s.type === 'wall' && s.team === team; }

  onMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') { if (!client.pid) this.join(client, msg); return; }
    if (!client.pid) return;
    const h = client.hero;
    const prof = client.prof;
    switch (msg.t) {
      case 'i': {
        if (client.inputs.length > 12) client.inputs.splice(0, client.inputs.length - 4);
        client.inputs.push({
          s: msg.s | 0,
          mx: Math.max(-1, Math.min(1, +msg.mx || 0)),
          my: Math.max(-1, Math.min(1, +msg.my || 0)),
          a: +msg.a || 0, f: !!msg.f, ab: !!msg.ab,
        });
        break;
      }
      case 'view':
        client.vw = Math.min(1500, Math.max(400, +msg.w || 1000));
        client.vh = Math.min(1000, Math.max(300, +msg.h || 650));
        break;
      case 'respawn':
        if (h && h.dead && client.deadInfo && this.time >= client.deadInfo.until) this.spawnHero(client, msg.cls);
        break;
      case 'stat': {
        const i = msg.i | 0;
        if (i >= 0 && i < 6 && prof.pts > 0 && prof.st[i] < S.STAT_MAX) {
          prof.st[i]++;
          prof.pts--;
          if (h && !h.dead) this.refreshHeroStats(h);
        }
        break;
      }
      case 'build': this.tryBuild(client, String(msg.type), +msg.x, +msg.y); break;
      case 'evolve': {
        const d = S.subOf(prof.cls, String(msg.sub));
        if (!d || prof.sub || prof.lvl < S.EVOLVE_LVL) return;
        prof.sub = String(msg.sub);
        if (h && !h.dead) {
          this.refreshHeroStats(h);
          h.acd = 0;
          this.fx.push(['lvl', h.x, h.y, h.r]);
        }
        this.feed(`✦ ${this.dispName(prof)} становится: ${d.name}`);
        break;
      }
      case 'up': this.tryUpgrade(client, msg.id | 0); break;
      case 'del': this.tryDemolish(client, msg.id | 0); break;
      case 'recall':
        if (h && !h.dead && this.thOf(prof) && h.recallT <= 0) h.recallT = 3.5;
        break;
      case 'dev':
        // debug helpers, only enabled with DEV=1
        if (process.env.DEV !== '1' || !h) return;
        if (isFinite(msg.x)) { h.x = +msg.x; h.y = +msg.y; }
        if (msg.res) for (const r of S.RES) prof.res[r] = 20000;
        if (msg.xp) this.giveXp(prof, +msg.xp);
        if (msg.mob && own(S.MOBS, msg.mob)) { const m = this.spawnMob(msg.mob, h.x + rand(-250, 250), h.y - 250, 1); m.target = null; }
        break;
      case 'chat': {
        const m = String(msg.m || '').replace(/[<>]/g, '').trim().slice(0, 140);
        if (!m || this.time - (client.lastChat || -9) < 0.8) return;
        client.lastChat = this.time;
        this.broadcast({ t: 'chat', id: prof.pid, n: prof.name, c: prof.clan, m });
        break;
      }
    }
  }

  // ================================================================ building
  countOf(pid, type) {
    let n = 0;
    for (const s of this.statics.values()) if (s.k === 'b' && s.pid === pid && s.type === type) n++;
    return n;
  }

  pay(prof, cost) {
    for (const k in cost) prof.res[k] -= cost[k];
  }

  notify(client, m) { client.events.push({ k: 'msg', m }); }

  placementError(prof, type, x, y) {
    const def = S.BUILDINGS[type];
    const hs = def.size / 2;
    if (x < hs || y < hs || x > S.W - hs || y > S.H - hs) return 'За краем мира';
    const th = this.thOf(prof);
    if (type === 'townhall') {
      if (th) return 'Ратуша уже есть';
      for (const s of this.statics.values()) {
        if (s.k === 'b' && s.type === 'townhall' && Math.hypot(s.x - x, s.y - y) < 1100) return 'Слишком близко к чужой ратуше';
        if (s.k === 'b' && s.type === 'npc_hall' && Math.hypot(s.x - x, s.y - y) < 1200) return 'Слишком близко к вражескому поселению';
      }
      for (const b of S.BOSSES) if (Math.hypot(b.x - x, b.y - y) < 1000) return 'Слишком близко к логову босса';
      if (Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y) < 450) return 'Нельзя строить на площади возрождения';
    } else {
      if (!th) return 'Сначала поставьте ратушу';
      if (Math.hypot(th.x - x, th.y - y) > S.thRadius(th.lvl) - hs * 0.5) return 'Вне радиуса вашей базы';
      const cap = S.CAPS[type][th.lvl - 1];
      if (this.countOf(prof.pid, type) >= cap) return cap === 0 ? 'Нужна ратуша выше уровнем' : 'Достигнут лимит (улучшите ратушу)';
    }
    const near = this.sgrid.query(x, y, hs + 60);
    for (const s of near) {
      if (s.k === 'n' && Math.abs(s.x - x) < hs + s.r - 4 && Math.abs(s.y - y) < hs + s.r - 4) return 'Мешает ресурс';
      if (s.k === 'b' && Math.abs(s.x - x) < hs + s.hs - 1 && Math.abs(s.y - y) < hs + s.hs - 1) return 'Место занято';
    }
    for (const u of this.ugrid.query(x, y, hs + 100)) {
      if ((u.kind === 'boss' || u.kind === 'hero') && u.team !== prof.team &&
        Math.abs(u.x - x) < hs + u.r && Math.abs(u.y - y) < hs + u.r) return 'Мешает враг';
    }
    return null;
  }

  tryBuild(client, type, x, y) {
    const prof = client.prof;
    const def = S.BUILD_ORDER.includes(type) ? S.BUILDINGS[type] : null;
    const h = client.hero;
    if (!def || !isFinite(x) || !isFinite(y) || !h || h.dead) return;
    x = S.snap(type, x); y = S.snap(type, y);
    if (Math.hypot(h.x - x, h.y - y) > 1400) return;
    prof.team = this.teamOf(prof);
    const err = this.placementError(prof, type, x, y);
    if (err) { this.notify(client, err); return; }
    let cost = def.cost;
    if (type === 'townhall') cost = prof.thLvl > 0 ? S.thRebuildCost(prof.thLvl) : {};
    if (!S.canAfford(prof.res, cost)) { this.notify(client, 'Не хватает ресурсов'); return; }
    this.pay(prof, cost);
    const lvl = type === 'townhall' ? Math.max(1, prof.thLvl) : 1;
    const b = this.addBuilding(prof, type, x, y, lvl);
    if (type === 'townhall') {
      prof.thLvl = b.lvl;
      this.feed(`${this.dispName(prof)} основал поселение`);
    }
    this.fx.push(['build', x, y, def.size]);
  }

  addBuilding(prof, type, x, y, lvl, hp) {
    const def = S.BUILDINGS[type];
    const maxHp = Math.round(def.hp * S.lvlMul(lvl));
    const b = {
      id: newId(), k: 'b', type, x, y, hs: def.size / 2, r: def.size / 2, lvl,
      hp: hp ? Math.min(hp, maxHp) : maxHp, maxHp, pid: prof.pid, team: this.teamOf(prof),
      cd: rand(0, 1), lastHurt: -99, acc: 0, aim: 0,
    };
    this.statics.set(b.id, b);
    this.sgrid.add(b);
    if (type === 'townhall') prof.thId = b.id;
    return b;
  }

  tryUpgrade(client, id) {
    const prof = client.prof;
    const b = this.statics.get(id);
    if (!b || b.k !== 'b' || b.pid !== prof.pid) return;
    let cost;
    if (b.type === 'townhall') {
      if (b.lvl >= S.TH_MAX) return this.notify(client, 'Максимальный уровень');
      cost = S.thUpgradeCost(b.lvl + 1);
    } else {
      const th = this.thOf(prof);
      if (b.lvl >= S.BLD_MAX) return this.notify(client, 'Максимальный уровень');
      if (!th || b.lvl >= th.lvl) return this.notify(client, 'Сначала улучшите ратушу');
      cost = S.bldUpgradeCost(b.type, b.lvl + 1);
    }
    if (!S.canAfford(prof.res, cost)) return this.notify(client, 'Не хватает ресурсов');
    this.pay(prof, cost);
    b.lvl++;
    const def = S.BUILDINGS[b.type];
    const ratio = b.hp / b.maxHp;
    b.maxHp = Math.round(def.hp * S.lvlMul(b.lvl));
    b.hp = Math.max(ratio, 0.5) * b.maxHp;
    if (b.type === 'townhall') prof.thLvl = b.lvl;
    this.fx.push(['lvl', b.x, b.y, b.hs]);
  }

  tryDemolish(client, id) {
    const prof = client.prof;
    const b = this.statics.get(id);
    if (!b || b.k !== 'b' || b.pid !== prof.pid || b.type === 'townhall') return;
    const def = S.BUILDINGS[b.type];
    for (const k in def.cost) prof.res[k] += Math.round(def.cost[k] * 0.5);
    this.removeStatic(b);
    this.fx.push(['death', b.x, b.y, 3]);
  }

  removeStatic(s) {
    this.statics.delete(s.id);
    this.sgrid.remove(s);
  }

  // ================================================================ monsters
  spawnMobPack() {
    for (let tries = 0; tries < 10; tries++) {
      const x = rand(100, S.W - 100), y = rand(100, S.H - 100);
      if (Math.hypot(x - S.SPAWN.x, y - S.SPAWN.y) < 900) continue;
      let bad = false;
      for (const s of this.statics.values()) {
        if (s.k === 'b' && s.type === 'townhall' && Math.hypot(s.x - x, s.y - y) < S.thRadius(s.lvl) + 250) { bad = true; break; }
      }
      if (bad) continue;
      for (const c of this.clients) {
        const h = c.hero;
        if (h && !h.dead && Math.abs(h.x - x) < 1100 && Math.abs(h.y - y) < 800) { bad = true; break; }
      }
      if (bad) continue;
      const biome = S.biomeAt(x, y);
      const type = pick(S.BIOME_MOBS[biome]);
      const n = type === 'golem' ? 1 : 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) this.spawnMob(type, x + rand(-60, 60), y + rand(-60, 60), S.BIOME_TIER[biome]);
      return;
    }
  }

  spawnMob(type, x, y, tier, owner) {
    const d = S.MOBS[type];
    const m = {
      id: newId(), kind: 'mob', type, team: 'mob', x, y, r: d.r, hp: d.hp * tier, maxHp: d.hp * tier,
      tier, def: d, homeX: x, homeY: y, target: null, cd: 0, aim: rand(0, 6.28),
      wanderT: 0, wx: x, wy: y, slowT: 0, slowF: 1, kbx: 0, kby: 0, lastHurt: -99, owner: owner || null,
    };
    const p = { x, y };
    S.resolve(p, m.r, this.sgrid.query(x, y, 200));
    m.x = p.x; m.y = p.y;
    this.units.set(m.id, m);
    if (!owner) this.mobCount++;
    return m;
  }

  spawnBoss(def) {
    const b = {
      id: newId(), kind: 'boss', type: def.key, def, team: 'mob', x: def.x, y: def.y, r: def.r,
      hp: def.hp, maxHp: def.hp, homeX: def.x, homeY: def.y, target: null, aim: 0,
      t: 0, phase: 0, pt: 0, slowT: 0, slowF: 1, kbx: 0, kby: 0, dmgBy: new Map(), lastHurt: -99,
      summons: 0, dashT: 0, dvx: 0, dvy: 0,
    };
    this.units.set(b.id, b);
    const slot = this.bosses.find((s) => s.def === def);
    if (slot) { slot.unit = b; slot.respawnAt = 0; } else this.bosses.push({ def, unit: b, respawnAt: 0 });
    return b;
  }

  spawnKnight(bar, type) {
    const prof = this.profiles.get(bar.pid);
    type = type || 'knight';
    const k = S.ALLY_UNITS[type];
    const m = S.lvlMul(bar.lvl) * (bar.pid ? 1 : S.FACTIONS[bar.faction].tier);
    const a = Math.random() * 6.28;
    const u = {
      id: newId(), kind: 'knight', type, pid: bar.pid, team: bar.team, bar: bar.id, speed: k.speed, cdMax: k.cd,
      merc: type === 'merc' && !!bar.pid,
      x: bar.x + Math.cos(a) * (bar.hs + 25), y: bar.y + Math.sin(a) * (bar.hs + 25), r: k.r,
      hp: k.hp * m, maxHp: k.hp * m, dmg: k.dmg * m, cd: 0, aim: a, target: null,
      slowT: 0, slowF: 1, kbx: 0, kby: 0, lastHurt: -99,
      name: prof ? prof.name : bar.faction !== undefined ? 'стража: ' + S.FACTIONS[bar.faction].name : '',
    };
    this.units.set(u.id, u);
    return u;
  }

  // ================================================================ combat
  hostile(a, b) { return a.team !== b.team; }

  targetable(u) { return !(u.dead || (u.kind === 'hero' && (u.invulnT > 0 || u.stealthT > 0))); }

  // src: {pid, team, hero (bool: gathering allowed), x, y, kb}
  hurt(t, amount, src) {
    if (amount <= 0) return;
    if (t.k === 'n') {
      if (!src.hero) return;
      const prof = this.profiles.get(src.pid);
      const h = prof && prof.online ? this.units.get(prof.pid) : null;
      const gm = h && h.stats ? h.stats.gather : 1;
      const dealt = Math.min(t.hp, amount);
      t.hp -= amount;
      const rate = t.type === 'tree' ? 0.36 : t.type === 'rock' ? 0.27 : 0.16;
      const res = t.type === 'tree' ? 'wood' : t.type === 'rock' ? 'stone' : 'gold';
      let gain = dealt * rate * gm;
      if (t.hp <= 0) {
        gain += (t.type === 'gold' ? 12 : 18) * gm;
        this.removeStatic(t);
        this.fx.push(['death', t.x, t.y, t.type === 'tree' ? 1 : t.type === 'rock' ? 2 : 4]);
        this.nodeRespawns.push({ at: this.time + rand(45, 90), type: t.type, x: t.x, y: t.y });
      }
      this.fx.push(['hit', t.x, t.y, 0, t.type === 'tree' ? 1 : t.type === 'rock' ? 2 : 3]);
      if (prof) this.giveRes(prof, res, gain, t.x, t.y - t.r);
      if (prof) this.giveXp(prof, gain * 0.25);
      return;
    }
    if (t.k === 'b') {
      if (t.team === src.team) return;
      t.hp -= amount;
      t.lastHurt = this.time;
      this.fx.push(['hit', t.x, t.y - t.hs * 0.3, Math.round(amount), 4]);
      if (t.hp <= 0) this.destroyBuilding(t, src);
      return;
    }
    // units
    if (t.dead || (t.kind === 'hero' && t.invulnT > 0)) return;
    if (t.kind === 'hero') {
      t.recallT = 0;
      if (t.bastionT > 0) amount *= 0.2;
      else if (t.sub === 'guardian' && src.x !== undefined && angDiff(Math.atan2(src.y - t.y, src.x - t.x), t.aim) < 1.2) amount *= 0.6;
      if (t.shieldT > 0) amount *= 0.3;
    }
    if (src.ls) {
      const a = this.units.get(src.unitId);
      if (a && !a.dead) a.hp = Math.min(a.maxHp, a.hp + amount * src.ls);
    }
    t.hp -= amount;
    t.lastHurt = this.time;
    this.fx.push(['hit', t.x, t.y - t.r, Math.round(amount), 0]);
    if (src.kb && t.kind !== 'boss') {
      const dx = t.x - src.x, dy = t.y - src.y, d = Math.hypot(dx, dy) || 1;
      t.kbx += (dx / d) * src.kb;
      t.kby += (dy / d) * src.kb;
    }
    if (t.kind === 'boss' && src.pid) t.dmgBy.set(src.pid, (t.dmgBy.get(src.pid) || 0) + amount);
    if ((t.kind === 'mob' || t.kind === 'boss' || t.kind === 'knight') && src.unitId) {
      const att = this.units.get(src.unitId);
      if (att && !att.dead && (t.kind !== 'boss' || !t.target)) t.target = att;
    }
    if (t.hp <= 0) this.killUnit(t, src);
  }

  giveRes(prof, res, amount, x, y) {
    const th = this.thOf(prof);
    const cap = S.resCap(th ? th.lvl : 0);
    const before = prof.res[res];
    prof.res[res] = Math.min(cap, prof.res[res] + amount);
    const got = prof.res[res] - before;
    if (x !== undefined && prof.online) {
      const c = this.clientOf(prof.pid);
      if (c) c.events.push({ k: 'res', x: Math.round(x), y: Math.round(y), r: res, v: Math.round(got * 10) / 10, full: got < amount * 0.5 });
    }
  }

  giveXp(prof, amount) {
    if (prof.lvl >= S.MAX_LVL) return;
    prof.xp += amount;
    let up = false;
    while (prof.lvl < S.MAX_LVL && prof.xp >= S.xpFor(prof.lvl)) {
      prof.xp -= S.xpFor(prof.lvl);
      prof.lvl++;
      prof.pts++;
      up = true;
    }
    if (up && prof.sub && prof.lvl >= S.EMPOWER_LVL && !prof.empowered) {
      prof.empowered = true;
      this.feed(`✦ Сила «${S.SUBCLASSES[prof.sub].name}» пробуждается в ${this.dispName(prof)}!`, true);
    }
    if (up) {
      const h = this.units.get(prof.pid);
      if (h && h.kind === 'hero' && !h.dead) {
        this.refreshHeroStats(h);
        h.hp = Math.min(h.maxHp, h.hp + h.maxHp * 0.3);
        this.fx.push(['lvl', h.x, h.y, h.r]);
      }
    }
  }

  clientOf(pid) {
    for (const c of this.clients) if (c.pid === pid) return c;
    return null;
  }

  killUnit(u, src) {
    const killer = src.pid ? this.profiles.get(src.pid) : null;
    if (u.kind === 'hero') {
      u.dead = true;
      u.hp = 0;
      const prof = u.client.prof;
      this.units.delete(u.id);
      this.fx.push(['death', u.x, u.y, 0]);
      let lost = 0;
      if (killer && killer.pid !== prof.pid) {
        lost = Math.floor(prof.res.gold * 0.2);
        prof.res.gold -= lost;
        this.giveRes(killer, 'gold', lost);
        this.giveXp(killer, 40 + prof.lvl * 18);
        killer.glory += 10 + prof.lvl * 2;
        killer.kills++;
        this.feed(`⚔ ${this.dispName(killer)} сразил ${this.dispName(prof)}`);
      }
      // lose a part of the current level progress
      prof.xp *= 0.5;
      const by = killer ? this.dispName(killer) : src.name || 'монстр';
      u.client.deadInfo = { until: this.time + 3, by, lost };
      u.client.send({ t: 'dead', by, lost, wait: 3 });
      return;
    }
    this.units.delete(u.id);
    u.dead = true;
    if (u.kind === 'mob') {
      if (!u.owner) this.mobCount--;
      else { const o = this.units.get(u.owner); if (o) o.summons--; }
      this.fx.push(['death', u.x, u.y, 5]);
      if (killer) {
        const d = u.def;
        this.giveXp(killer, d.xp * u.tier * (u.owner ? 0.3 : 1));
        this.giveRes(killer, 'gold', d.gold * u.tier * (u.owner ? 0.3 : 1), u.x, u.y - u.r);
        killer.glory += u.owner ? 0 : 1;
      }
    } else if (u.kind === 'knight') {
      this.fx.push(['death', u.x, u.y, 5]);
      if (killer) this.giveXp(killer, 20);
    } else if (u.kind === 'boss') {
      this.fx.push(['bossdeath', u.x, u.y, u.r]);
      const slot = this.bosses.find((s) => s.unit === u);
      if (slot) slot.respawnAt = this.time + 180;
      let total = 0;
      for (const v of u.dmgBy.values()) total += v;
      const names = [];
      const sorted = [...u.dmgBy.entries()].sort((a, b) => b[1] - a[1]);
      for (const [pid, dmg] of sorted) {
        const prof = this.profiles.get(pid);
        if (!prof) continue;
        const share = Math.max(0.1, dmg / total);
        this.giveXp(prof, u.def.xp * share);
        for (const r of S.RES) this.giveRes(prof, r, u.def.loot[r] * share);
        prof.glory += Math.round(80 * share) + 5;
        if (names.length < 4) names.push(this.dispName(prof));
      }
      this.feed(`☠ ${u.def.name} повержен! Герои: ${names.join(', ') || '—'}`, true);
    }
  }

  destroyBuilding(b, src) {
    this.removeStatic(b);
    this.fx.push(['death', b.x, b.y, 3]);
    const owner = this.profiles.get(b.pid);
    const killer = src.pid ? this.profiles.get(src.pid) : null;
    const def = S.BUILDINGS[b.type];
    if (killer && killer.pid !== b.pid) {
      // loot part of what the building cost
      for (const k in def.cost) this.giveRes(killer, k, def.cost[k] * b.lvl * 0.5);
      this.giveXp(killer, 15 + 10 * b.lvl * (b.type === 'wall' ? 0.3 : 1));
      if (b.type !== 'wall') killer.glory += 2 * b.lvl;
    }
    if (b.type === 'npc_hall') {
      const camp = this.camps[b.camp];
      if (camp) camp.respawnAt = this.time + S.CAMP_RESPAWN;
      const f = S.FACTIONS[b.faction];
      if (killer) {
        for (const r of S.RES) this.giveRes(killer, r, 250 * f.tier);
        this.giveXp(killer, 450 * f.tier);
        killer.glory += Math.round(25 * f.tier);
        this.feed(`🔥 ${this.dispName(killer)} разорил: ${f.name}!`, true);
      }
    }
    if (b.type === 'townhall' && owner) {
      owner.thId = 0;
      if (killer && killer.pid !== owner.pid) {
        const stolen = {};
        for (const r of S.RES) {
          stolen[r] = Math.floor(owner.res[r] * 0.3);
          owner.res[r] -= stolen[r];
          this.giveRes(killer, r, stolen[r]);
        }
        killer.glory += 25 * b.lvl;
        this.feed(`🔥 ${this.dispName(killer)} разрушил ратушу ${this.dispName(owner)} и унёс ${stolen.wood}🪵 ${stolen.stone}🪨 ${stolen.gold}🪙`, true);
      } else {
        this.feed(`🔥 Ратуша ${this.dispName(owner)} пала`);
      }
    }
  }

  meleeSwing(h, range, arc, dmg) {
    const src = this.srcOf(h, true);
    src.kb = 140;
    for (const u of this.ugrid.query(h.x, h.y, range + 100)) {
      if (u === h || !this.hostile(h, u) || !this.targetable(u)) continue;
      const d = Math.sqrt(dist2(h, u));
      if (d > range + u.r) continue;
      if (d > u.r && angDiff(Math.atan2(u.y - h.y, u.x - h.x), h.aim) > arc) continue;
      this.hurt(u, dmg, src);
    }
    for (const s of this.sgrid.query(h.x, h.y, range + 60)) {
      if (!this.statics.has(s.id)) continue;
      const cx = s.k === 'b' ? Math.max(s.x - s.hs, Math.min(h.x, s.x + s.hs)) : s.x;
      const cy = s.k === 'b' ? Math.max(s.y - s.hs, Math.min(h.y, s.y + s.hs)) : s.y;
      const d = Math.hypot(cx - h.x, cy - h.y) - (s.k === 'n' ? s.r : 0);
      if (d > range) continue;
      if (d > 8 && angDiff(Math.atan2(cy - h.y, cx - h.x), h.aim) > arc) continue;
      if (s.k === 'b' && s.team === h.team) continue;
      this.hurt(s, s.k === 'b' ? dmg * 0.9 : dmg, src);
    }
  }

  srcOf(u, hero) {
    const name = u.kind === 'hero' ? u.client.prof.name : u.kind === 'boss' ? u.def.name : u.kind === 'mob' ? u.def.name : u.name;
    return { pid: u.pid || null, team: u.team, hero: !!hero, x: u.x, y: u.y, unitId: u.id, name, ls: u.sub === 'berserker' ? 0.12 : 0 };
  }

  shoot(owner, type, x, y, ang, speed, life, dmg, r, extra) {
    if (owner.kind === 'boss') owner.atkN = (owner.atkN || 0) + 1;
    const p = {
      id: newId(), type, x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed, life, dmg, r,
      team: owner.team, pid: owner.pid || null, hero: owner.kind === 'hero', unitId: owner.kind ? owner.id : 0,
      name: owner.kind === 'hero' ? owner.client.prof.name : owner.def ? owner.def.name : (owner.k === 'b' ? 'башня' : ''),
      splash: 0, slow: 0, pierce: 0, hit: null, kb: 0,
    };
    if (extra) Object.assign(p, extra);
    this.projs.set(p.id, p);
    return p;
  }

  heroAttack(h) {
    const c = S.CLASSES[h.cls];
    h.atkN++;
    let dmg = h.stats.dmg;
    if (h.stealthT > 0 || h.ambush > 0) {
      dmg *= h.tier === 2 ? 3 : 2;
      h.stealthT = 0;
      h.ambush = 0;
    }
    const mx = h.x + Math.cos(h.aim) * h.r, my = h.y + Math.sin(h.aim) * h.r;
    const sub = h.sub;
    if (h.cls === 'warrior') {
      const d = S.subOf(h.cls, sub);
      this.meleeSwing(h, d ? d.range : c.range, d ? d.arc : c.arc, dmg, sub === 'cavalier' ? 220 : 140);
    } else if (sub === 'sniper') {
      const d = S.SUBCLASSES.sniper;
      this.shoot(h, 'bolt_x', mx, my, h.aim, d.projSpeed, d.life, dmg, 7, { pierce: h.tier === 2 ? 4 : 2, kb: 120 });
    } else if (sub === 'shadow') {
      for (let i = -1; i <= 1; i++) this.shoot(h, 'dagger', mx, my, h.aim + i * 0.16, 950, 0.5, dmg * 0.6, 6);
    } else if (h.cls === 'ranger') {
      this.shoot(h, 'arrow', mx, my, h.aim, c.projSpeed, c.life, dmg, 6);
    } else if (sub === 'storm') {
      this.chainLightning(h, dmg, h.tier === 2 ? 4 : 3);
    } else if (sub === 'druid') {
      this.shoot(h, 'thorn', mx, my, h.aim, 720, 0.9, dmg * 0.95, 9, { pierce: 1, slow: 0.6 });
    } else if (sub === 'holy') {
      this.shoot(h, 'holy', mx, my, h.aim, 650, 1.0, dmg * 1.05, 10, { splash: 60, holy: 1 });
    } else {
      this.shoot(h, 'fire', mx, my, h.aim, c.projSpeed, c.life, dmg, 11, { splash: c.splash });
    }
  }

  // instant lightning that jumps between enemies
  chainLightning(h, dmg, jumps) {
    const range = 480;
    const src = this.srcOf(h, true);
    src.kb = 60;
    let best = null, bd = Infinity;
    for (const u of this.ugrid.query(h.x, h.y, range + 100)) {
      if (u === h || !this.hostile(h, u) || !this.targetable(u)) continue;
      const d = Math.sqrt(dist2(h, u)) - u.r;
      if (d > range || angDiff(Math.atan2(u.y - h.y, u.x - h.x), h.aim) > 0.55) continue;
      if (d < bd) { bd = d; best = u; }
    }
    if (!best) {
      // no unit: strike a building or resource node in front (lets storm mages gather)
      let sb = null, sd = Infinity;
      for (const st of this.sgrid.query(h.x, h.y, range)) {
        if (!this.statics.has(st.id) || (st.k === 'b' && st.team === h.team)) continue;
        const d = Math.hypot(st.x - h.x, st.y - h.y) - (st.k === 'b' ? st.hs : st.r);
        if (d > range || angDiff(Math.atan2(st.y - h.y, st.x - h.x), h.aim) > 0.4) continue;
        if (d < sd) { sd = d; sb = st; }
      }
      if (sb) { this.fx.push(['bolt', h.x, h.y, sb.x, sb.y]); this.hurt(sb, dmg, src); return; }
      this.fx.push(['bolt', h.x, h.y, h.x + Math.cos(h.aim) * range, h.y + Math.sin(h.aim) * range]);
      return;
    }
    const hit = new Set();
    let from = h, cur = best;
    for (let i = 0; i < jumps && cur; i++) {
      this.fx.push(['bolt', from.x, from.y, cur.x, cur.y]);
      hit.add(cur.id);
      this.hurt(cur, dmg, src);
      dmg *= 0.8;
      from = cur;
      let next = null, nd = 230 * 230;
      for (const u of this.ugrid.query(cur.x, cur.y, 330)) {
        if (u === h || hit.has(u.id) || !this.hostile(h, u) || !this.targetable(u)) continue;
        const d = dist2(cur, u);
        if (d < nd) { nd = d; next = u; }
      }
      cur = next;
    }
  }

  heroAoe(h, R, dmg, kb, fx, affectBuildings) {
    const src = this.srcOf(h, true);
    src.kb = kb;
    for (const u of this.ugrid.query(h.x, h.y, R + 100)) {
      if (u === h || !this.hostile(h, u) || !this.targetable(u)) continue;
      if (Math.sqrt(dist2(h, u)) > R + u.r) continue;
      this.hurt(u, dmg, src);
    }
    if (affectBuildings) {
      for (const st of this.sgrid.query(h.x, h.y, R)) {
        if (st.k === 'b' && st.team !== h.team && this.statics.has(st.id) && Math.hypot(st.x - h.x, st.y - h.y) < R + st.hs) this.hurt(st, dmg * 0.6, src);
      }
    }
    if (fx) this.fx.push([fx, h.x, h.y, R]);
  }

  healAllies(h, R, frac, shield) {
    for (const u of this.ugrid.query(h.x, h.y, R + 50)) {
      if (u.team !== h.team || u.dead || u.kind === 'boss' || Math.sqrt(dist2(h, u)) > R + u.r) continue;
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * frac);
      if (shield) u.shieldT = shield;
    }
  }

  heroAbility(h) {
    const c = S.CLASSES[h.cls];
    const mul = h.stats.dmg / c.dmg;
    const t2 = h.tier === 2;
    h.acd = S.abilityCd(h.cls, h.sub, h.client.prof.lvl);
    const sub = h.sub;
    const d = S.subOf(h.cls, sub);
    if (!d) {
      if (h.cls === 'warrior') this.startDash(h, 0.22, 1400, c.ability.dmg * mul, 260);
      else if (h.cls === 'ranger') {
        for (let i = -4; i <= 4; i++) this.shoot(h, 'arrow', h.x, h.y, h.aim + i * 0.1, c.projSpeed, c.life, c.ability.dmg * mul, 6, { pierce: 1 });
      } else {
        const R = c.ability.radius;
        for (const u of this.ugrid.query(h.x, h.y, R + 100)) {
          if (u === h || !this.hostile(h, u) || !this.targetable(u) || Math.sqrt(dist2(h, u)) > R + u.r) continue;
          u.slowT = 2.5; u.slowF = 0.45;
        }
        this.heroAoe(h, R, c.ability.dmg * mul, 200, 'nova', true);
      }
      return;
    }
    switch (sub) {
      case 'cavalier':
        this.startDash(h, 0.35, 1600, d.ability.dmg * mul * (t2 ? 1.5 : 1), 500);
        h.dashShock = t2;
        break;
      case 'guardian':
        h.bastionT = 3;
        this.heroAoe(h, 170, d.ability.dmg * mul, 420, 'shield');
        break;
      case 'berserker':
        h.rageT = t2 ? 6 : 5;
        h.whirlT = 0;
        this.fx.push(['rage', h.x, h.y, h.r]);
        break;
      case 'sniper': {
        const n = t2 ? 1 : 0;
        for (let i = -n; i <= n; i++) {
          this.shoot(h, 'bigbolt', h.x, h.y, h.aim + i * 0.12, 1800, 0.9, h.stats.dmg * d.ability.dmg / d.dmg, 12, { pierce: 99, kb: 320 });
        }
        break;
      }
      case 'beastmaster': {
        for (const u of this.units.values()) if (u.kind === 'knight' && u.pet && u.pid === h.pid) u.hp = u.maxHp;
        for (let i = 0; i < (t2 ? 5 : 3); i++) this.spawnPet(h, 'wolf', 12);
        this.fx.push(['howl', h.x, h.y, 200]);
        break;
      }
      case 'shadow': {
        this.fx.push(['blink', h.x, h.y, 0]);
        const dx = Math.cos(h.aim), dy = Math.sin(h.aim);
        const canPass = (st) => this.passable(st, h.team);
        for (let i = 0; i < 16; i++) {
          const p = { x: h.x + dx * 20, y: h.y + dy * 20 };
          S.resolve(p, h.r, this.sgrid.query(p.x, p.y, h.r + 80), canPass);
          if (Math.hypot(p.x - h.x, p.y - h.y) < 8) break;
          h.x = p.x; h.y = p.y;
        }
        this.fx.push(['blink', h.x, h.y, 0]);
        h.stealthT = t2 ? 4 : 2.5;
        h.ambush = 1;
        break;
      }
      case 'storm':
        h.stormN = t2 ? 16 : 10;
        h.stormT = 0;
        break;
      case 'druid': {
        const R = d.ability.radius;
        for (const u of this.ugrid.query(h.x, h.y, R + 100)) {
          if (u === h || !this.hostile(h, u) || !this.targetable(u) || Math.sqrt(dist2(h, u)) > R + u.r) continue;
          u.slowT = t2 ? 2.8 : 2; u.slowF = 0.05;
        }
        this.heroAoe(h, R, d.ability.dmg * mul, 0, 'roots');
        this.healAllies(h, R, 0.25);
        if (t2) for (let i = 0; i < 2; i++) this.spawnPet(h, 'ent', 15);
        break;
      }
      case 'holy': {
        const R = d.ability.radius;
        this.healAllies(h, R, 0.35, 2.5);
        if (t2) this.heroAoe(h, R, d.ability.dmg * mul, 150, null, true);
        this.fx.push(['holy', h.x, h.y, R]);
        break;
      }
    }
  }

  startDash(h, time, speed, dmg, kb) {
    h.dashT = time;
    h.dashVx = Math.cos(h.aim) * speed;
    h.dashVy = Math.sin(h.aim) * speed;
    h.dashHit = new Set();
    h.dashDmg = dmg;
    h.dashKb = kb;
    this.fx.push(['dash', h.x, h.y, h.aim]);
  }

  // pets: beastmaster wolves and druid ents follow their owner
  spawnPet(h, type, life) {
    const def = S.ALLY_UNITS[type];
    const lv = 1 + h.client.prof.lvl * 0.04;
    const a = Math.random() * 6.28;
    const u = {
      id: newId(), kind: 'knight', type, pid: h.pid, team: h.team, bar: 0, pet: true, sub: h.sub,
      expire: life ? this.time + life : 0,
      x: h.x + Math.cos(a) * 50, y: h.y + Math.sin(a) * 50, r: def.r, speed: def.speed, cdMax: def.cd,
      hp: def.hp * lv * (h.tier === 2 ? 1.4 : 1), maxHp: def.hp * lv * (h.tier === 2 ? 1.4 : 1), dmg: def.dmg * lv * (h.tier === 2 ? 1.3 : 1),
      cd: 0, aim: a, target: null, slowT: 0, slowF: 1, kbx: 0, kby: 0, lastHurt: -99, name: h.client.prof.name,
    };
    this.units.set(u.id, u);
    this.fx.push(['blink', u.x, u.y, 0]);
    return u;
  }

  // ================================================================ tick
  tick() {
    this.time += DT;
    this.tickN++;

    // rebuild unit grid
    this.ugrid.clear();
    for (const u of this.units.values()) this.ugrid.add(u);

    this.botMgr.update();
    for (const c of this.clients) this.updateHero(c);
    for (const u of this.units.values()) {
      if (u.kind === 'mob') this.updateMob(u);
      else if (u.kind === 'boss') this.updateBoss(u);
      else if (u.kind === 'knight') this.updateKnight(u);
    }
    for (const u of this.units.values()) this.physics(u);
    this.updateProjectiles();
    this.updateBuildings();

    // world upkeep
    if (this.tickN % 15 === 0) {
      if (this.mobCount < S.MOB_CAP) this.spawnMobPack();
      this.updateSleep();
      for (let i = this.nodeRespawns.length - 1; i >= 0; i--) {
        const r = this.nodeRespawns[i];
        if (this.time >= r.at) {
          this.nodeRespawns.splice(i, 1);
          let blocked = false;
          for (const u of this.ugrid.query(r.x, r.y, 120)) if (Math.hypot(u.x - r.x, u.y - r.y) < u.r + 45) blocked = true;
          if (blocked) r.at = this.time + 5, this.nodeRespawns.push(r);
          else this.addNode(r.type, r.x, r.y);
        }
      }
      for (const camp of this.camps) {
        if (camp.respawnAt && this.time >= camp.respawnAt) {
          camp.respawnAt = 0;
          this.buildCamp(camp);
          this.feed(`${S.FACTIONS[camp.fi].name} снова обитаем`);
        }
      }
      for (const slot of this.bosses) {
        if (slot.respawnAt && this.time >= slot.respawnAt) {
          this.spawnBoss(slot.def);
          this.feed(`👁 ${slot.def.name} пробудился`, true);
        }
      }
    }

    if (this.tickN % 2 === 0) this.sendSnapshots();
    if (this.tickN % 30 === 0) this.sendInfo();
    this.fx.length = 0;
  }

  updateHero(c) {
    const h = c.hero;
    if (!h || h.dead) { c.inputs.length = 0; return; }
    let n = c.inputs.length > 3 ? 2 : 1;
    const speed = h.stats.speed * (h.slowT > 0 ? h.slowF : 1) * (h.recallT > 0 ? 0.35 : 1) *
      (h.rageT > 0 ? 1.3 : 1) * (h.bastionT > 0 ? 0.7 : 1);
    const list = this.sgrid.query(h.x, h.y, h.r + 80);
    const canPass = (s) => this.passable(s, h.team);
    while (n-- > 0 && c.inputs.length) {
      const inp = c.inputs.shift();
      if (inp.s <= c.ack) continue;
      const p = { x: h.x, y: h.y };
      S.moveHero(p, inp, speed, h.r, list, canPass);
      h.x = p.x; h.y = p.y;
      c.ack = inp.s;
      h.aim = inp.a;
      h.firing = inp.f;
      h.abil = inp.ab;
      c.lastSpeed = speed;
    }
    h.invulnT -= DT;
    if (h.firing || h.abil) h.invulnT = Math.min(h.invulnT, 0);
    h.cd -= DT;
    h.acd -= DT;
    h.slowT -= DT;
    if (h.firing && h.cd <= 0) {
      h.cd = h.stats.cd * (h.rageT > 0 ? 0.55 : 1);
      this.heroAttack(h);
    }
    if (h.abil && h.acd <= 0) this.heroAbility(h);
    this.updateHeroEffects(c, h);

    if (h.dashT > 0) {
      h.dashT -= DT;
      const src = this.srcOf(h, true);
      src.kb = h.dashKb || 260;
      for (const u of this.ugrid.query(h.x, h.y, h.r + 100)) {
        if (u === h || !this.hostile(h, u) || h.dashHit.has(u.id) || !this.targetable(u)) continue;
        if (Math.sqrt(dist2(h, u)) < h.r + u.r + 20) { h.dashHit.add(u.id); this.hurt(u, h.dashDmg, src); }
      }
      if (h.dashT <= 0 && h.dashShock) {
        h.dashShock = false;
        this.heroAoe(h, 170, h.dashDmg * 0.6, 300, 'slam', true);
      }
    }
    // regeneration
    const outOfCombat = this.time - h.lastHurt > 5;
    h.hp = Math.min(h.maxHp, h.hp + h.stats.regen * (outOfCombat ? 1 : 0.2) * DT);

    if (h.recallT > 0) {
      h.recallT -= DT;
      if (h.recallT <= 0) {
        const th = this.thOf(c.prof);
        if (th) {
          this.fx.push(['blink', h.x, h.y, 0]);
          h.x = th.x; h.y = th.y + th.hs + h.r + 4;
          this.fx.push(['blink', h.x, h.y, 0]);
        }
      }
    }
  }

  updateHeroEffects(c, h) {
    const t2 = h.tier === 2;
    for (const k of ['rageT', 'bastionT', 'shieldT', 'stealthT']) if (h[k] > 0) h[k] -= DT;
    // berserker whirlwind while raging (tier 2)
    if (h.rageT > 0 && t2) {
      h.whirlT -= DT;
      if (h.whirlT <= 0) {
        h.whirlT = 0.5;
        this.meleeSwing(h, 110, Math.PI, h.stats.dmg * 0.7, 160);
        this.fx.push(['whirl', h.x, h.y, 110]);
      }
    }
    // storm strikes
    if (h.stormN > 0) {
      h.stormT -= DT;
      if (h.stormT <= 0) {
        h.stormT = 0.16;
        h.stormN--;
        const targets = [];
        for (const u of this.ugrid.query(h.x, h.y, 620)) {
          if (u !== h && this.hostile(h, u) && this.targetable(u) && Math.sqrt(dist2(h, u)) < 520) targets.push(u);
        }
        const tg = targets.length ? pick(targets) : null;
        const a = Math.random() * 6.28, r = rand(80, 480);
        const x = tg ? tg.x : h.x + Math.cos(a) * r, y = tg ? tg.y : h.y + Math.sin(a) * r;
        const mul = h.stats.dmg / S.CLASSES.mage.dmg;
        const src = this.srcOf(h, true);
        src.x = x; src.y = y; src.kb = 80;
        for (const u of this.ugrid.query(x, y, 160)) {
          if (u === h || !this.hostile(h, u) || !this.targetable(u) || Math.hypot(u.x - x, u.y - y) > 60 + u.r) continue;
          if (t2) { u.slowT = 0.8; u.slowF = 0.15; }
          this.hurt(u, S.SUBCLASSES.storm.ability.dmg * mul, src);
        }
        for (const st of this.sgrid.query(x, y, 60)) {
          if (st.k === 'b' && st.team !== h.team && this.statics.has(st.id)) this.hurt(st, S.SUBCLASSES.storm.ability.dmg * mul * 0.5, src);
        }
        this.fx.push(['strike', x, y, 60]);
      }
    }
    if (this.tickN % 30 === h.id % 30) {
      // holy aura
      if (h.sub === 'holy') {
        for (const u of this.ugrid.query(h.x, h.y, 300)) {
          if (u.team === h.team && !u.dead && u.kind !== 'boss' && Math.sqrt(dist2(h, u)) < 250) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * (u === h ? 0.01 : 0.025));
        }
      }
      // beastmaster keeps its wolves around
      if (h.sub === 'beastmaster') {
        let n = 0;
        for (const u of this.units.values()) if (u.kind === 'knight' && u.pet && !u.expire && u.pid === h.pid) n++;
        h.petT--;
        if (n < (t2 ? 3 : 2) && h.petT <= 0) { this.spawnPet(h, 'wolf', 0); h.petT = 6; }
      }
    }
  }

  physics(u) {
    if (u.dead) return;
    let moved = false;
    if (u.kind === 'hero' && u.dashT > 0) {
      u.x += u.dashVx * DT; u.y += u.dashVy * DT; moved = true;
    }
    if (u.kbx || u.kby) {
      u.x += u.kbx * DT; u.y += u.kby * DT;
      u.kbx *= 0.8; u.kby *= 0.8;
      if (Math.abs(u.kbx) + Math.abs(u.kby) < 5) u.kbx = u.kby = 0;
      moved = true;
    }
    if (u.vx || u.vy) {
      const sp = u.slowT > 0 ? u.slowF : 1;
      u.x += u.vx * sp * DT; u.y += u.vy * sp * DT;
      if (u.slowT > 0) u.slowT -= DT;
      moved = true;
    }
    if (moved) {
      const p = { x: u.x, y: u.y };
      const canPass = (s) => this.passable(s, u.team);
      S.resolve(p, u.r, this.sgrid.query(u.x, u.y, u.r + 80), u.kind === 'boss' ? () => true : canPass);
      u.x = p.x; u.y = p.y;
    }
  }

  nearestHostile(u, range, filter) {
    let best = null, bd = range * range;
    for (const o of this.ugrid.query(u.x, u.y, range)) {
      if (o === u || o.dead || !this.hostile(u, o) || !this.targetable(o)) continue;
      if (filter && !filter(o)) continue;
      const d = dist2(u, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  steer(u, tx, ty, speed, stopDist) {
    const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
    if (d <= (stopDist || 0) || d < 1) { u.vx = u.vy = 0; return d; }
    u.vx = (dx / d) * speed;
    u.vy = (dy / d) * speed;
    return d;
  }

  // monsters far from every hero go to sleep so a huge map stays cheap to simulate
  updateSleep() {
    const heroes = [];
    for (const u of this.units.values()) if (u.kind === 'hero' && !u.dead) heroes.push(u);
    for (const u of this.units.values()) {
      if (u.kind !== 'mob') continue;
      let near = false;
      for (const h of heroes) if (Math.abs(h.x - u.x) < 2600 && Math.abs(h.y - u.y) < 2600) { near = true; break; }
      u.sleep = !near;
    }
  }

  updateMob(m) {
    if (m.sleep) { m.vx = m.vy = 0; return; }
    const d = m.def;
    m.cd -= DT;
    if (m.target && (m.target.dead || !this.units.has(m.target.id) || !this.targetable(m.target))) m.target = null;
    const homeD = Math.hypot(m.x - m.homeX, m.y - m.homeY);
    if (!m.target && this.tickN % 6 === m.id % 6) {
      m.target = this.nearestHostile(m, d.aggro, (o) => o.kind === 'hero' || o.kind === 'knight');
    }
    if (m.target && homeD > (m.owner ? 1200 : 750)) {
      m.target = null;
      m.returning = true;
    }
    if (m.returning) {
      if (this.steer(m, m.homeX, m.homeY, d.speed * 1.2, 20) < 30) m.returning = false;
      m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.2 * DT);
      return;
    }
    const t = m.target;
    if (t) {
      const dist = Math.sqrt(dist2(m, t));
      m.aim = Math.atan2(t.y - m.y, t.x - m.x);
      if (d.regen) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * d.regen * DT);
      // boar: charge in a straight line and ram
      if (d.charge) {
        m.chargeCd = (m.chargeCd || 0) - DT;
        if (m.chargeT > 0) {
          m.chargeT -= DT;
          m.vx = m.cdx; m.vy = m.cdy;
          if (!m.chargeHit && dist < m.r + t.r + 8) {
            m.chargeHit = true;
            const src = this.srcOf(m);
            src.kb = 380;
            this.hurt(t, d.charge.dmg * m.tier, src);
            m.atk = (m.atk || 0) + 1;
          }
          return;
        }
        if (dist < 380 && dist > 90 && m.chargeCd <= 0) {
          m.chargeCd = d.charge.cd; m.chargeT = d.charge.dur; m.chargeHit = false;
          m.cdx = Math.cos(m.aim) * d.charge.speed; m.cdy = Math.sin(m.aim) * d.charge.speed;
          this.fx.push(['dash', m.x, m.y, m.aim]);
          return;
        }
      }
      // yeti: lob a slowing snowball while closing in
      if (d.throw) {
        m.throwCd = (m.throwCd || rand(0, 2)) - DT;
        if (m.throwCd <= 0 && dist > 160 && dist < 600) {
          m.throwCd = d.throw.cd;
          this.shoot(m, d.throw.type, m.x, m.y, m.aim, d.throw.speed, d.throw.life, d.dmg * 0.8 * m.tier, 13, { slow: d.throw.slow });
          m.atk = (m.atk || 0) + 1;
        }
      }
      if (d.ranged) {
        if (dist > d.keep + 40) this.steer(m, t.x, t.y, d.speed);
        else if (dist < d.keep - 80) this.steer(m, m.x * 2 - t.x, m.y * 2 - t.y, d.speed * 0.8);
        else { m.vx *= 0.8; m.vy *= 0.8; }
        if (dist < d.keep + 200 && m.cd <= 0) {
          m.cd = d.cd;
          this.shoot(m, d.ranged.type, m.x, m.y, m.aim + rand(-0.05, 0.05), d.ranged.speed, d.ranged.life, d.dmg * m.tier, 8, d.ranged.slow ? { slow: d.ranged.slow } : null);
        }
      } else {
        this.steer(m, t.x, t.y, d.speed, m.r + t.r - 2);
        if (dist < m.r + t.r + 12 && m.cd <= 0) {
          m.cd = d.cd;
          const src = this.srcOf(m);
          src.kb = 90;
          this.hurt(t, d.dmg * m.tier, src);
          m.atk = (m.atk || 0) + 1;
        }
      }
    } else {
      m.wanderT -= DT;
      if (m.wanderT <= 0) {
        m.wanderT = rand(2, 5);
        m.wx = m.homeX + rand(-220, 220);
        m.wy = m.homeY + rand(-220, 220);
      }
      this.steer(m, m.wx, m.wy, d.speed * 0.35, 10);
      if (m.vx || m.vy) m.aim = Math.atan2(m.vy, m.vx);
      if (this.time - m.lastHurt > 6) m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.05 * DT);
    }
  }

  updateKnight(k) {
    k.cd -= DT;
    const bar = k.bar ? this.statics.get(k.bar) : null;
    let anchor, leash, seek;
    if (k.pet) {
      const owner = this.units.get(k.pid);
      if (!owner || owner.kind !== 'hero' || owner.dead || owner.sub !== k.sub || (k.expire && this.time > k.expire)) {
        this.units.delete(k.id); this.fx.push(['death', k.x, k.y, 5]); return;
      }
      anchor = owner; leash = 480; seek = 360;
    } else {
      if (!bar) { this.units.delete(k.id); this.fx.push(['death', k.x, k.y, 5]); return; }
      if (k.merc) {
        // mercenaries roam: they hunt the nearest enemy anywhere near their camp
        anchor = bar; leash = 1500; seek = 1300;
      } else {
        const ownerHero = this.units.get(k.pid);
        anchor = ownerHero && ownerHero.kind === 'hero' && !ownerHero.dead ? ownerHero : bar;
        leash = anchor === bar ? 450 : 520; seek = 380;
      }
    }
    const anchorD = Math.hypot(k.x - anchor.x, k.y - anchor.y);
    if (k.target && (k.target.dead || (k.target.k === 'b' ? !this.statics.has(k.target.id) : !this.units.has(k.target.id)) || (k.target.k !== 'b' && !this.targetable(k.target)))) k.target = null;
    if (k.target && Math.hypot(k.target.x - anchor.x, k.target.y - anchor.y) > leash) k.target = null;
    if (!k.target && this.tickN % 5 === k.id % 5) {
      k.target = this.nearestHostile(k, seek, k.merc ? (o) => o.kind !== 'boss' : null);
      if (!k.target && (k.merc || anchor !== bar)) {
        // attack enemy buildings nearby
        const R = k.merc ? 900 : 330;
        let best = null, bd = R * R;
        for (const st of this.sgrid.query(k.x, k.y, R)) {
          if (st.k !== 'b' || st.team === k.team) continue;
          const dd = dist2(k, st);
          if (dd < bd) { bd = dd; best = st; }
        }
        k.target = best;
      }
    }
    const t = k.target;
    const speed = k.speed || S.KNIGHT.speed;
    if (t) {
      const tr = t.k === 'b' ? t.hs : t.r;
      const dist = Math.sqrt(dist2(k, t));
      k.aim = Math.atan2(t.y - k.y, t.x - k.x);
      this.steer(k, t.x, t.y, speed, k.r + tr - 2);
      if (dist < k.r + tr + 14 && k.cd <= 0) {
        k.cd = k.cdMax || S.KNIGHT.cd;
        k.atk = (k.atk || 0) + 1;
        const src = this.srcOf(k);
        src.kb = 70;
        this.hurt(t, k.dmg, src);
      }
    } else {
      const ang = (k.id * 1.7) % 6.28;
      const rr = anchor === bar ? (k.merc ? 160 : 110) : 70;
      const tx = anchor.x + Math.cos(ang) * rr;
      const ty = anchor.y + Math.sin(ang) * rr;
      this.steer(k, tx, ty, speed * (anchorD > 200 ? 1.15 : 0.8), 12);
      if (k.vx || k.vy) k.aim = Math.atan2(k.vy, k.vx);
    }
    if (this.time - k.lastHurt > 5) k.hp = Math.min(k.maxHp, k.hp + k.maxHp * 0.04 * DT);
  }

  bossSummon(b, type, n) {
    b.atkN = (b.atkN || 0) + 1;
    for (let i = 0; i < n && b.summons < 8; i++) {
      const a = rand(0, 6.28);
      const m = this.spawnMob(type, b.x + Math.cos(a) * (b.r + 40), b.y + Math.sin(a) * (b.r + 40), S.BIOME_TIER[b.def.biome], b.id);
      m.homeX = b.homeX; m.homeY = b.homeY;
      m.target = b.target;
      b.summons++;
    }
  }

  ring(b, type, n, speed, dmg, r, off, life) {
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2;
      this.shoot(b, type, b.x + Math.cos(a) * b.r * 0.8, b.y + Math.sin(a) * b.r * 0.8, a, speed, life || 2.2, dmg, r);
    }
  }

  updateBoss(b) {
    b.t += DT;
    b.pt -= DT;
    if (b.target && (b.target.dead || !this.units.has(b.target.id) || !this.targetable(b.target) ||
      Math.hypot(b.target.x - b.homeX, b.target.y - b.homeY) > 1100)) b.target = null;
    if (!b.target && this.tickN % 10 === 0) {
      const t = this.nearestHostile(b, 700, (o) => o.kind === 'hero' || o.kind === 'knight');
      if (t && Math.hypot(t.x - b.homeX, t.y - b.homeY) < 1000) b.target = t;
    }
    const t = b.target;
    const homeD = Math.hypot(b.x - b.homeX, b.y - b.homeY);
    if (!t) {
      this.steer(b, b.homeX, b.homeY, 120, 10);
      if (this.time - b.lastHurt > 4) {
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.05 * DT);
        if (b.hp >= b.maxHp) b.dmgBy.clear();
      }
      return;
    }
    const dist = Math.sqrt(dist2(b, t));
    const aim = Math.atan2(t.y - b.y, t.x - b.x);
    b.aim = aim;
    const enraged = b.hp < b.maxHp * 0.4;
    const k = b.def.key;
    const cdm = enraged ? 0.7 : 1;
    if (homeD > 650) this.steer(b, b.homeX, b.homeY, 100);
    if (k === 'treant') {
      this.steer(b, t.x, t.y, 70, b.r + t.r + 10);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 3;
        if (b.phase === 0) { this.ring(b, 'seed', 18, 260, 17, 12, rand(0, 1), 2.6); b.pt = 2.2 * cdm; }
        else if (b.phase === 1) { this.bossSummon(b, 'wolf', 3); b.pt = 1.2; }
        else { for (let i = -2; i <= 2; i++) this.shoot(b, 'seed', b.x, b.y, aim + i * 0.18, 380, 2, 20, 13); b.pt = 1.6 * cdm; }
      }
      if (dist < b.r + t.r + 40 && (b.slamT || 0) < this.time) {
        b.slamT = this.time + 2.2;
        this.aoe(b, 170, 38, 320);
      }
    } else if (k === 'lich') {
      this.steer(b, t.x, t.y, 60, 320);
      if (b.phase === 0) {
        // spiral
        if (this.tickN % 3 === 0) {
          const a = b.t * 2.6;
          for (let i = 0; i < (enraged ? 4 : 3); i++) this.shoot(b, 'bolt', b.x, b.y, a + (i * Math.PI * 2) / (enraged ? 4 : 3), 330, 2.8, 14, 11);
        }
        if (b.pt <= 0) { b.phase = 1; b.pt = 1.4; }
      } else if (b.phase === 1) {
        if (b.pt <= 0) {
          for (let i = -3; i <= 3; i++) this.shoot(b, 'bolt', b.x, b.y, aim + i * 0.12, 460, 2, 17, 12);
          if (b.summons < 5) this.bossSummon(b, 'skeleton', 3);
          // blink
          this.fx.push(['blink', b.x, b.y, 0]);
          const a = rand(0, 6.28);
          b.x = b.homeX + Math.cos(a) * rand(100, 380);
          b.y = b.homeY + Math.sin(a) * rand(100, 380);
          this.fx.push(['blink', b.x, b.y, 0]);
          b.phase = 0; b.pt = 3.2 * cdm;
        }
      }
    } else if (k === 'hydra') {
      this.steer(b, t.x, t.y, 55, 260);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 4;
        if (b.phase < 3) {
          for (let h = -1; h <= 1; h++) {
            const hx = b.x + Math.cos(aim + h * 0.9) * b.r * 0.7, hy = b.y + Math.sin(aim + h * 0.9) * b.r * 0.7;
            const a2 = Math.atan2(t.y - hy, t.x - hx);
            for (let i = -1; i <= 1; i++) this.shoot(b, 'poison', hx, hy, a2 + i * 0.14, 470, 1.8, 12, 10, { slow: 0.7 });
          }
          b.pt = 0.9 * cdm;
        } else {
          this.ring(b, 'poison', 24, 300, 14, 11, rand(0, 1), 2.5);
          if (b.summons < 4) this.bossSummon(b, 'slime', 2);
          b.pt = 1.6;
        }
      }
    } else if (k === 'colossus') {
      this.steer(b, t.x, t.y, 60, b.r + t.r);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 3;
        if (b.phase === 0) {
          this.aoe(b, 200, 34, 380);
          this.ring(b, 'shock', 28, 360, 18, 13, 0, 1.8);
          b.pt = 1.8 * cdm;
        } else {
          this.shoot(b, 'rock', b.x, b.y, aim, 430, 2.4, 44, 24, { splash: 90 });
          if (enraged) { this.shoot(b, 'rock', b.x, b.y, aim + 0.35, 430, 2.4, 44, 24, { splash: 90 }); this.shoot(b, 'rock', b.x, b.y, aim - 0.35, 430, 2.4, 44, 24, { splash: 90 }); }
          b.pt = 1.3 * cdm;
        }
      }
    } else if (k === 'spiderqueen' || k === 'frostgiant' || k === 'minotaur') {
      this.updateNewBoss(b, k, t, aim, dist, enraged, cdm);
    } else if (k === 'dragon') {
      if (b.dashT > 0) {
        b.dashT -= DT;
        b.vx = b.dvx; b.vy = b.dvy;
        for (const u of this.ugrid.query(b.x, b.y, b.r + 60)) {
          if (u.team !== b.team && this.targetable(u) && Math.sqrt(dist2(u, b)) < u.r + b.r ) {
            const src = this.srcOf(b);
            src.kb = 500;
            if ((u._dragonHit || 0) < this.time) { u._dragonHit = this.time + 0.6; this.hurt(u, 45, src); }
          }
        }
        return;
      }
      this.steer(b, t.x, t.y, 90, 240);
      if (b.phase === 1) {
        // fire breath
        if (this.tickN % 2 === 0) {
          for (let i = 0; i < 2; i++) this.shoot(b, 'flame', b.x + Math.cos(b.aim) * b.r, b.y + Math.sin(b.aim) * b.r, b.aim + rand(-0.35, 0.35), rand(420, 560), 1.0, 7, 14);
        }
        if (b.pt <= 0) { b.phase = 2; b.pt = 1.2; }
      } else if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 4;
        if (b.phase === 1) b.pt = 1.8;
        else if (b.phase === 2) { for (let i = -2; i <= 2; i++) this.shoot(b, 'fireball', b.x, b.y, aim + i * 0.22, 520, 1.8, 24, 16, { splash: 80 }); b.pt = 1.1 * cdm; }
        else if (b.phase === 3) { b.dashT = 0.55; b.dvx = Math.cos(aim) * 900; b.dvy = Math.sin(aim) * 900; this.fx.push(['dash', b.x, b.y, aim]); b.pt = 1.4 * cdm; }
        else { this.ring(b, 'fireball', 16, 330, 18, 14, rand(0, 1), 2); if (b.summons < 4) this.bossSummon(b, 'imp', 2); b.pt = 1.3 * cdm; }
      }
    }
  }

  // shared boss dash: ram everything in the way; returns true while dashing
  bossDash(b, dmg, kb) {
    if (!(b.dashT > 0)) return false;
    b.dashT -= DT;
    b.vx = b.dvx; b.vy = b.dvy;
    for (const u of this.ugrid.query(b.x, b.y, b.r + 60)) {
      if (u.team !== b.team && this.targetable(u) && Math.sqrt(dist2(u, b)) < u.r + b.r) {
        const src = this.srcOf(b);
        src.kb = kb;
        if ((u._dashHit || 0) < this.time) { u._dashHit = this.time + 0.6; this.hurt(u, dmg, src); }
      }
    }
    if (b.dashT <= 0 && b.dashLand) { const [R, d2, k2] = b.dashLand; b.dashLand = null; this.aoe(b, R, d2, k2); }
    return true;
  }

  updateNewBoss(b, k, t, aim, dist, enraged, cdm) {
    if (k === 'spiderqueen') {
      if (this.bossDash(b, 30, 300)) return;
      this.steer(b, t.x, t.y, 95, 200);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 4;
        if (b.phase === 0) { for (let i = -3; i <= 3; i++) this.shoot(b, 'web', b.x, b.y, aim + i * 0.15, 440, 1.6, 14, 12, { slow: 0.45 }); b.pt = 1.2 * cdm; }
        else if (b.phase === 1) { if (b.summons < 6) this.bossSummon(b, 'spider', 3); b.pt = 1.0; }
        else if (b.phase === 2) { this.ring(b, 'poison', 20, 300, 14, 11, rand(0, 1), 2.4); b.pt = 1.3 * cdm; }
        else { b.dashT = 0.4; b.dvx = Math.cos(aim) * 820; b.dvy = Math.sin(aim) * 820; b.dashLand = [160, 30, 300]; this.fx.push(['dash', b.x, b.y, aim]); b.pt = 1.4 * cdm; }
      }
    } else if (k === 'frostgiant') {
      this.steer(b, t.x, t.y, 70, b.r + t.r);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 3;
        if (b.phase === 0) {
          const n = enraged ? 1 : 0;
          for (let i = -n; i <= n; i++) this.shoot(b, 'iceboulder', b.x, b.y, aim + i * 0.3, 400, 2.4, 42, 26, { splash: 100, slow: 0.4 });
          b.pt = 1.6 * cdm;
        } else if (b.phase === 1) { this.ring(b, 'shard', 26, 340, 16, 11, rand(0, 1), 2); b.pt = 1.3 * cdm; }
        else {
          this.aoe(b, 220, 32, 380);
          for (const u of this.ugrid.query(b.x, b.y, 320)) if (u.team !== b.team && Math.sqrt(dist2(u, b)) < 280) { u.slowT = 2; u.slowF = 0.45; }
          b.pt = 1.8 * cdm;
        }
      }
    } else if (k === 'minotaur') {
      if (this.bossDash(b, 50, 520)) return;
      this.steer(b, t.x, t.y, 110, b.r + t.r);
      if (b.pt <= 0) {
        b.phase = (b.phase + 1) % 3;
        if (b.phase === 0) { b.dashT = 0.7; b.dvx = Math.cos(aim) * 950; b.dvy = Math.sin(aim) * 950; b.dashLand = [170, 30, 350]; this.fx.push(['dash', b.x, b.y, aim]); b.pt = 1.6 * cdm; }
        else if (b.phase === 1) { this.aoe(b, 190, 38, 300); b.spinT = 0.5; b.pt = 1.2 * cdm; }
        else { this.ring(b, 'shock', 18, 380, 20, 13, 0, 1.8); if (enraged) this.ring(b, 'shock', 18, 300, 20, 13, 0.17, 1.8); b.pt = 1.4 * cdm; }
      }
      if (b.spinT > 0) { b.spinT -= DT; if (b.spinT <= 0) this.aoe(b, 190, 38, 300); }
    }
  }

  aoe(u, R, dmg, kb) {
    if (u.kind === 'boss') u.atkN = (u.atkN || 0) + 1;
    const src = this.srcOf(u);
    src.kb = kb;
    for (const o of this.ugrid.query(u.x, u.y, R + 100)) {
      if (o === u || o.team === u.team || !this.targetable(o)) continue;
      if (Math.sqrt(dist2(u, o)) < R + o.r) this.hurt(o, dmg, src);
    }
    this.fx.push(['slam', u.x, u.y, R]);
  }

  explode(p) {
    const src = { pid: p.pid, team: p.team, hero: false, x: p.x, y: p.y, unitId: p.unitId, kb: 120, name: p.name };
    for (const o of this.ugrid.query(p.x, p.y, p.splash + 100)) {
      if (o.team === p.team || !this.targetable(o)) continue;
      if (Math.sqrt(dist2(p, o)) < p.splash + o.r) {
        if (p.slow) { o.slowT = 2; o.slowF = 0.5; }
        this.hurt(o, p.dmg * 0.7, src);
      }
    }
    for (const s of this.sgrid.query(p.x, p.y, p.splash)) {
      if (s.k === 'b' && s.team !== p.team && this.statics.has(s.id)) this.hurt(s, p.dmg * 0.5, src);
    }
    if (p.holy) {
      for (const o of this.ugrid.query(p.x, p.y, p.splash + 100)) {
        if (o.team === p.team && !o.dead && o.kind !== 'boss' && Math.sqrt(dist2(p, o)) < p.splash + o.r) o.hp = Math.min(o.maxHp, o.hp + p.dmg * 0.5);
      }
    }
    this.fx.push(['boom', p.x, p.y, p.splash, p.type === 'magic' ? 1 : p.holy ? 2 : 0]);
  }

  updateProjectiles() {
    for (const p of this.projs.values()) {
      p.x += p.vx * DT;
      p.y += p.vy * DT;
      p.life -= DT;
      let dead = p.life <= 0 || p.x < 0 || p.y < 0 || p.x > S.W || p.y > S.H;
      if (!dead) {
        const src = { pid: p.pid, team: p.team, hero: p.hero, x: p.x - p.vx * 0.05, y: p.y - p.vy * 0.05, unitId: p.unitId, kb: p.kb || 40, name: p.name };
        for (const u of this.ugrid.query(p.x, p.y, p.r + 100)) {
          if (u.team === p.team || !this.targetable(u) || (p.hit && p.hit.has(u.id))) continue;
          const rr = u.r + p.r;
          if (dist2(p, u) < rr * rr) {
            if (u.kind === 'hero' && u.bastionT > 0 && u.tier === 2) {
              // bastion reflects the projectile back at its shooter
              p.vx = -p.vx; p.vy = -p.vy; p.team = u.team; p.pid = u.pid; p.hero = false; p.unitId = u.id;
              p.life = Math.max(p.life, 0.8); p.hit = null;
              this.fx.push(['hit', p.x, p.y, 0, 0]);
              break;
            }
            if (p.splash) { dead = true; break; }
            if (p.slow) { u.slowT = 1.5; u.slowF = p.slow; }
            this.hurt(u, p.dmg, src);
            if (p.pierce > 0) { p.pierce--; (p.hit || (p.hit = new Set())).add(u.id); continue; }
            dead = true;
            break;
          }
        }
        if (!dead) {
          for (const s of this.sgrid.query(p.x, p.y, p.r + 50)) {
            if (!this.statics.has(s.id)) continue;
            let hit;
            if (s.k === 'n') hit = dist2(p, s) < (s.r + p.r - 4) * (s.r + p.r - 4);
            else {
              if (s.team === p.team) continue;
              hit = Math.abs(p.x - s.x) < s.hs + p.r && Math.abs(p.y - s.y) < s.hs + p.r;
            }
            if (!hit) continue;
            if (!p.splash) this.hurt(s, p.dmg, src);
            else if (s.k === 'n' && p.hero) this.hurt(s, p.dmg, src);
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        if (p.splash) this.explode(p);
        this.projs.delete(p.id);
      }
    }
  }

  updateBuildings() {
    const everySec = this.tickN % 30 === 0;
    for (const b of this.statics.values()) {
      if (b.k !== 'b') continue;
      const def = S.BUILDINGS[b.type];
      const m = S.lvlMul(b.lvl);
      if (this.time - b.lastHurt > 8 && b.hp < b.maxHp) b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.015 * DT);
      if (b.type === 'tower' || b.type === 'magetower') {
        b.cd -= DT;
        if (b.cd <= 0) {
          const t = this.nearestHostile(b, def.range + 20 * b.lvl);
          if (t) {
            b.cd = def.rate / (1 + 0.15 * (b.lvl - 1));
            const lead = Math.sqrt(dist2(b, t)) / 900;
            const tx = t.x + (t.vx || 0) * lead * 0.5, ty = t.y + (t.vy || 0) * lead * 0.5;
            b.aim = Math.atan2(ty - b.y, tx - b.x);
            if (b.type === 'tower') this.shoot(b, 'tarrow', b.x, b.y - 10, b.aim, 900, 0.8, def.dmg * m, 7);
            else this.shoot(b, 'magic', b.x, b.y - 16, b.aim, 520, 1.1, def.dmg * m, 12, { splash: def.splash, slow: 0.5 });
          } else b.cd = 0.3;
        }
      } else if (everySec) {
        const prof = this.profiles.get(b.pid);
        if (!prof) continue;
        if (def.income) {
          for (const r in def.income) this.giveRes(prof, r, def.income[r] * m * (prof.online ? 1 : 0.5));
        } else if (b.type === 'barracks') {
          b.acc++;
          if (b.acc >= 9) {
            b.acc = 0;
            let n = 0;
            for (const u of this.units.values()) if (u.kind === 'knight' && u.bar === b.id) n++;
            if (n < 1 + b.lvl) this.spawnKnight(b);
          }
        } else if (b.type === 'npc_hall') {
          b.acc++;
          if (b.acc >= 12) {
            b.acc = 0;
            let n = 0;
            for (const u of this.units.values()) if (u.kind === 'knight' && u.bar === b.id) n++;
            if (n < S.FACTIONS[b.faction].guards) this.spawnKnight(b, 'merc');
          }
        } else if (b.type === 'warcamp') {
          b.acc++;
          if (b.acc >= 10) {
            b.acc = 0;
            let n = 0;
            for (const u of this.units.values()) if (u.kind === 'knight' && u.bar === b.id) n++;
            if (n < 2 + b.lvl) this.spawnKnight(b, 'merc');
          }
        } else if (b.type === 'shrine') {
          const heal = def.heal * m;
          for (const u of this.ugrid.query(b.x, b.y, def.range)) {
            if (u.team === b.team && !u.dead && Math.hypot(u.x - b.x, u.y - b.y) < def.range) u.hp = Math.min(u.maxHp, u.hp + heal);
          }
          for (const s of this.sgrid.query(b.x, b.y, def.range)) {
            if (s.k === 'b' && s.team === b.team && s !== b) s.hp = Math.min(s.maxHp, s.hp + heal * 1.5);
          }
        }
      }
    }
  }

  // ================================================================ network
  feed(m, big) { this.broadcast({ t: 'feed', m, big: !!big }); }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) c.sendRaw(s);
  }

  relOf(team, e, pid) {
    if (e.team === 'mob') return 3;
    if (e.pid === pid && e.pid) return 0;
    return e.team === team ? 1 : 2;
  }

  sendSnapshots() {
    const sendStatics = this.tickN % 6 === 0;
    const tm = Math.round(this.time * 1000);
    for (const c of this.clients) {
      if (c.bot) continue;
      const prof = c.prof;
      const h = c.hero;
      const team = this.teamOf(prof);
      const cx = h ? h.x : S.SPAWN.x, cy = h ? h.y : S.SPAWN.y;
      const vw = (c.vw || 1000) + 200, vh = (c.vh || 650) + 200;
      const inView = (x, y, pad) => Math.abs(x - cx) < vw + pad && Math.abs(y - cy) < vh + pad;
      const u = [];
      for (const e of this.units.values()) {
        if (e.dead || !inView(e.x, e.y, e.r)) continue;
        if (e.stealthT > 0 && e.team !== team) continue;
        const row = [e.id, e.kind === 'hero' ? 'h' : e.kind === 'boss' ? 'B' : e.kind === 'knight' ? 'k' : 'm', e.type,
          Math.round(e.x), Math.round(e.y), Math.round(e.aim * 100) / 100, Math.round((e.hp / e.maxHp) * 100), this.relOf(team, e, prof.pid)];
        if (e.kind === 'hero') {
          row.push(e.atkN, e.invulnT > 0 ? 1 : 0, e.slowT > 0 ? 1 : 0, e.recallT > 0 ? 1 : 0, e.dashT > 0 ? 1 : 0, e.tier,
            (e.stealthT > 0 ? 1 : 0) | (e.bastionT > 0 ? 2 : 0) | (e.shieldT > 0 ? 4 : 0) | (e.rageT > 0 ? 8 : 0));
        }
        else if (e.kind === 'boss') row.push(e.hp < e.maxHp * 0.4 ? 1 : 0, Math.round(e.hp), e.maxHp, e.atkN || 0);
        else row.push(e.atk || 0, e.slowT > 0 ? 1 : 0, e.pid || 0, e.tier || 1);
        u.push(row);
      }
      const pr = [];
      for (const p of this.projs.values()) {
        if (!inView(p.x, p.y, 50)) continue;
        pr.push([p.id, p.type, Math.round(p.x), Math.round(p.y), Math.round(Math.atan2(p.vy, p.vx) * 100) / 100, p.team === team ? 1 : 0]);
      }
      const fx = [];
      for (const f of this.fx) if (inView(f[1], f[2], 300)) fx.push(f);
      const th = this.thOf(prof);
      const msg = {
        t: 's', tm, u, p: pr, fx,
        me: h ? {
          x: Math.round(h.x * 100) / 100, y: Math.round(h.y * 100) / 100, ack: c.ack, hp: Math.round(h.hp), mhp: h.maxHp,
          spd: c.lastSpeed || h.stats.speed, cd: Math.max(0, h.acd), cdm: S.abilityCd(h.cls, h.sub, prof.lvl), dead: h.dead ? 1 : 0,
          rc: h.recallT > 0 ? h.recallT : 0,
        } : null,
        pf: {
          lvl: prof.lvl, xp: Math.floor(prof.xp), xpn: S.xpFor(prof.lvl), pts: prof.pts, st: prof.st, cls: prof.cls, sub: prof.sub || 0,
          res: [Math.floor(prof.res.wood), Math.floor(prof.res.stone), Math.floor(prof.res.gold)], cap: S.resCap(th ? th.lvl : 0),
          glory: prof.glory, thLvl: prof.thLvl, th: th ? [th.x, th.y, th.lvl, th.id] : 0,
        },
      };
      if (c.events.length) { msg.ev = c.events; c.events = []; }
      if (sendStatics) {
        const st = [];
        for (const s of this.sgrid.query(cx, cy, Math.max(vw, vh) + 200)) {
          if (!inView(s.x, s.y, s.k === 'b' ? s.hs : s.r)) continue;
          if (s.k === 'n') st.push([s.id, 'n', s.type, Math.round(s.x), Math.round(s.y), Math.round(s.r), Math.round((s.hp / s.maxHp) * 100), s.biome, s.v]);
          else st.push([s.id, 'b', s.type, s.x, s.y, s.lvl, Math.round((s.hp / s.maxHp) * 100), this.relOf(team, s, prof.pid), s.pid, Math.round(s.aim * 100) / 100, s.faction === undefined ? -1 : s.faction]);
        }
        msg.st = st;
        const counts = {};
        for (const s of this.statics.values()) if (s.k === 'b' && s.pid === prof.pid) counts[s.type] = (counts[s.type] || 0) + 1;
        msg.pf.counts = counts;
      }
      c.send(msg);
    }
  }

  sendInfo() {
    const names = {};
    const heroes = [];
    for (const c of this.clients) {
      const p = c.prof;
      names[p.pid] = [p.name, p.clan, p.lvl, p.cls, p.sub || 0];
    }
    // include owners of buildings (maybe offline) so their bases are labelled
    const ths = [];
    for (const s of this.statics.values()) {
      if (s.k === 'b' && s.type === 'townhall') {
        const p = this.profiles.get(s.pid);
        if (p) { names[p.pid] = names[p.pid] || [p.name, p.clan, p.lvl, p.cls]; ths.push([s.pid, s.x, s.y, s.team, p.online ? 1 : 0, s.lvl]); }
      }
    }
    for (const c of this.clients) if (c.hero && !c.hero.dead) heroes.push([c.pid, Math.round(c.hero.x), Math.round(c.hero.y), c.hero.team]);
    const lb = [...this.profiles.values()].sort((a, b) => b.glory - a.glory).slice(0, 10)
      .map((p) => [p.name, p.clan, p.lvl, p.glory, p.online ? 1 : 0, p.pid]);
    const bosses = this.bosses.map((s) => [S.BOSSES.indexOf(s.def), s.unit && !s.unit.dead ? 1 : 0, s.respawnAt ? Math.max(0, Math.round(s.respawnAt - this.time)) : 0,
      s.unit && !s.unit.dead ? Math.round((s.unit.hp / s.unit.maxHp) * 100) : 0]);
    let bots = 0;
    for (const c of this.clients) if (c.bot) bots++;
    for (const c of this.clients) {
      if (c.bot) continue;
      const team = this.teamOf(c.prof);
      c.send({
        t: 'info', names, lb, bosses, online: this.clients.size - bots, bots,
        camps: this.camps.map((cp) => [cp.x, cp.y, cp.respawnAt ? 0 : 1, cp.fi]),
        ths: ths.map((t) => [t[0], t[1], t[2], t[0] === c.pid ? 0 : t[3] === team ? 1 : 2, t[4], t[5]]),
        allies: heroes.filter((h) => h[3] === team && h[0] !== c.pid).map((h) => [h[1], h[2]]),
      });
    }
  }
}

module.exports = Game;
