// Server-side bot heroes so the world never feels empty. Bots are regular players driven by
// a small state machine: they farm, hunt monsters, build a base, evolve, fight and chat.
const S = require('../public/shared.js');

const NAMES = ['Торин', 'Эльвира', 'Гримбольд', 'Мирель', 'Ульфрик', 'Ярослава', 'Бран', 'Ильдар', 'Сигрун', 'Фенрик',
  'Озрик', 'Лиадрин', 'Кассиан', 'Руна', 'Вейл', 'Морвен', 'Горм', 'Эйра', 'Бьорн', 'Селена', 'Дарнак', 'Ивейн'];
const CLANS = ['', '', '', 'ОРДА', 'ТЬМА', 'ОРДА', 'ЛЕС'];
const CHAT_IDLE = ['кто на дракона?', 'лес тут богатый', 'эх, золота бы', 'моя крепость растёт', 'кто в клан?',
  'видел лича на севере', 'ну и волки тут', 'гг', 'осторожно, гидра рядом с болотом', 'иду рубить лес'];
const CHAT_KILL = ['лёгкая победа', 'gg', 'ещё увидимся', 'ха!', 'не лезь на мою землю'];
const CHAT_DIE = ['ну погоди!', 'gg', 'это был лаг', 'ещё вернусь', 'нечестно!'];
const STAT_W = { warrior: [3, 2, 3, 2, 1, 1], ranger: [3, 3, 1, 1, 2, 1], mage: [3, 2, 2, 2, 1, 1] };
const BUILD_PLAN = ['sawmill', 'farmhouse', 'tower', 'quarry', 'mine', 'tower', 'barracks', 'shrine', 'warcamp', 'magetower', 'tower', 'sawmill', 'quarry'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[(Math.random() * a.length) | 0];
const DT = S.DT;

class Bot {
  constructor(game, client) {
    this.game = game;
    this.c = client;
    this.seq = 0;
    this.think = 0;
    this.goal = null;
    this.target = null;
    this.mode = 'farm';
    this.site = null;
    this.stuckCheck = 0;
    this.lastPos = null;
    this.jitter = null;
    this.chatT = rand(60, 240);
    this.aggro = rand(0.15, 0.85);
    this.kills = client.prof.kills;
    this.wasDead = false;
    this.respawnAt = 0;
  }

  say(m) { this.game.onMessage(this.c, { t: 'chat', m }); }

  update() {
    const g = this.game, c = this.c, h = c.hero, prof = c.prof;
    c.events.length = 0;
    if (!h || h.dead) {
      if (!this.wasDead) {
        this.wasDead = true;
        this.respawnAt = g.time + rand(3.5, 7);
        if (c.deadInfo && Math.random() < 0.35) this.say(pick(CHAT_DIE));
      }
      if (g.time > this.respawnAt) g.onMessage(c, { t: 'respawn', cls: prof.cls });
      return;
    }
    this.wasDead = false;
    if (prof.kills > this.kills) { this.kills = prof.kills; if (Math.random() < 0.4) this.say(pick(CHAT_KILL)); }
    this.chatT -= DT;
    if (this.chatT <= 0) { this.chatT = rand(150, 420); this.say(pick(CHAT_IDLE)); }
    if (prof.pts > 0 && Math.random() < 0.05) this.spendPoint();
    if (prof.lvl >= S.EVOLVE_LVL && !prof.sub) {
      const opts = Object.keys(S.SUBCLASSES).filter((k) => S.SUBCLASSES[k].base === prof.cls);
      g.onMessage(c, { t: 'evolve', sub: pick(opts) });
    }
    this.think -= DT;
    if (this.think <= 0) { this.think = rand(0.3, 0.6); this.decide(); }
    this.drive();
  }

  spendPoint() {
    const prof = this.c.prof;
    const w = STAT_W[prof.cls].map((v, i) => (prof.st[i] >= S.STAT_MAX ? 0 : v));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) { this.game.onMessage(this.c, { t: 'stat', i }); return; } }
  }

  alive(t) {
    const g = this.game;
    if (!t) return false;
    if (t.k) return g.statics.has(t.id);
    return g.units.has(t.id) && !t.dead && g.targetable(t);
  }

  decide() {
    const g = this.game, h = this.c.hero, prof = this.c.prof;
    const th = g.thOf(prof);
    const hpk = h.hp / h.maxHp;
    // flee when hurt
    if (hpk < 0.3) {
      this.mode = 'flee';
      this.target = null;
      if (th && h.recallT <= 0 && Math.random() < 0.5) g.onMessage(this.c, { t: 'recall' });
      this.goal = th ? { x: th.x, y: th.y + th.hs + 40 } : { x: S.SPAWN.x, y: S.SPAWN.y };
      return;
    }
    if (this.target && !this.alive(this.target)) this.target = null;
    // threats & opportunities around
    let enemy = null, ed = 520 * 520, mob = null, md = 380 * 380;
    for (const u of g.ugrid.query(h.x, h.y, 560)) {
      if (u === h || !g.hostile(h, u) || !g.targetable(u)) continue;
      const d = (u.x - h.x) ** 2 + (u.y - h.y) ** 2;
      if ((u.kind === 'hero' || u.kind === 'knight') && d < ed) { ed = d; enemy = u; }
      else if (u.kind === 'mob' && d < md && (!u.def.peaceful || this.c.prof.res.food < 150)) { md = d; mob = u; }
    }
    if (enemy && (hpk > 0.55 && Math.random() < this.aggro + 0.2)) { this.mode = 'fight'; this.target = enemy; return; }
    if (mob && (!this.target || this.target.k)) { this.mode = 'fight'; this.target = mob; return; }
    if (this.target && this.mode === 'fight') return;

    // base building
    if (!th) {
      if (!this.site || Math.random() < 0.02) this.site = this.pickSite();
      if (this.site) {
        this.mode = 'build';
        this.goal = this.site;
        if (Math.hypot(h.x - this.site.x, h.y - this.site.y) < 180) {
          g.tryBuild(this.c, 'townhall', this.site.x, this.site.y);
          if (!g.thOf(prof)) this.site = null;
        }
        return;
      }
    } else if (Math.hypot(h.x - th.x, h.y - th.y) < 700 && Math.random() < 0.5) {
      if (this.tryDevelop(th)) return;
    }
    // occasional raid on an enemy base
    if (th && prof.lvl >= 8 && this.mode !== 'raid' && Math.random() < 0.004 * this.aggro) {
      let best = null, bd = 3500 * 3500;
      for (const s of g.statics.values()) {
        if (s.k !== 'b' || (s.type !== 'townhall' && s.type !== 'npc_hall') || s.team === h.team) continue;
        const d = (s.x - h.x) ** 2 + (s.y - h.y) ** 2;
        if (d < bd) { bd = d; best = s; }
      }
      if (best) { this.mode = 'raid'; this.target = best; this.say(pick(['иду в набег!', 'пора навестить соседей', 'за золотом!'])); return; }
    }
    if (this.mode === 'raid' && this.target) return;

    // farm resources near home (or wherever we are)
    const center = th || h;
    const want = this.neededRes();
    let node = null, nd = Infinity;
    for (const s of g.sgrid.query(center.x, center.y, 900)) {
      if (s.k !== 'n' || !g.statics.has(s.id)) continue;
      const d = Math.hypot(s.x - h.x, s.y - h.y) * (s.type === want ? 0.6 : 1);
      if (d < nd) { nd = d; node = s; }
    }
    if (node) { this.mode = 'farm'; this.target = node; return; }
    this.mode = 'wander';
    this.target = null;
    if (!this.goal || Math.hypot(h.x - this.goal.x, h.y - this.goal.y) < 60) {
      const a = Math.random() * 6.28, r = rand(200, 700);
      this.goal = { x: Math.max(200, Math.min(S.W - 200, center.x + Math.cos(a) * r)), y: Math.max(200, Math.min(S.H - 200, center.y + Math.sin(a) * r)) };
    }
  }

  neededRes() {
    const r = this.c.prof.res;
    return r.wood <= r.stone && r.wood <= r.gold * 1.5 ? 'tree' : r.stone <= r.gold * 1.5 ? 'rock' : 'gold';
  }

  pickSite() {
    const g = this.game, prof = this.c.prof;
    prof.team = g.teamOf(prof);
    for (let i = 0; i < 25; i++) {
      const a = Math.random() * 6.28, d = rand(1300, 3300);
      const x = S.snap('townhall', S.SPAWN.x + Math.cos(a) * d), y = S.snap('townhall', S.SPAWN.y + Math.sin(a) * d);
      if (x < 500 || y < 500 || x > S.W - 500 || y > S.H - 500) continue;
      const b = S.biomeAt(x, y);
      if (b === S.B.VOLCANO || b === S.B.SNOW) continue;
      if (!g.placementError(prof, 'townhall', x, y)) return { x, y };
    }
    return null;
  }

  tryDevelop(th) {
    const g = this.game, prof = this.c.prof;
    const res = prof.res;
    if (th.lvl < 4 && S.canAfford(res, S.thUpgradeCost(th.lvl + 1)) && Math.random() < 0.3) { g.tryUpgrade(this.c, th.id); return false; }
    const counts = {};
    for (const s of g.statics.values()) if (s.k === 'b' && s.pid === prof.pid) counts[s.type] = (counts[s.type] || 0) + 1;
    const seen = {};
    for (const type of BUILD_PLAN) {
      seen[type] = (seen[type] || 0) + 1;
      if ((counts[type] || 0) >= seen[type]) continue;
      if (S.CAPS[type][th.lvl - 1] <= (counts[type] || 0)) continue;
      if (!S.canAfford(res, S.BUILDINGS[type].cost)) return false;
      const R = S.thRadius(th.lvl);
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * 6.28, d = rand(130, R - 70);
        const x = S.snap(type, th.x + Math.cos(a) * d), y = S.snap(type, th.y + Math.sin(a) * d);
        if (!g.placementError(prof, type, x, y)) { g.tryBuild(this.c, type, x, y); return true; }
      }
      return false;
    }
    // upgrade something with spare resources
    if (Math.random() < 0.2) {
      for (const s of g.statics.values()) {
        if (s.k === 'b' && s.pid === prof.pid && s.type !== 'wall' && s.type !== 'townhall' && s.lvl < Math.min(S.BLD_MAX, th.lvl) &&
          S.canAfford(res, S.bldUpgradeCost(s.type, s.lvl + 1))) { g.tryUpgrade(this.c, s.id); return true; }
      }
    }
    return false;
  }

  drive() {
    const g = this.game, h = this.c.hero;
    let gx, gy, fire = false, ab = false, keep = 0;
    const t = this.target;
    const ranged = h.cls !== 'warrior';
    const reach = h.cls === 'warrior' ? (h.sub === 'cavalier' ? 110 : 70) : h.sub === 'storm' ? 380 : h.sub === 'sniper' ? 650 : 360;
    let aimAt = null;
    if (t && this.alive(t)) {
      const tr = t.k === 'b' ? t.hs : t.r;
      const d = Math.hypot(t.x - h.x, t.y - h.y) - tr;
      aimAt = t;
      gx = t.x; gy = t.y;
      if (t.k === 'n') keep = ranged ? 150 : h.r + 6;
      else keep = ranged ? reach * 0.7 : h.r + 4;
      if (d < reach) fire = true;
      if (!t.k && d < 320 && h.acd <= 0 && Math.random() < 0.08) ab = true;
      if (h.sub === 'holy' && h.hp < h.maxHp * 0.6 && h.acd <= 0) ab = true;
      if (h.sub === 'guardian' && h.hp < h.maxHp * 0.5 && h.acd <= 0) ab = true;
      if (h.sub === 'beastmaster' && !t.k && h.acd <= 0) ab = true;
    } else if (this.goal) {
      gx = this.goal.x; gy = this.goal.y;
    }
    let mx = 0, my = 0;
    if (gx !== undefined) {
      const dx = gx - h.x, dy = gy - h.y, d = Math.hypot(dx, dy);
      if (d > keep + 8) { mx = dx / d; my = dy / d; }
      else if (ranged && aimAt && !aimAt.k && d < keep * 0.6) { mx = -dx / d; my = -dy / d; }
      if (this.mode === 'flee' && aimAt) { mx = -mx; my = -my; }
    }
    // unstick: if we have not moved for a while, sidestep
    this.stuckCheck -= DT;
    if (this.stuckCheck <= 0) {
      this.stuckCheck = 1;
      if (this.lastPos && (mx || my) && Math.hypot(h.x - this.lastPos.x, h.y - this.lastPos.y) < 25) {
        const a = Math.atan2(my, mx) + (Math.random() < 0.5 ? 1.6 : -1.6);
        this.jitter = { x: Math.cos(a), y: Math.sin(a), t: 0.8 };
        if (this.target && this.target.k === 'n' && Math.random() < 0.5) this.target = null;
      }
      this.lastPos = { x: h.x, y: h.y };
    }
    if (this.jitter) {
      this.jitter.t -= DT;
      mx = this.jitter.x; my = this.jitter.y;
      if (this.jitter.t <= 0) this.jitter = null;
    }
    const aim = aimAt ? Math.atan2(aimAt.y - h.y, aimAt.x - h.x) + rand(-0.06, 0.06) : Math.atan2(my || 0.01, mx || 0.01);
    this.c.inputs.push({ s: ++this.seq, mx: Math.round(mx * 100) / 100, my: Math.round(my * 100) / 100, a: aim, f: fire, ab });
    if (this.c.inputs.length > 3) this.c.inputs.splice(0, this.c.inputs.length - 2);
  }
}

class BotManager {
  constructor(game, count) {
    this.game = game;
    this.count = count;
    this.bots = [];
  }

  start() {
    const g = this.game;
    const existing = [...g.profiles.values()].filter((p) => p.bot);
    for (let i = 0; i < this.count; i++) {
      const prof = existing[i];
      const client = {
        ws: null, bot: true, events: [], inputs: [],
        sendRaw() {}, send() {},
      };
      const name = prof ? prof.name : NAMES[(i * 7 + Math.floor(Math.random() * NAMES.length)) % NAMES.length] + (i >= NAMES.length ? i : '');
      const cls = prof ? prof.cls : pick(['warrior', 'ranger', 'mage']);
      g.onMessage(client, { t: 'join', token: prof ? prof.token : null, name, clan: prof ? prof.clan : pick(CLANS), cls, quiet: true });
      client.prof.bot = true;
      this.bots.push(new Bot(g, client));
    }
  }

  update() { for (const b of this.bots) b.update(); }
}

module.exports = { BotManager };
