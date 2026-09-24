// Headless smoke test: bots join, farm, build, fight bosses and raid each other.
const assert = require('assert');
const Game = require('../server/game');
const S = require('../public/shared.js');

const game = new Game({ camps: 0 });
game.init(null);

function bot(name, clan, cls) {
  const c = {
    ws: null, sent: [],
    sendRaw(s) { this.sent.push(s); if (this.sent.length > 50) this.sent.shift(); },
    send(o) { this.sendRaw(JSON.stringify(o)); },
  };
  game.onMessage(c, { t: 'join', name, clan, cls });
  return c;
}

const a = bot('Артур', 'KNG', 'warrior');
const b = bot('Robin', '', 'ranger');
const m = bot('Мерлин', 'KNG', 'mage');
assert.strictEqual(a.hero.team, m.hero.team, 'clan mates share a team');
assert.notStrictEqual(a.hero.team, b.hero.team);

// Give resources to test building
for (const c of [a, b, m]) Object.assign(c.prof.res, { wood: 5000, stone: 5000, gold: 5000 });

let seq = 0;
function input(c, mx, my, ang, fire, ab) {
  game.onMessage(c, { t: 'i', s: ++seq, mx, my, a: ang, f: fire ? 1 : 0, ab: ab ? 1 : 0 });
}

function clearArea(x, y, R) {
  for (const s of [...game.statics.values()]) if (s.k === 'n' && Math.hypot(s.x - x, s.y - y) < R) game.removeStatic(s);
}
clearArea(3000, 5000, 600);
clearArea(5200, 5300, 300);

// A builds a town hall far from spawn
a.hero.x = 3000; a.hero.y = 4800;
game.onMessage(a, { t: 'build', type: 'townhall', x: 3000, y: 5000 });
game.tick();
assert.ok(game.thOf(a.prof), 'town hall built');
const th = game.thOf(a.prof);
for (const [type, dx, dy] of [['tower', 200, 0], ['wall', -200, 0], ['sawmill', 0, 200], ['barracks', 0, -200]]) {
  game.onMessage(a, { t: 'build', type, x: th.x + dx, y: th.y + dy });
}
game.tick();
assert.ok(game.countOf(a.prof.pid, 'tower') === 1, 'tower built ' + a.sent.filter((s) => s.includes('"msg"')).map((s) => JSON.stringify(JSON.parse(s).ev)).join());
game.onMessage(a, { t: 'up', id: th.id });
assert.strictEqual(th.lvl, 2);

// B builds its own base elsewhere
b.hero.x = 5200; b.hero.y = 5200;
game.onMessage(b, { t: 'build', type: 'townhall', x: 5200, y: 5300 });
assert.ok(game.thOf(b.prof));

// Run a lot of ticks with random inputs
const t0 = Date.now();
for (let i = 0; i < 30 * 90; i++) {
  for (const c of [a, b, m]) {
    if (c.hero.dead) { if (i % 30 === 0) game.onMessage(c, { t: 'respawn', cls: c.prof.cls }); continue; }
    input(c, Math.sin(i / 40 + c.pid), Math.cos(i / 50 + c.pid), i / 10, true, i % 90 === 0);
  }
  // teleport B next to A's base halfway through to raid it
  if (i === 30 * 30 && !b.hero.dead) { b.hero.x = th.x + 300; b.hero.y = th.y + 300; }
  // M next to the dragon
  if (i === 30 * 40 && !m.hero.dead) { m.hero.x = 6300; m.hero.y = 6300; }
  game.tick();
  if (i % 300 === 0) game.onMessage(a, { t: 'stat', i: 0 });
}
const ms = Date.now() - t0;
console.log(`90s of game simulated in ${ms}ms (${(ms / 2700).toFixed(2)} ms/tick)`);
console.log(`units=${game.units.size} projs=${game.projs.size} statics=${game.statics.size} mobs=${game.mobCount}`);
for (const c of [a, b, m]) console.log(c.prof.name, 'lvl', c.prof.lvl, 'res', JSON.stringify(c.prof.res), 'glory', c.prof.glory);

// Snapshot shape
const snap = JSON.parse(a.sent.filter((s) => s.startsWith('{"t":"s"')).pop());
assert.ok(Array.isArray(snap.u) && snap.pf && typeof snap.pf.lvl === 'number');

