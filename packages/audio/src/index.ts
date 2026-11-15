/**
 * Audio server on the Web Audio API. Sounds are fetched and decoded once per path. Browsers only
 * allow sound after a user gesture, so the context starts suspended and `unlock()` (called on the
 * first key/pointer press) resumes it.
 */
import type { AudioServer, AudioStreamPlayer } from '@gs/core';

export interface AudioAssetUrls {
  url(path: string): string | null;
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

const dbToGain = (db: number) => Math.pow(10, db / 20);

export class WebAudioServer implements AudioServer {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing = new Map<AudioStreamPlayer, Playing>();
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

  play(player: AudioStreamPlayer, fromPosition: number) {
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
      gain.gain.value = dbToGain(player.volumeDb);
      source.connect(gain).connect(ctx.destination);
      source.onended = () => {
        if (this.playing.get(player)?.source !== source) return;
        this.playing.delete(player);
        player.__playing = false;
        player.finished.emit();
      };
      this.playing.set(player, { source, gain });
      source.start(0, Math.max(0, fromPosition));
    });
  }

  stop(player: AudioStreamPlayer) {
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
  }

  update(player: AudioStreamPlayer) {
    const p = this.playing.get(player);
    if (!p) return;
    p.gain.gain.value = dbToGain(player.volumeDb);
    p.source.playbackRate.value = player.pitchScale;
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
