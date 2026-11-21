import type { AlertKind, AlertPreferences, SoundChoice } from '../shared/types';
import type {RareSoundTarget} from '../shared/rare-drop-sounds';

type PlaybackKind = AlertKind | 'rare-card' | 'rare-costume';

/** Bounded playback only; audio and decoded buffers remain in memory. */
export class AlertAudio {
  private context: AudioContext | null = null;
  private buffers = new Map<AlertKind, AudioBuffer>();
  private active = new Set<AudioScheduledSourceNode>();
  private generation = new Map<AlertKind, number>();
  private waiting = new Set<AlertKind>();
  private resuming: Promise<void> | null = null;
  private disposed = false;
  constructor(private readonly onReadyChange?: (ready: boolean) => void) {}
  private getContext(): AudioContext {
    if (!this.context || this.context.state === 'closed') {
      const context = new AudioContext();
      context.onstatechange = () => { if (this.context === context) this.onReadyChange?.(this.ready); };
      this.context = context;
      this.resuming = null;
    }
    return this.context;
  }
  async enable(): Promise<boolean> {
    if (this.disposed) return false;
    const context = this.getContext();
    if (context.state !== 'running') {
      const attempt = this.resuming ??= context.resume();
      try { await attempt; }
      finally { if (this.resuming === attempt) this.resuming = null; }
    }
    return this.ready;
  }
  get ready(): boolean { return this.context?.state === 'running'; }
  async notify(kind: AlertKind, readPreferences: () => AlertPreferences): Promise<boolean> {
    const preferences = readPreferences();
    if (this.disposed || preferences.muted || !preferences.volume) return false;
    if (this.ready) return this.play(kind, preferences);
    // Coalesce bursts while Windows restores the output device.
    if (this.waiting.has(kind)) return false;
    this.waiting.add(kind);
    const received = performance.now();
    try {
      if (!await this.enable() || performance.now() - received > 5000) return false;
      return this.play(kind, readPreferences());
    } finally { this.waiting.delete(kind); }
  }
  async setSound(kind: AlertKind, sound: SoundChoice | null): Promise<void> {
    if (this.disposed) return;
    const revision = (this.generation.get(kind) ?? 0) + 1;
    this.generation.set(kind, revision);
    if (!sound) { this.buffers.delete(kind); return; }
    this.buffers.delete(kind);
    const buffer = await this.decodeSound(sound);
    if (this.generation.get(kind) === revision) this.buffers.set(kind, buffer);
  }
  async decodeSound(sound: SoundChoice): Promise<AudioBuffer> {
    if (this.disposed) throw new Error('Ses çıkışı kapatıldı.');
    const context = this.getContext();
    const comma = sound.dataUrl.indexOf(',');
    if (comma < 0 || sound.dataUrl.length > 15_000_000 || !/^data:audio\/[\w.+-]+;base64,/.test(sound.dataUrl)) throw new Error('Ses dosyası okunamadı. Başka bir WAV, MP3 veya OGG seç.');
    const bytes = Uint8Array.from(atob(sound.dataUrl.slice(comma + 1)), c => c.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    if (buffer.duration > 120) throw new Error('Bildirim sesi en fazla iki dakika olabilir.');
    return buffer;
  }
  async notifyRare(target: RareSoundTarget, readPreferences: () => AlertPreferences,
    readSound: (target: RareSoundTarget) => Promise<SoundChoice|null>, onFallback?: () => void,
    readSelectedItemSound?: () => Promise<SoundChoice|null>): Promise<boolean> {
    const preferences = readPreferences();
    if (this.disposed || preferences.muted || !preferences.volume) return false;
    const started = performance.now();
    if (!await this.enable()) return false;
    const candidates = target.itemId === undefined ? [target] : [target, {category: target.category}];
    let buffer: AudioBuffer | undefined;
    let failed = false;
    for (const candidate of candidates) {
      if (this.disposed || performance.now() - started > 5000) return false;
      try {
        const sound = await readSound(candidate);
        if (this.disposed) return false;
        if (sound) { buffer = await this.decodeSound(sound); break; }
      } catch { failed = true; }
    }
    if (!buffer && target.itemId !== undefined && readSelectedItemSound && !this.disposed) {
      buffer = this.buffers.get('card');
      if (!buffer) {
        try {
          const selected = await readSelectedItemSound();
          if (selected && !this.disposed) buffer = await this.decodeSound(selected);
        } catch { failed = true; }
      }
    }
    if (this.disposed || performance.now() - started > 5000) return false;
    if (failed) onFallback?.();
    return this.playBuffer(target.category === 'card' ? 'rare-card' : 'rare-costume', readPreferences(), buffer);
  }
  play(kind: AlertKind, preferences: AlertPreferences): boolean {
    return this.playBuffer(kind, preferences, this.buffers.get(kind));
  }
  private playBuffer(kind: PlaybackKind, preferences: AlertPreferences, buffer?: AudioBuffer): boolean {
    if (!this.ready || preferences.muted || preferences.volume === 0) return false;
    const context = this.context!;
    // Keep bursts from many simultaneous characters from growing an unbounded queue.
    if (this.active.size >= 12) {
      if (kind !== 'card' && kind !== 'glass-bead' && kind !== 'old-blue-box' && kind !== 'rare-card' && kind !== 'rare-costume') return false;
      // Selected item alerts have priority when many characters notify at once.
      for (const source of this.active) { try { source.stop(); } catch { /* already ended */ } }
      this.active.clear();
    }
    const gain = context.createGain();
    gain.gain.value = preferences.volume / 100 * .65;
    gain.connect(context.destination);
    if (buffer) {
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
      this.active.add(source); source.onended = () => { this.active.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(); return true;
    }
    const itemTone = [659, 831, 988, 1319];
    const notes: Record<PlaybackKind, number[]> = {
      death: [330, 262, 196], weight: [440, 440, 523], card: itemTone, 'glass-bead': itemTone, 'old-blue-box': itemTone,
      city: [523, 659, 523], level: [523, 659, 784, 1047], monster:[784,587,784],
      'rare-card': [659, 880, 1109, 1319], 'rare-costume': [784, 988, 1175, 1568],
    };
    const start = context.currentTime;
    notes[kind].forEach((frequency, i) => {
      const oscillator = context.createOscillator(), envelope = context.createGain();
      oscillator.type = kind === 'death' ? 'triangle' : 'sine'; oscillator.frequency.value = frequency;
      const time = start + i * .14;
      envelope.gain.setValueAtTime(0, time); envelope.gain.linearRampToValueAtTime(.5, time + .015); envelope.gain.exponentialRampToValueAtTime(.001, time + .26);
      oscillator.connect(envelope); envelope.connect(gain); this.active.add(oscillator);
      oscillator.onended = () => { this.active.delete(oscillator); oscillator.disconnect(); envelope.disconnect(); if (i === notes[kind].length - 1) gain.disconnect(); };
      oscillator.start(time); oscillator.stop(time + .28);
    });
    return true;
  }
  dispose(): void {
    this.disposed = true;
    for (const source of this.active) { try { source.stop(); } catch { /* already ended */ } }
    this.active.clear(); this.buffers.clear(); this.generation.clear(); this.waiting.clear();
    if (this.context) {
      this.context.onstatechange = null;
      if (this.context.state !== 'closed') void this.context.close();
      this.context = null;
    }
  }
}
