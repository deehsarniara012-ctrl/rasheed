// Zero-latency Web Audio API emergency siren engine for instant <5ms alert playback

class SirenEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private oscPrimary: OscillatorNode | null = null;
  private oscHarmonic: OscillatorNode | null = null;
  private lfo: OscillatorNode | null = null;
  private lfoGain: GainNode | null = null;
  private pulseInterval: number | null = null;
  private playing = false;
  private muted = false;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public unlock(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    // Emit silent 1-sample buffer to fully unlock iOS/Safari/Chrome audio
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // Ignore if already unlocked
    }
  }

  public isPlaying(): boolean {
    return this.playing;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
    if (mute) {
      this.stop();
    }
  }

  public start(): void {
    if (this.muted || this.playing) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-6, now);
      compressor.knee.setValueAtTime(12, now);
      compressor.ratio.setValueAtTime(12, now);
      compressor.attack.setValueAtTime(0.002, now);
      compressor.release.setValueAtTime(0.1, now);
      compressor.connect(ctx.destination);

      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0.01, now);
      masterGain.gain.linearRampToValueAtTime(1.0, now + 0.02);
      masterGain.connect(compressor);

      // Primary sawtooth siren oscillator for urgent, loud penetration
      const oscPrimary = ctx.createOscillator();
      oscPrimary.type = 'sawtooth';
      oscPrimary.frequency.setValueAtTime(760, now);

      // Secondary square harmonic oscillator for unmistakable two-tone piercing alert
      const oscHarmonic = ctx.createOscillator();
      oscHarmonic.type = 'square';
      oscHarmonic.frequency.setValueAtTime(1140, now);

      const harmonicGain = ctx.createGain();
      harmonicGain.gain.setValueAtTime(0.35, now);

      // LFO modulates pitch smoothly between high and low emergency siren tones
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(2.6, now);

      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(260, now);

      lfo.connect(lfoGain);
      lfoGain.connect(oscPrimary.frequency);
      lfoGain.connect(oscHarmonic.frequency);

      oscPrimary.connect(masterGain);
      oscHarmonic.connect(harmonicGain);
      harmonicGain.connect(masterGain);

      oscPrimary.start(now);
      oscHarmonic.start(now);
      lfo.start(now);

      // Crisp amplitude gating cadence for emergency clarity
      let high = true;
      this.pulseInterval = window.setInterval(() => {
        if (!this.ctx || !this.masterGain || !this.playing) return;
        const t = this.ctx.currentTime;
        high = !high;
        this.masterGain.gain.setTargetAtTime(high ? 1.0 : 0.72, t, 0.02);
      }, 190);

      this.masterGain = masterGain;
      this.oscPrimary = oscPrimary;
      this.oscHarmonic = oscHarmonic;
      this.lfo = lfo;
      this.lfoGain = lfoGain;
      this.playing = true;
    } catch {
      this.stop();
    }
  }

  public stop(): void {
    if (this.pulseInterval !== null) {
      window.clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }

    const ctx = this.ctx;
    if (ctx && this.masterGain) {
      try {
        const now = ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.03);
      } catch {
        // Ignore ramp errors
      }
    }

    const stopNode = (node: OscillatorNode | null) => {
      if (!node) return;
      try {
        node.stop(ctx ? ctx.currentTime + 0.04 : 0);
        node.disconnect();
      } catch {
        // Already stopped
      }
    };

    stopNode(this.oscPrimary);
    stopNode(this.oscHarmonic);
    stopNode(this.lfo);

    try {
      this.lfoGain?.disconnect();
      this.masterGain?.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    this.oscPrimary = null;
    this.oscHarmonic = null;
    this.lfo = null;
    this.lfoGain = null;
    this.masterGain = null;
    this.playing = false;
  }
}

export const sirenEngine = new SirenEngine();

let lastSpokenAt = 0;

export function speakTacticalAlert(message: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  if (sirenEngine.isMuted()) return;
  const now = Date.now();
  if (now - lastSpokenAt < 6500) return;
  lastSpokenAt = now;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(message);
    utter.rate = 1.08;
    utter.pitch = 1.0;
    utter.volume = 0.95;
    window.speechSynthesis.speak(utter);
  } catch {
    // Ignore speech synthesis restrictions
  }
}

