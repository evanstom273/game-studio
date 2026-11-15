/**
 * Audio server on the Web Audio API. Sounds are fetched and decoded once per path. Browsers only
 * allow sound after a user gesture, so the context starts suspended and `unlock()` (called on the
 * first key/pointer press) resumes it.
 *
 * Positional players (AudioStreamPlayer2D/3D) report a volume and stereo pan for the current
 * listener (`getSpatialMix`); they get a StereoPannerNode and are updated every frame they play.
 */
import type { AudioPlayback, AudioServer } from '@gs/core';

export interface AudioAssetUrls {
  url(path: string): string | null;
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
}

/** Smooths parameter changes so moving sounds don't click ("zipper noise"). */
const SMOOTHING = 0.03;

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class WebAudioServer implements AudioServer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing = new Map<AudioPlayback, Playing>();
  /** Reports decode failures. */
  onError: ((message: string) => void) | null = null;

  constructor(private readonly assets: AudioAssetUrls) {}

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  /** Resume after a user gesture (autoplay policy). */
  unlock() {
    const ctx = this.context();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  private buffer(path: string) {
    let p = this.buffers.get(path);
    if (!p) {
      p = (async () => {
        const ctx = this.context();
        const url = this.assets.url(path);
        if (!ctx || !url) return null;
        try {
          const data = await (await fetch(url)).arrayBuffer();
          return await ctx.decodeAudioData(data);
        } catch (e) {
          this.onError?.(`Could not decode audio "${path}": ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      })();
      this.buffers.set(path, p);
    }
    return p;
  }

  /** Volume (linear) and pan for a player right now. */
  private mix(player: AudioPlayback) {
    const spatial = player.getSpatialMix?.();
    const gain = dbToGain(player.volumeDb) * (spatial ? Math.max(0, spatial.gain) : 1);
    return { gain: Number.isFinite(gain) ? gain : 0, pan: spatial ? Math.max(-1, Math.min(1, spatial.pan || 0)) : null };
  }

  play(player: AudioPlayback, fromPosition: number) {
    const path = player.stream?.resourcePath;
    if (!path) return;
    this.stop(player);
    player.__playing = true;
    void this.buffer(path).then((buf) => {
      const ctx = this.ctx;
      if (!buf || !ctx || !player.__playing || !player.isInsideTree()) {
        player.__playing = false;
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buf;
      source.loop = player.loop;
      source.playbackRate.value = player.pitchScale;
      const gain = ctx.createGain();
      const m = this.mix(player);
      gain.gain.value = m.gain;
      let panner: StereoPannerNode | null = null;
      if (player.getSpatialMix && typeof ctx.createStereoPanner === 'function') {
        panner = ctx.createStereoPanner();
        panner.pan.value = m.pan ?? 0;
        source.connect(gain).connect(panner).connect(ctx.destination);
      } else source.connect(gain).connect(ctx.destination);
      source.onended = () => {
        if (this.playing.get(player)?.source !== source) return;
        this.playing.delete(player);
        player.__playing = false;
        player.finished.emit();
      };
      this.playing.set(player, { source, gain, panner });
      source.start(0, Math.max(0, fromPosition));
    });
  }

  stop(player: AudioPlayback) {
    const p = this.playing.get(player);
    player.__playing = false;
    if (!p) return;
    this.playing.delete(player);
    try {
      p.source.stop();
    } catch {
      /* not started */
    }
    p.source.disconnect();
    p.panner?.disconnect();
  }

  update(player: AudioPlayback) {
    const p = this.playing.get(player);
    const ctx = this.ctx;
    if (!p || !ctx) return;
    const m = this.mix(player);
    const t = ctx.currentTime;
    if (Math.abs(p.gain.gain.value - m.gain) > 1e-4) p.gain.gain.setTargetAtTime(m.gain, t, SMOOTHING);
    if (p.panner && m.pan !== null && Math.abs(p.panner.pan.value - m.pan) > 1e-4) p.panner.pan.setTargetAtTime(m.pan, t, SMOOTHING);
    if (p.source.playbackRate.value !== player.pitchScale) p.source.playbackRate.value = player.pitchScale;
    p.source.loop = player.loop;
  }

  /** Pause/resume all sound (game pause, tab hidden). */
  setSuspended(suspended: boolean) {
    if (!this.ctx) return;
    void (suspended ? this.ctx.suspend() : this.ctx.resume());
  }

  dispose() {
    for (const pl of [...this.playing.keys()]) this.stop(pl);
    void this.ctx?.close();
    this.ctx = null;
  }
}