// Persistence round-trip
const data = JSON.parse(JSON.stringify(game.serialize()));
const g2 = new Game({ camps: 0 });
g2.init(data);
assert.strictEqual(g2.profiles.size, game.profiles.size);
let nb = 0;
for (const s of g2.statics.values()) if (s.k === 'b') nb++;
assert.ok(nb > 0, 'buildings restored');
const again = { ws: null, sendRaw() {}, send() {} };
g2.onMessage(again, { t: 'join', token: a.prof.token, name: 'Артур', clan: 'KNG', cls: 'warrior' });
assert.strictEqual(again.pid, a.prof.pid, 'token restores profile');
for (let i = 0; i < 60; i++) g2.tick();

game.leave(a);
game.tick();
console.log('smoke ok');

// malformed messages must not break the server
const evil = bot('evil', '', 'constructor');
assert.strictEqual(evil.prof.cls, 'warrior');
for (const type of ['constructor', '__proto__', 'toString']) game.onMessage(evil, { t: 'build', type, x: 100, y: 100 });
game.onMessage(evil, { t: 'respawn', cls: '__proto__' });
game.onMessage(evil, { t: 'i', s: 'x', mx: 'NaN', a: {} });
game.tick();
for (const s of game.statics.values()) assert.ok(s.k === 'n' || own(S.BUILDINGS, s.type));
console.log('malformed input ok');
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// every advanced class: evolve at 10, empower at 20, fight for a while
{
  const g = new Game({ camps: 0 });
  g.init(null);
  const mk = (name, cls) => {
    const c = { ws: null, sent: [], sendRaw(s) { this.sent.push(s); if (this.sent.length > 5) this.sent.shift(); }, send(o) { this.sendRaw(JSON.stringify(o)); } };
    g.onMessage(c, { t: 'join', name, cls });
    return c;
  };
  const fresh = mk('fresh', 'mage');
  assert.strictEqual(fresh.prof.pts, S.START_PTS, 'new heroes start with bonus skill points');
  const bots = [];
  let q = 0;
  for (const [sub, d] of Object.entries(S.SUBCLASSES)) {
    const c = mk(sub, d.base);
    g.onMessage(c, { t: 'evolve', sub });
    assert.strictEqual(c.prof.sub, null, 'cannot evolve before level 10');
    g.giveXp(c.prof, 1e6);
    g.onMessage(c, { t: 'evolve', sub });
    assert.strictEqual(c.prof.sub, sub, 'evolved into ' + sub);
    assert.strictEqual(c.hero.type, sub);
    assert.strictEqual(c.hero.tier, 2);
    // park near the forest boss with monsters around
    c.hero.x = 2700 + (q % 3) * 120 - 120; c.hero.y = 3400 + Math.floor(q / 3) * 100; q++;
    bots.push(c);
  }
  const wrong = mk('wrong', 'warrior');
  g.giveXp(wrong.prof, 1e6);
  g.onMessage(wrong, { t: 'evolve', sub: 'druid' });
  assert.strictEqual(wrong.prof.sub, null, 'cannot take another class branch');
  let s2 = 0;
  for (let i = 0; i < 30 * 20; i++) {
    for (const c of bots) {
      if (c.hero.dead) { if (i % 30 === 0) g.onMessage(c, { t: 'respawn', cls: c.prof.cls }); continue; }
      c.hero.invulnT = 0;
      g.onMessage(c, { t: 'i', s: ++s2, mx: 0, my: -0.2, a: -Math.PI / 2 + Math.sin(i / 20), f: 1, ab: i % 45 === 0 ? 1 : 0 });
    }
    g.tick();
  }
  const pets = [...g.units.values()].filter((u) => u.kind === 'knight' && u.pet).length;
  console.log(`advanced classes ok, pets alive: ${pets}`);
  for (const c of bots) assert.ok(c.prof.sub, 'subclass kept after death: ' + c.prof.name);
  // class change on respawn resets the branch
  const bm = bots.find((c) => c.prof.sub === 'beastmaster');
  bm.hero.dead = true; bm.deadInfo = { until: 0 };
  g.onMessage(bm, { t: 'respawn', cls: 'mage' });
  assert.strictEqual(bm.prof.sub, null);

  // warcamp mercenaries hunt enemies on their own
  const boss = bots[0];
  Object.assign(boss.prof.res, { wood: 5000, stone: 5000, gold: 5000 });
  for (const n of [...g.statics.values()]) if (n.k === 'n' && Math.hypot(n.x - 5000, n.y - 5600) < 700) g.removeStatic(n);
  boss.hero.x = 5000; boss.hero.y = 5400;
  g.onMessage(boss, { t: 'build', type: 'townhall', x: 5000, y: 5600 });
  const th2 = g.thOf(boss.prof);
  assert.ok(th2);
  g.onMessage(boss, { t: 'up', id: th2.id });
  g.onMessage(boss, { t: 'build', type: 'warcamp', x: 5200, y: 5600 });
  assert.strictEqual(g.countOf(boss.prof.pid, 'warcamp'), 1, 'warcamp built');
  const seen = new Set();
  for (let i = 0; i < 30 * 25; i++) {
    g.tick();
    for (const u of g.units.values()) if (u.type === 'merc') seen.add(u.id);
  }
  const mercs = seen.size;
  assert.ok(mercs >= 1, 'mercenaries spawned');
  console.log(`warcamp ok, mercs: ${mercs}`);
}

