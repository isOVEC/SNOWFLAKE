'use strict';
// Procedural chiptune audio: every sound effect and all music are synthesised with the
// Web Audio API at runtime, so the game ships without a single audio file.
const AUDIO = (() => {
  let ctx = null, master, musicBus, sfxBus, noiseBuf;
  const settings = { music: 0.55, sfx: 0.75, musicOn: true, sfxOn: true };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('ef_audio') || '{}')); } catch (e) { /* ignore */ }
  const save = () => { try { localStorage.setItem('ef_audio', JSON.stringify(settings)); } catch (e) { /* ignore */ } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.connect(master);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    apply();
    setInterval(schedule, 25);
  }
  function apply() {
    if (!ctx) return;
    musicBus.gain.setTargetAtTime(settings.musicOn ? settings.music * 0.55 : 0, ctx.currentTime, 0.2);
    sfxBus.gain.setTargetAtTime(settings.sfxOn ? settings.sfx : 0, ctx.currentTime, 0.05);
  }

  // ------------------------------------------------------------------ voice
  let voices = 0;
  function voice(t0, o, dest) {
    const d = o.d || 0.1;
    const g = ctx.createGain();
    let src;
    if (o.w === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = noiseBuf; src.loop = true;
      src.playbackRate.value = o.rate || 1;
    } else {
      src = ctx.createOscillator();
      src.type = o.w || 'square';
      src.frequency.setValueAtTime(o.f, t0);
      if (o.f2) src.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + (o.fd || d));
      if (o.vib) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = o.vib; lg.gain.value = o.vibAmt || o.f * 0.03;
        lfo.connect(lg); lg.connect(src.frequency); lfo.start(t0); lfo.stop(t0 + d + 0.05);
      }
    }
    let node = src;
    if (o.filt) {
      const bq = ctx.createBiquadFilter();
      bq.type = o.ft || 'lowpass';
      bq.frequency.setValueAtTime(o.filt, t0);
      if (o.filt2) bq.frequency.exponentialRampToValueAtTime(o.filt2, t0 + d);
      bq.Q.value = o.q || 0.8;
      node.connect(bq); node = bq;
    }
    node.connect(g);
    const v = o.v || 0.2, a = o.a || 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + a);
    if (o.hold) g.gain.setValueAtTime(v, t0 + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    if (o.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      g.connect(p); p.connect(dest);
    } else g.connect(dest);
    src.start(t0);
    src.stop(t0 + d + 0.05);
    voices++;
    src.onended = () => { voices--; };
  }

  // ------------------------------------------------------------------ sound effects
  const N = (o) => Object.assign({ w: 'noise' }, o);
  const SFX = {
    swing: [N({ d: 0.13, v: 0.22, filt: 1800, filt2: 500, ft: 'bandpass', q: 1.5 })],
    heavy: [N({ d: 0.2, v: 0.28, filt: 1200, filt2: 300, ft: 'bandpass', q: 1.2 }), { w: 'sine', f: 140, f2: 60, d: 0.15, v: 0.2 }],
    arrow: [{ w: 'square', f: 1300, f2: 500, d: 0.07, v: 0.07 }, N({ d: 0.05, v: 0.08, filt: 4000, ft: 'highpass' })],
    crossbow: [{ w: 'square', f: 320, f2: 120, d: 0.09, v: 0.12 }, N({ d: 0.04, v: 0.15, filt: 3000, ft: 'highpass' })],
    bigbolt: [{ w: 'sawtooth', f: 200, f2: 50, d: 0.35, v: 0.2 }, N({ d: 0.25, v: 0.25, filt: 2500, filt2: 300 })],
    dagger: [N({ d: 0.05, v: 0.12, filt: 3500, ft: 'bandpass', q: 3 }), N({ d: 0.05, v: 0.1, filt: 4500, ft: 'bandpass', q: 3, at: 0.04 })],
    fire: [N({ d: 0.28, v: 0.25, filt: 1400, filt2: 200 }), { w: 'sine', f: 220, f2: 80, d: 0.22, v: 0.15 }],
    magic: [{ w: 'sine', f: 600, f2: 1000, d: 0.16, v: 0.1 }, { w: 'triangle', f: 1200, f2: 1600, d: 0.12, v: 0.05 }],
    thorn: [{ w: 'triangle', f: 520, f2: 300, d: 0.09, v: 0.12 }, N({ d: 0.04, v: 0.06, filt: 2000, ft: 'highpass' })],
    holyshot: [{ w: 'sine', f: 880, d: 0.22, v: 0.08 }, { w: 'sine', f: 1320, d: 0.25, v: 0.05, at: 0.03 }],
    enemyshot: [{ w: 'square', f: 500, f2: 260, d: 0.08, v: 0.05 }],
    hit: [N({ d: 0.07, v: 0.22, filt: 2200 }), { w: 'square', f: 160, f2: 60, d: 0.06, v: 0.08 }],
    chop: [N({ d: 0.09, v: 0.22, filt: 900 }), { w: 'triangle', f: 240, f2: 140, d: 0.09, v: 0.18 }],
    stone: [N({ d: 0.06, v: 0.2, filt: 1600, ft: 'highpass' }), { w: 'square', f: 420, f2: 300, d: 0.05, v: 0.06 }],
    gold: [{ w: 'triangle', f: 1320, d: 0.12, v: 0.14 }, { w: 'triangle', f: 1760, d: 0.18, v: 0.1, at: 0.05 }],
    thud: [{ w: 'sine', f: 95, f2: 45, d: 0.22, v: 0.35 }, N({ d: 0.1, v: 0.18, filt: 500 })],
    coin: [{ w: 'square', f: 988, d: 0.05, v: 0.035 }, { w: 'square', f: 1319, d: 0.09, v: 0.035, at: 0.05 }],
    mobdie: [N({ d: 0.22, v: 0.2, filt: 1400, filt2: 200 }), { w: 'square', f: 300, f2: 90, d: 0.2, v: 0.06 }],
    die: [{ w: 'square', f: 440, f2: 70, d: 0.45, v: 0.12 }, N({ d: 0.3, v: 0.15, filt: 900, filt2: 150 })],
    boom: [N({ d: 0.45, v: 0.4, filt: 2400, filt2: 90 }), { w: 'sine', f: 130, f2: 35, d: 0.4, v: 0.3 }],
    nova: [{ w: 'sine', f: 1100, f2: 2400, d: 0.35, v: 0.12 }, N({ d: 0.4, v: 0.15, filt: 5000, ft: 'highpass' }), { w: 'triangle', f: 660, f2: 1320, d: 0.3, v: 0.08 }],
    slam: [{ w: 'sine', f: 85, f2: 30, d: 0.55, v: 0.5 }, N({ d: 0.35, v: 0.3, filt: 400 })],
    dash: [N({ d: 0.22, v: 0.25, filt: 700, filt2: 2600, ft: 'bandpass', q: 1.2 })],
    blink: [{ w: 'sine', f: 280, f2: 1600, d: 0.22, v: 0.12 }, N({ d: 0.18, v: 0.08, filt: 3000, ft: 'highpass' })],
    lvl: [{ w: 'square', f: 523, d: 0.08, v: 0.08 }, { w: 'square', f: 659, d: 0.08, v: 0.08, at: 0.07 }, { w: 'square', f: 784, d: 0.08, v: 0.08, at: 0.14 }, { w: 'square', f: 1047, d: 0.25, v: 0.09, at: 0.21 }],
    build: [{ w: 'sine', f: 110, f2: 55, d: 0.2, v: 0.35 }, N({ d: 0.12, v: 0.15, filt: 700 }), { w: 'triangle', f: 784, d: 0.15, v: 0.06, at: 0.12 }, { w: 'triangle', f: 1047, d: 0.2, v: 0.06, at: 0.2 }],
    crumble: [N({ d: 0.7, v: 0.4, filt: 1500, filt2: 80 }), { w: 'sine', f: 90, f2: 30, d: 0.6, v: 0.35 }, N({ d: 0.3, v: 0.2, filt: 3000, ft: 'highpass', at: 0.15 })],
    bossdie: [N({ d: 1.2, v: 0.45, filt: 2000, filt2: 60 }), { w: 'sine', f: 110, f2: 28, d: 1.0, v: 0.4 },
      { w: 'square', f: 523, d: 0.15, v: 0.07, at: 0.5 }, { w: 'square', f: 659, d: 0.15, v: 0.07, at: 0.62 }, { w: 'square', f: 784, d: 0.15, v: 0.07, at: 0.74 }, { w: 'square', f: 1047, d: 0.5, v: 0.08, at: 0.86 }],
    zap: [N({ d: 0.12, v: 0.3, filt: 3200, ft: 'highpass' }), { w: 'sawtooth', f: 900, f2: 200, d: 0.1, v: 0.08 }],
    thunder: [N({ d: 0.1, v: 0.35, filt: 4000, ft: 'highpass' }), N({ d: 0.7, v: 0.4, filt: 350, filt2: 60, at: 0.04 })],
    bastion: [{ w: 'square', f: 220, d: 0.35, v: 0.1, filt: 1400, ft: 'bandpass', q: 4 }, { w: 'square', f: 331, d: 0.4, v: 0.08, filt: 2000, ft: 'bandpass', q: 4 }, { w: 'sine', f: 110, f2: 60, d: 0.3, v: 0.25 }],
    rage: [{ w: 'sawtooth', f: 120, f2: 70, d: 0.45, v: 0.18, vib: 18, vibAmt: 10, filt: 900 }, N({ d: 0.3, v: 0.15, filt: 700 })],
    whirl: [N({ d: 0.3, v: 0.2, filt: 500, filt2: 2200, ft: 'bandpass', q: 2 })],
    howl: [{ w: 'sine', f: 330, f2: 520, fd: 0.35, d: 0.8, v: 0.14, vib: 6, vibAmt: 8 }, { w: 'triangle', f: 440, f2: 690, fd: 0.35, d: 0.7, v: 0.05, at: 0.05 }],
    roots: [{ w: 'sine', f: 70, f2: 40, d: 0.6, v: 0.35 }, N({ d: 0.5, v: 0.2, filt: 350 }), { w: 'triangle', f: 196, d: 0.4, v: 0.06, at: 0.1 }],
    bless: [{ w: 'sine', f: 523, d: 0.8, v: 0.08, a: 0.05 }, { w: 'sine', f: 659, d: 0.8, v: 0.07, a: 0.05, at: 0.06 }, { w: 'sine', f: 784, d: 0.9, v: 0.07, a: 0.05, at: 0.12 }, { w: 'sine', f: 1047, d: 1.0, v: 0.05, a: 0.05, at: 0.18 }],
    roar: [{ w: 'sawtooth', f: 95, f2: 60, d: 0.9, v: 0.22, vib: 11, vibAmt: 9, filt: 700, a: 0.08 }, N({ d: 0.8, v: 0.18, filt: 600, a: 0.08 })],
    bite: [N({ d: 0.06, v: 0.14, filt: 1500, ft: 'bandpass', q: 2 })],
    error: [{ w: 'square', f: 150, d: 0.1, v: 0.08 }, { w: 'square', f: 120, d: 0.12, v: 0.08, at: 0.11 }],
    click: [{ w: 'square', f: 720, d: 0.035, v: 0.05 }],
    place: [{ w: 'triangle', f: 440, d: 0.05, v: 0.08 }, { w: 'triangle', f: 660, d: 0.07, v: 0.08, at: 0.05 }],
    chat: [{ w: 'triangle', f: 1200, d: 0.05, v: 0.06 }, { w: 'triangle', f: 1500, d: 0.05, v: 0.05, at: 0.05 }],
    horn: [{ w: 'sawtooth', f: 220, d: 0.5, v: 0.08, filt: 1200, a: 0.05 }, { w: 'sawtooth', f: 330, d: 0.7, v: 0.07, filt: 1200, a: 0.05, at: 0.35 }],
    evolve: [{ w: 'square', f: 392, d: 0.12, v: 0.08 }, { w: 'square', f: 523, d: 0.12, v: 0.08, at: 0.1 }, { w: 'square', f: 659, d: 0.12, v: 0.08, at: 0.2 },
      { w: 'square', f: 784, d: 0.5, v: 0.09, at: 0.3 }, { w: 'triangle', f: 196, d: 0.8, v: 0.12, at: 0.3 }],
    gameover: [{ w: 'square', f: 392, d: 0.2, v: 0.08 }, { w: 'square', f: 349, d: 0.2, v: 0.08, at: 0.2 }, { w: 'square', f: 311, d: 0.2, v: 0.08, at: 0.4 }, { w: 'square', f: 262, d: 0.7, v: 0.09, at: 0.6 }],
  };
  const GAP = { hit: 0.03, coin: 0.06, chop: 0.04, stone: 0.04, gold: 0.06, enemyshot: 0.05, swing: 0.03, bite: 0.05, roar: 1.5, magic: 0.04, fire: 0.04, arrow: 0.02, zap: 0.03, mobdie: 0.04 };
  const last = {};
  const view = { x: 0, y: 0 };

  function play(name, pan, vol) {
    if (!ctx || !settings.sfxOn || ctx.state !== 'running') return;
    const parts = SFX[name];
    if (!parts) return;
    const now = ctx.currentTime;
    if (last[name] && now - last[name] < (GAP[name] || 0.015)) return;
    if (voices > 48) return;
    last[name] = now;
    const k = vol === undefined ? 1 : vol;
    for (const p of parts) voice(now + (p.at || 0), Object.assign({}, p, { v: (p.v || 0.2) * k, pan }), sfxBus);
  }
  // positional: quieter and panned by distance from the camera
  function at(name, x, y, vol) {
    const dx = x - view.x, dy = y - view.y;
    const d = Math.hypot(dx, dy);
    const k = Math.pow(clamp(1 - d / 1500, 0, 1), 1.4) * (vol === undefined ? 1 : vol);
    if (k < 0.03) return;
    play(name, clamp(dx / 900, -0.9, 0.9), k);
  }

  // ------------------------------------------------------------------ music
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11] };
  const SONGS = {
    menu: { bpm: 80, root: 57, scale: 'minor', prog: [0, 5, 2, 6], bass: 'half', arp: 'slow', lead: 0.45, pad: true, drums: 'none', seed: 11 },
    peace: { bpm: 100, root: 60, scale: 'major', prog: [0, 4, 5, 3], bass: 'walk', arp: 'eighth', lead: 0.55, pad: false, drums: 'soft', seed: 3 },
    high: { bpm: 92, root: 62, scale: 'dorian', prog: [0, 3, 6, 4], bass: 'half', arp: 'eighth', lead: 0.5, pad: true, drums: 'soft', seed: 7 },
    cold: { bpm: 76, root: 64, scale: 'minor', prog: [0, 3, 0, 4], bass: 'whole', arp: 'slow', lead: 0.4, pad: true, drums: 'none', seed: 21 },
    swamp: { bpm: 88, root: 55, scale: 'phrygian', prog: [0, 1, 0, 6], bass: 'half', arp: 'eighth', lead: 0.4, pad: true, drums: 'soft', seed: 17 },
    volcano: { bpm: 112, root: 52, scale: 'phrygian', prog: [0, 5, 6, 0], bass: 'eighth', arp: 'sixteenth', lead: 0.5, pad: false, drums: 'hard', seed: 29 },
    battle: { bpm: 138, root: 57, scale: 'minor', prog: [0, 5, 2, 6], bass: 'eighth', arp: 'sixteenth', lead: 0.6, pad: false, drums: 'hard', seed: 5 },
  };
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  const melodies = {};
  // an 8-bar melody: a 2-bar motif, repeated and varied, built from chord tones
  function melody(name) {
    if (melodies[name]) return melodies[name];
    const song = SONGS[name], R = rng(song.seed);
    const motif = [];
    for (let i = 0; i < 16; i++) motif.push(R() < song.lead ? { deg: Math.floor(R() * 5) - 1, len: R() < 0.3 ? 2 : 1 } : null);
    const out = [];
    for (let bar = 0; bar < 8; bar++) {
      for (let i = 0; i < 8; i++) {
        const m = motif[(bar % 2) * 8 + i];
        if (!m) { out.push(null); continue; }
        const vary = bar >= 4 && R() < 0.35 ? (R() < 0.5 ? 1 : -1) : 0;
        out.push({ deg: m.deg + vary + (bar === 7 && i >= 6 ? -m.deg : 0), len: m.len });
      }
    }
    melodies[name] = out;
    return out;
  }
  const mus = { cur: null, want: 'menu', step: 0, next: 0 };
  function note(scaleName, root, chordDeg, idx, octave) {
    const sc = SCALES[scaleName];
    const d = chordDeg + idx;
    const o = Math.floor(d / 7);
    return root + sc[((d % 7) + 7) % 7] + (o + octave) * 12;
  }
  function scheduleStep(t, step) {
    if (step % 16 === 0 && mus.want !== mus.cur) { mus.cur = mus.want; mus.step = step = 0; }
    const song = SONGS[mus.cur];
    if (!song) return;
    const bar = Math.floor(step / 16) % 8, s = step % 16;
    const chord = song.prog[bar % song.prog.length];
    const beat = 60 / song.bpm;
    const st = beat / 4;
    const B = musicBus;
    // bass
    const bassN = midi(note(song.scale, song.root, chord, 0, -2));
    const bassOn = { whole: s === 0, half: s % 8 === 0, walk: s % 4 === 0, eighth: s % 2 === 0 }[song.bass];
    if (bassOn) {
      const walkN = song.bass === 'walk' && s === 12 ? midi(note(song.scale, song.root, chord, 4, -2)) : bassN;
      voice(t, { w: 'triangle', f: walkN, d: song.bass === 'whole' ? beat * 3.8 : song.bass === 'half' ? beat * 1.9 : beat * 0.9, v: 0.32 }, B);
    }
    // arpeggio
    const arpOn = { slow: s % 4 === 0, eighth: s % 2 === 0, sixteenth: true }[song.arp];
    if (arpOn) {
      const i = [0, 2, 4, 2, 0, 2, 4, 7][(s >> (song.arp === 'sixteenth' ? 0 : song.arp === 'eighth' ? 1 : 2)) % 8];
      voice(t, { w: 'square', f: midi(note(song.scale, song.root, chord, i, 0)), d: st * 1.6, v: 0.045, filt: 2400 }, B);
    }
    // pad
    if (song.pad && s === 0) {
      for (const i of [0, 2, 4]) voice(t, { w: 'sine', f: midi(note(song.scale, song.root, chord, i, -1)), d: beat * 4, v: 0.05, a: 0.4, hold: beat * 2 }, B);
    }
    // lead
    if (s % 2 === 0) {
      const m = melody(mus.cur)[bar * 8 + s / 2];
      if (m) voice(t, { w: 'square', f: midi(note(song.scale, song.root, chord, m.deg + 2, 1)), d: st * 2 * m.len * 1.1, v: 0.055, vib: 5, vibAmt: 3, filt: 3200, a: 0.01 }, B);
    }
    // drums
    if (song.drums !== 'none') {
      const hard = song.drums === 'hard';
      if (s === 0 || (hard && s === 8) || (!hard && s === 10) || (hard && s === 11)) voice(t, { w: 'sine', f: 150, f2: 40, d: 0.14, v: hard ? 0.45 : 0.3 }, B);
      if (s === 4 || s === 12) voice(t, { w: 'noise', d: 0.1, v: hard ? 0.14 : 0.07, filt: 1800, ft: 'bandpass', q: 0.8 }, B);
      if (s % 2 === 0 || (hard && s % 2 === 1 && s > 12)) voice(t, { w: 'noise', d: 0.03, v: hard ? 0.05 : 0.025, filt: 7000, ft: 'highpass' }, B);
    }
  }
  function schedule() {
    if (!ctx || ctx.state !== 'running') return;
    if (!mus.cur) { mus.cur = mus.want; mus.next = ctx.currentTime + 0.1; }
    while (mus.next < ctx.currentTime + 0.15) {
      scheduleStep(mus.next, mus.step);
      const song = SONGS[mus.cur];
      mus.next += 60 / song.bpm / 4;
      mus.step++;
    }
  }

  return {
    init, play, at, settings,
    setMood(m) { if (SONGS[m]) mus.want = m; },
    setView(x, y) { view.x = x; view.y = y; },
    set(k, v) { settings[k] = v; save(); apply(); },
    toggle(k) { settings[k] = !settings[k]; save(); apply(); return settings[k]; },
  };
})();
