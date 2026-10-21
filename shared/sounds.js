// The sound catalog: tiny synthesized sounds (Web Audio, no audio files) that
// pets can play with their animations. A pet may also define its own recipes
// in its file under `sounds`, using the same shape.
//
// A recipe is a list of parts played together:
//   { wave: 'sine'|'square'|'triangle'|'sawtooth'|'noise', f: startHz, to: endHz,
//     at: startSeconds, dur: seconds, gain: 0..1, q: filterQ (noise only) }
// plus optional `repeatMs` for looping animations (snoring, footsteps).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetSounds = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SOUNDS = {
    boop: { label: 'Boop', parts: [{ wave: 'sine', f: 520, to: 780, dur: 0.12, gain: 0.5 }] },
    blip: { label: 'Blip', parts: [{ wave: 'square', f: 880, dur: 0.05, gain: 0.18 }] },
    pop: { label: 'Pop', parts: [{ wave: 'sine', f: 900, to: 260, dur: 0.08, gain: 0.55 }] },
    chirp: { label: 'Chirp', parts: [{ wave: 'sine', f: 1300, to: 2100, dur: 0.07, gain: 0.35 }, { wave: 'sine', f: 1500, to: 2400, at: 0.1, dur: 0.07, gain: 0.3 }] },
    ding: { label: 'Ding-dong (attention)', parts: [{ wave: 'triangle', f: 988, dur: 0.35, gain: 0.45 }, { wave: 'triangle', f: 784, at: 0.18, dur: 0.45, gain: 0.45 }] },
    yay: { label: 'Yay (arpeggio)', parts: [523, 659, 784, 1047].map((f, i) => ({ wave: 'triangle', f, at: i * 0.07, dur: 0.16, gain: 0.35 })) },
    sparkle: { label: 'Sparkle', parts: [1568, 2093, 2637].map((f, i) => ({ wave: 'sine', f, at: i * 0.05, dur: 0.12, gain: 0.2 })) },
    whoosh: { label: 'Whoosh', parts: [{ wave: 'noise', f: 400, to: 2400, dur: 0.35, gain: 0.35, q: 1.5 }] },
    thud: { label: 'Thud', parts: [{ wave: 'sine', f: 140, to: 55, dur: 0.18, gain: 0.8 }, { wave: 'noise', f: 300, dur: 0.06, gain: 0.25, q: 0.7 }] },
    boing: { label: 'Boing', parts: [{ wave: 'triangle', f: 180, to: 520, dur: 0.12, gain: 0.45 }, { wave: 'triangle', f: 520, to: 260, at: 0.12, dur: 0.2, gain: 0.35 }] },
    huff: { label: 'Huff', parts: [{ wave: 'noise', f: 700, to: 300, dur: 0.22, gain: 0.45, q: 0.8 }] },
    giggle: { label: 'Giggle', parts: [0, 1, 2, 3, 4].map((i) => ({ wave: 'sine', f: i % 2 ? 1100 : 900, to: i % 2 ? 1250 : 1000, at: i * 0.09, dur: 0.07, gain: 0.3 })) },
    grow: { label: 'Grow (slide up)', parts: [{ wave: 'sine', f: 300, to: 900, dur: 0.3, gain: 0.4 }] },
    shrink: { label: 'Shrink (slide down)', parts: [{ wave: 'sine', f: 900, to: 280, dur: 0.3, gain: 0.4 }] },
    eek: { label: 'Eek!', parts: [{ wave: 'square', f: 900, to: 1500, dur: 0.12, gain: 0.15 }, { wave: 'square', f: 1500, to: 1300, at: 0.12, dur: 0.08, gain: 0.12 }] },
    achoo: { label: 'Achoo', parts: [{ wave: 'sine', f: 500, to: 700, dur: 0.25, gain: 0.25 }, { wave: 'noise', f: 2000, to: 600, at: 0.28, dur: 0.25, gain: 0.5, q: 0.6 }] },
    dig: { label: 'Dig (scratch)', parts: [0, 0.14, 0.28].map((at) => ({ wave: 'noise', f: 1800, at, dur: 0.07, gain: 0.3, q: 2 })) },
    yawn: { label: 'Yawn', parts: [{ wave: 'triangle', f: 520, to: 240, dur: 0.7, gain: 0.3 }] },
    snore: { label: 'Snore (loops)', repeatMs: 2600, parts: [{ wave: 'noise', f: 180, to: 260, dur: 0.9, gain: 0.22, q: 3 }] },
    tick: { label: 'Tick (footsteps, loops)', repeatMs: 180, parts: [{ wave: 'square', f: 1600, dur: 0.015, gain: 0.08 }] },
    patter: { label: 'Patter (running, loops)', repeatMs: 90, parts: [{ wave: 'square', f: 2000, dur: 0.01, gain: 0.07 }] },
    typing: { label: 'Typing (loops)', repeatMs: 140, parts: [{ wave: 'noise', f: 3000, dur: 0.02, gain: 0.12, q: 4 }] },
    hmm: { label: 'Hmm (thinking)', parts: [{ wave: 'sine', f: 220, to: 250, dur: 0.4, gain: 0.2 }] },
    beat: { label: 'Beat (dancing, loops)', repeatMs: 440, parts: [{ wave: 'sine', f: 120, to: 50, dur: 0.12, gain: 0.5 }, { wave: 'noise', f: 6000, at: 0.22, dur: 0.04, gain: 0.12, q: 1 }] },
    swish: { label: 'Swish', parts: [{ wave: 'noise', f: 1200, to: 3000, dur: 0.15, gain: 0.25, q: 2 }] },
    poof: { label: 'Poof (smoke)', parts: [{ wave: 'sine', f: 160, to: 50, dur: 0.25, gain: 0.7 }, { wave: 'noise', f: 1600, to: 260, dur: 0.8, gain: 0.6, q: 0.6 }, { wave: 'noise', f: 600, to: 180, at: 0.2, dur: 1.8, gain: 0.25, q: 0.5 }] },
  };

  // Which sound each standard animation gets unless the pet or the user says otherwise.
  const DEFAULTS = {
    hover: 'boop', poke: 'giggle', held: 'eek', fall: 'whoosh', land: 'thud', grow: 'grow', shrink: 'shrink',
    wake: 'yawn', sleep: 'snore', bump: 'boing', shoo: 'huff', greet: 'chirp', needsYou: 'ding', done: 'yay',
    bubbles: 'pop', dig: 'dig', dance: 'beat', stretch: 'yawn', juggle: 'blip', sneeze: 'achoo', lookAround: 'hmm',
    thinking: 'hmm', working: 'typing', walk: 'tick', run: 'patter',
  };
  // Switched on out of the box; loops and frequent states start off so the pet isn't noisy.
  const ON_BY_DEFAULT = ['hover', 'poke', 'held', 'land', 'grow', 'shrink', 'bump', 'shoo', 'greet', 'needsYou', 'done', 'bubbles', 'sneeze'];

  function validRecipe(r) {
    return !!(r && Array.isArray(r.parts) && r.parts.length && r.parts.length <= 12 &&
      r.parts.every((p) => p && typeof p.f === 'number' && p.f > 10 && p.f < 20000 && typeof p.dur === 'number' && p.dur > 0 && p.dur <= 3));
  }

  // Play a recipe on an AudioContext at `volume` (0..1).
  function play(audio, recipe, volume) {
    if (!audio || !validRecipe(recipe) || volume <= 0) return;
    const t0 = audio.currentTime + 0.01;
    const master = audio.createGain();
    master.gain.value = Math.min(1, volume);
    master.connect(audio.destination);
    for (const p of recipe.parts) {
      const at = t0 + (p.at || 0);
      const env = audio.createGain();
      const peak = Math.max(0.0001, Math.min(1, p.gain === undefined ? 0.4 : p.gain));
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.015, p.dur / 3));
      env.gain.exponentialRampToValueAtTime(0.0001, at + p.dur);
      env.connect(master);
      if (p.wave === 'noise') {
        const len = Math.ceil(audio.sampleRate * p.dur);
        const buf = audio.createBuffer(1, len, audio.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = audio.createBufferSource();
        src.buffer = buf;
        const filter = audio.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = p.q || 1;
        filter.frequency.setValueAtTime(p.f, at);
        if (p.to) filter.frequency.exponentialRampToValueAtTime(p.to, at + p.dur);
        src.connect(filter).connect(env);
        src.start(at);
        src.stop(at + p.dur + 0.02);
      } else {
        const osc = audio.createOscillator();
        osc.type = ['sine', 'square', 'triangle', 'sawtooth'].includes(p.wave) ? p.wave : 'sine';
        osc.frequency.setValueAtTime(p.f, at);
        if (p.to) osc.frequency.exponentialRampToValueAtTime(p.to, at + p.dur);
        osc.connect(env);
        osc.start(at);
        osc.stop(at + p.dur + 0.02);
      }
    }
    setTimeout(() => master.disconnect(), 4000);
  }

  return { SOUNDS, DEFAULTS, ON_BY_DEFAULT, validRecipe, play };
});