// bots: they should level up, build bases and never crash the server
{
  const g = new Game({ bots: 6 });
  g.init(null);
  assert.strictEqual(g.botMgr.bots.length, 6);
  const chats = [];
  const bcast = g.broadcast.bind(g);
  g.broadcast = (msg) => { if (msg.t === 'chat') chats.push(msg); bcast(msg); };
  g.onMessage(g.botMgr.bots[0].c, { t: 'chat', m: 'привет' });
  const t0 = Date.now();
  for (let i = 0; i < 30 * 240; i++) g.tick();
  assert.strictEqual(chats.length, 0, 'bots never chat');
  const ms = Date.now() - t0;
  const profs = g.botMgr.bots.map((b) => b.c.prof);
  const ths = profs.filter((p) => g.thOf(p)).length;
  const lv = profs.map((p) => p.lvl);
  console.log(`bots ok: 4 min in ${ms}ms (${(ms / 7200).toFixed(2)} ms/tick), levels ${lv.join(',')}, bases ${ths}, buildings ${[...g.statics.values()].filter((s) => s.k === 'b').length}, mobs ${g.mobCount}`);
  assert.ok(lv.some((l) => l > 1), 'bots gain levels');
  assert.ok(ths >= 1, 'bots build bases');
  const data = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game({ bots: 6 });
  g2.init(data);
  assert.deepStrictEqual(g2.botMgr.bots.map((b) => b.c.prof.pid).sort(), profs.map((p) => p.pid).sort(), 'bots keep their profiles after restart');
}

// NPC settlements, new monsters and bosses
{
  const g = new Game();
  g.init(null);
  assert.ok(g.camps.length >= 5, 'camps generated: ' + g.camps.length);
  const halls = [...g.statics.values()].filter((s) => s.type === 'npc_hall');
  assert.strictEqual(halls.length, g.camps.length);
  const guards = [...g.units.values()].filter((u) => u.kind === 'knight' && u.team === 'mob').length;
  assert.ok(guards >= g.camps.length * 4, 'camp guards spawned');
  assert.ok(!JSON.stringify(g.serialize()).includes('npc_hall'), 'NPC camps are not saved');
  const mk = (name, cls) => {
    const c = { ws: null, sent: [], sendRaw() {}, send() {} };
    g.onMessage(c, { t: 'join', name, cls });
    return c;
  };
  const raider = mk('raider', 'mage');
  g.onMessage(raider, { t: 'build', type: 'npc_hall', x: 100, y: 100 });
  assert.ok(![...g.statics.values()].some((s) => s.type === 'npc_hall' && s.pid), 'players cannot build NPC halls');
  // raze a camp
  const camp = g.camps[0];
  const hall = g.statics.get(camp.hallId);
  const before = raider.prof.res.gold;
  g.hurt(hall, 1e9, { pid: raider.pid, team: raider.hero.team, x: hall.x, y: hall.y + 200 });
  assert.ok(!g.statics.has(hall.id) && camp.respawnAt > 0, 'hall destroyed, camp scheduled to respawn');
  assert.ok(raider.prof.res.gold > before, 'hall loot paid');
  camp.respawnAt = g.time + 0.01;
  for (let i = 0; i < 20; i++) g.tick();
  assert.ok(g.statics.has(camp.hallId) && !camp.respawnAt, 'camp rebuilt');
  // new monsters & bosses fight a hero without crashing
  const bots = ['boar', 'spider', 'troll', 'yeti', 'salamander', 'wraith'];
  for (const [i, type] of bots.entries()) g.spawnMob(type, 3000 + i * 40, 3000, 1.5);
  for (const key of ['spiderqueen', 'frostgiant', 'minotaur']) {
    const b = [...g.units.values()].find((u) => u.kind === 'boss' && u.type === key);
    assert.ok(b, key + ' spawned');
    const v = mk('v' + key, 'warrior');
    v.hero.x = b.x - 300; v.hero.y = b.y; v.hero.invulnT = 0;
  }
  raider.hero.x = 3000; raider.hero.y = 3150; raider.hero.invulnT = 0;
  let s = 0;
  for (let i = 0; i < 30 * 20; i++) {
    g.onMessage(raider, { t: 'i', s: ++s, mx: 0, my: 0, a: -Math.PI / 2, f: 1, ab: 0 });
    g.tick();
  }
  console.log('camps, new monsters and bosses ok:', g.camps.length, 'camps');
}

