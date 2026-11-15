/** Nodes that are neither 2D nor 3D: timers and audio. */
import { Signal } from '@gs/shared';
import { Node } from './node';
import type { AudioStream } from './resources';

export class Timer extends Node {
  static override readonly typeName: string = 'Timer';
  waitTime = 1;
  oneShot = false;
  autostart = false;
  /** Run on physics ticks instead of frames. */
  processCallback: 'idle' | 'physics' = 'idle';
  paused = false;
  readonly timeout = new Signal<[]>('timeout');
  private left = 0;
  private running = false;

  get timeLeft() {
    return this.running ? this.left : 0;
  }

  start(seconds?: number) {
    if (seconds !== undefined && seconds > 0) this.waitTime = seconds;
    this.left = this.waitTime;
    this.running = true;
  }
  stop() {
    this.running = false;
    this.left = 0;
  }
  isStopped() {
    return !this.running;
  }

  override __ready() {
    super.__ready();
    if (this.autostart) this.start();
  }
  override __process(delta: number) {
    if (this.processCallback === 'idle') this.tick(delta);
  }
  /** @internal called by the tree on physics ticks */
  __physicsTick(delta: number) {
    if (this.processCallback === 'physics') this.tick(delta);
  }

  private tick(delta: number) {
    if (!this.running || this.paused) return;
    this.left -= delta;
    if (this.left > 1e-9) return;
    if (this.oneShot) {
      this.running = false;
      this.left = 0;
    } else this.left += Math.max(this.waitTime, 1e-3);
    this.timeout.emit();
  }
}

/** The audio contract; implemented by packages/audio (Web Audio). */
export interface AudioServer {
  play(player: AudioStreamPlayer, fromPosition: number): void;
  stop(player: AudioStreamPlayer): void;
  update(player: AudioStreamPlayer): void;
  dispose(): void;
}

/** Plays a sound or music track (not positional). */
export class AudioStreamPlayer extends Node {
  static override readonly typeName: string = 'AudioStreamPlayer';
  stream: AudioStream | null = null;
  volumeDb = 0;
  pitchScale = 1;
  autoplay = false;
  loop = false;
  readonly finished = new Signal<[]>('finished');
  /** @internal set by the audio server */
  __playing = false;

  get playing() {
    return this.__playing;
  }

  play(fromPosition = 0) {
    if (!this.stream) return;
    if (this.tree?.audio) this.tree.audio.play(this, fromPosition);
  }
  stop() {
    this.tree?.audio?.stop(this);
  }
  override __ready() {
    super.__ready();
    if (this.autoplay) this.play();
  }
  override __exitTree() {
    this.stop();
    super.__exitTree();
  }
}
