// Tiny synthesized sound kit — no audio files.
export class Sfx {
  constructor() { this.ac = null; this.samples = {}; }

  // CC0 recordings (assets/CREDITS.md). Until they finish decoding, the synth versions play.
  async _load() {
    const names = ['explosion_far', 'gun', 'gun_reverb', 'explosion_metal', 'water_1', 'water_2', 'radio_noise', 'beep_00', 'beep_03', 'beep_07', 'beep_15'];
    await Promise.all(names.map(async (n) => {
      try {
        const buf = await (await fetch(`${import.meta.env.BASE_URL}assets/audio/${n}.ogg`)).arrayBuffer();
        this.samples[n] = await this.ac.decodeAudioData(buf);
      } catch { /* keep the synth fallback */ }
    }));
  }

  /** Play a sample; returns false if it isn't loaded. */
  _play(name, { gain = 1, rate = 1, offset = 0, dur, lowpass } = {}) {
    const buf = this.samples[name];
    if (!this.ac || !buf) return false;
    const t = this.ac.currentTime, src = this.ac.createBufferSource(), g = this.ac.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    g.gain.value = gain;
    let node = src;
    if (lowpass) { const f = this.ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; node = src.connect(f); }
    node.connect(g).connect(this.master);
    if (dur) { g.gain.setValueAtTime(gain, t + dur * 0.8); g.gain.linearRampToValueAtTime(0, t + dur); src.start(t, offset, dur); }
    else src.start(t, offset);
    return true;
  }

  init() {
    if (this.ac) { this.ac.resume(); this.setMuted(false); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = (this.ac = new AC());
    this.master = ac.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ac.destination);
    this._load();

    const len = ac.sampleRate * 2;
    this.noise = ac.createBuffer(1, len, ac.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine drone
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    const g = ac.createGain();
    g.gain.value = 0.5;
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    for (const f of [52, 78.5]) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const og = ac.createGain();
      og.gain.value = 0.025;
      o.connect(og).connect(this.master);
      o.start();
    }
  }

  setMuted(m) {
    if (this.ac) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ac.currentTime, 0.05);
  }

  _burst(dur, freq, gain, type = 'lowpass', delay = 0) {
    const ac = this.ac;
    if (!ac) return;
    const t = ac.currentTime + delay;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.25), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  _thump(f0, f1, dur, gain) {
    const ac = this.ac;
    if (!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  shot(w) {
    if (w === 0) { this._burst(0.06, 1800, 0.22, 'bandpass'); this._thump(160, 70, 0.05, 0.2); }
    else if (w === 1) { if (!this._play('gun', { gain: 0.55, rate: 1.25 + Math.random() * 0.1 })) this._burst(0.22, 1100, 0.5); this._thump(130, 45, 0.18, 0.4); }
    else { if (!this._play('gun_reverb', { gain: 1.2, rate: 0.78 })) this._burst(0.8, 600, 0.9); this._thump(90, 28, 0.6, 1.0); }
  }

  boom(size) { // distant, muffled
    if (this._play('explosion_far', { gain: 0.35 + size * 0.75, rate: 1.55 - size * 0.75 + Math.random() * 0.1 })) return;
    this._burst(0.5 + size * 1.3, 260 + size * 120, 0.25 + size * 0.5);
    this._thump(70, 30, 0.3 + size * 0.5, 0.2 + size * 0.5);
  }

  metal() { // a vehicle brewing up
    if (!this._play('explosion_metal', { gain: 0.55, rate: 0.85 + Math.random() * 0.2, lowpass: 2400 })) this.boom(0.7);
  }

  splash() { // round landing in water
    this._play(Math.random() < 0.5 ? 'water_1' : 'water_2', { gain: 0.5, lowpass: 3000 });
  }

  radio() { // squelch burst + roger beep under each radio call
    const buf = this.samples.radio_noise;
    if (buf) this._play('radio_noise', { gain: 0.5, offset: Math.random() * (buf.duration - 0.5), dur: 0.22 });
    this._play('beep_07', { gain: 0.12, rate: 1.4 });
  }

  click() { // weapon select
    if (!this._play('beep_03', { gain: 0.15, rate: 1.2 })) this.beep(660, 0.05);
  }

  thunder() { // distant, rolling
    this._burst(2.6, 220, 0.5);
    this._thump(55, 26, 1.4, 0.5);
  }

  tick() { this._burst(0.05, 500, 0.05); }

  // ---- threats to the gunship
  missile() { this._burst(1.6, 1500, 0.28, 'bandpass'); } // launch: rocket motor roar, far below
  warn() { this.beep(1250, 0.06, 2); } // missile-approach tone
  flare() { for (let i = 0; i < 5; i++) this._burst(0.07, 3200, 0.2, 'highpass', i * 0.08); }
  hit() { this._burst(0.07, 2600, 0.32, 'bandpass'); this._thump(240, 90, 0.07, 0.35); } // rounds through the skin
  airburst() { this._burst(0.5, 900, 0.35); this._thump(110, 40, 0.3, 0.5); }

  beep(freq, dur, count = 1) {
    const ac = this.ac;
    if (!ac) return;
    for (let i = 0; i < count; i++) {
      const t = ac.currentTime + i * (dur + 0.07);
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = freq;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.06, t);
      g.gain.setValueAtTime(0, t + dur);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }
}
