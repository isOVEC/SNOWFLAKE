// Headless smoke test: bots join, farm, build, fight bosses and raid each other.
const assert = require('assert');
const Game = require('../server/game');
const S = require('../public/shared.js');

const game = new Game();
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
const g2 = new Game();
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