// farmhouse peasants gather near the base, eat food, starve without it; cows give food
{
  const g = new Game({ camps: 0 });
  g.init(null);
  const c = { ws: null, sent: [], events: [], sendRaw() {}, send() {} };
  g.onMessage(c, { t: 'join', name: 'фермер', cls: 'ranger' });
  const cx = 6000, cy = 8000;
  for (const st of [...g.statics.values()]) if (Math.hypot(st.x - cx, st.y - cy) < 900) g.removeStatic(st);
  for (const u of [...g.units.values()]) if (u.kind === 'mob' && Math.hypot(u.x - cx, u.y - cy) < 1500) { g.units.delete(u.id); if (u.def.peaceful) g.cowCount--; else g.mobCount--; }
  c.hero.x = cx; c.hero.y = cy + 250;
  Object.assign(c.prof.res, { wood: 900, stone: 900, gold: 900, food: 60 });
  g.onMessage(c, { t: 'build', type: 'townhall', x: cx, y: cy });
  g.onMessage(c, { t: 'build', type: 'farmhouse', x: cx + 220, y: cy });
  assert.strictEqual(g.countOf(c.pid, 'farmhouse'), 1, 'farmhouse built');
  g.addNode('tree', cx - 250, cy - 150);
  g.addNode('rock', cx + 150, cy - 280);
  g.addNode('gold', cx - 120, cy + 300);
  const wood0 = c.prof.res.wood, stone0 = c.prof.res.stone;
  for (let i = 0; i < 30 * 45; i++) { c.hero.x = cx; c.hero.y = cy + 250; g.tick(); }
  const peasants = [...g.units.values()].filter((u) => u.worker && u.pid === c.pid);
  assert.ok(peasants.length >= 2, 'peasants hired: ' + peasants.length);
  assert.ok(c.prof.res.food < 60, 'food spent on hiring and upkeep');
  assert.ok(c.prof.res.wood + c.prof.res.stone > wood0 + stone0, 'peasants delivered resources');
  // starve them
  c.prof.res.food = 0;
  for (let i = 0; i < 30 * 90; i++) { c.hero.x = cx; c.hero.y = cy + 250; g.tick(); }
  assert.ok(![...g.units.values()].some((u) => u.worker && u.pid === c.pid), 'hungry peasants leave');
  // cows are peaceful, flee and give food
  assert.ok(g.cowCount > 50, 'cows spawned: ' + g.cowCount);
  const cow = g.spawnMob('cow', cx, cy + 400, 1);
  c.hero.x = cx; c.hero.y = cy + 330;
  g.hurt(cow, 10, g.srcOf(c.hero, true));
  const y0 = cow.y;
  for (let i = 0; i < 15; i++) g.tick();
  assert.ok(cow.y > y0 + 20, 'cow flees');
  assert.strictEqual(c.hero.hp, c.hero.maxHp, 'cow never attacks');
  const food0 = c.prof.res.food;
  g.hurt(cow, 1e6, g.srcOf(c.hero, true));
  assert.ok(c.prof.res.food > food0, 'cow gives food');
  console.log(`farm ok: ${peasants.length} peasants, cows ${g.cowCount}`);
}
