/**
 * Positional audio: players whose volume and stereo position follow where they are relative to
 * the listener (the 2D camera's screen centre, or the current Camera3D). The maths is here, in
 * core, so it is tested headless; packages/audio applies the result with Web Audio gain/pan nodes.
 */
import { Signal, Vector2, Vector3, clamp } from '@gs/shared';
import { Node2D } from './nodes2d';
import { Node3D } from './nodes3d';
import type { AudioPlayback } from './nodes-misc';
import type { AudioStream } from './resources';

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** Godot's 2D falloff: full volume at the listener, silent at `maxDistance`; `attenuation` is the curve's exponent. */
export function attenuation2D(distance: number, maxDistance: number, attenuation: number): number {
  if (maxDistance <= 0) return 1;
  const k = clamp(1 - distance / maxDistance, 0, 1);
  return k === 0 ? 0 : Math.pow(k, Math.max(0.01, attenuation));
}

export type AttenuationModel = 'inverse' | 'inverseSquare' | 'logarithmic' | 'disabled';

/** Godot's 3D distance attenuation in decibels (0 dB at `unitSize` metres, louder closer, quieter further). */
export function attenuationDb3D(distance: number, model: AttenuationModel, unitSize: number): number {
  const d = Math.max(distance, 1e-4) / Math.max(unitSize, 1e-4);
  switch (model) {
    case 'inverse':
      return -20 * Math.log10(d);
    case 'inverseSquare':
      return -40 * Math.log10(d);
    case 'logarithmic':
      // Godot uses the natural logarithm here: a steeper falloff than "inverse".
      return -20 * Math.log(d + 1e-5);
    case 'disabled':
      return 0;
  }
}

/** A sound placed in the 2D world: quieter further from the camera, panned left/right. */
export class AudioStreamPlayer2D extends Node2D implements AudioPlayback {
  static override readonly typeName: string = 'AudioStreamPlayer2D';
  stream: AudioStream | null = null;
  volumeDb = 0;
  pitchScale = 1;
  autoplay = false;
  loop = false;
  /** Silent beyond this many pixels from the listener. */
  maxDistance = 2000;
  /** Falloff curve exponent (1 = linear, higher = drops faster). */
  attenuation = 1;
  /** How strongly the position pans the sound (0 = centred). */
  panningStrength = 1;
  readonly finished = new Signal<[]>('finished');
  /** @internal set by the audio server */
  __playing = false;

  get playing() {
    return this.__playing;
  }
  play(fromPosition = 0) {
    if (this.stream) this.tree?.audio?.play(this, fromPosition);
  }
  stop() {
    this.tree?.audio?.stop(this);
  }

  /** The listener: the current camera's screen centre, or the middle of the viewport without one. */
  getListenerPosition(): Vector2 {
    const tree = this.tree;
    if (!tree) return this.globalPosition;
    const cam = tree.currentCamera2D;
    if (cam && cam.isInsideTree() && cam.enabled) return cam.getScreenCenterPosition();
    return tree.canvasTransform.invert().apply(tree.viewportSize.scale(0.5));
  }

  getSpatialMix() {
    const rel = this.globalPosition.sub(this.getListenerPosition());
    const halfWidth = Math.max(1, (this.tree?.viewportSize.x ?? 1152) / 2);
    return { gain: attenuation2D(rel.length(), this.maxDistance, this.attenuation), pan: clamp(rel.x / halfWidth, -1, 1) * clamp(this.panningStrength, 0, 1) };
  }

  override __ready() {
    super.__ready();
    if (this.autoplay) this.play();
  }
  override __process(delta: number) {
    super.__process(delta);
    if (this.__playing) this.tree?.audio?.update(this);
  }
  override __exitTree() {
    this.stop();
    super.__exitTree();
  }
}

/** A sound placed in the 3D world: attenuated with distance from the current camera and panned. */
export class AudioStreamPlayer3D extends Node3D implements AudioPlayback {
  static override readonly typeName: string = 'AudioStreamPlayer3D';
  stream: AudioStream | null = null;
  volumeDb = 0;
  pitchScale = 1;
  autoplay = false;
  loop = false;
  attenuationModel: AttenuationModel = 'inverse';
  /** Distance (metres) at which the sound plays at its normal volume. */
  unitSize = 10;
  /** Loudest it gets when close, in dB. */
  maxDb = 3;
  /** Silent beyond this distance (0 = no limit). */
  maxDistance = 0;
  panningStrength = 1;
  readonly finished = new Signal<[]>('finished');
  /** @internal set by the audio server */
  __playing = false;

  get playing() {
    return this.__playing;
  }
  play(fromPosition = 0) {
    if (this.stream) this.tree?.audio?.play(this, fromPosition);
  }
  stop() {
    this.tree?.audio?.stop(this);
  }

  getSpatialMix() {
    const cam = this.tree?.currentCamera3D;
    if (!cam || !cam.isInsideTree()) return { gain: 1, pan: 0 };
    const rel = this.globalPosition.sub(cam.globalPosition);
    const dist = rel.length();
    if (this.maxDistance > 0 && dist > this.maxDistance) return { gain: 0, pan: 0 };
    const db = Math.min(attenuationDb3D(dist, this.attenuationModel, this.unitSize), this.maxDb);
    const right: Vector3 = cam.getRight();
    const pan = dist > 1e-6 ? clamp(rel.scale(1 / dist).dot(right), -1, 1) * clamp(this.panningStrength, 0, 1) : 0;
    return { gain: dbToGain(db), pan };
  }

  override __ready() {
    super.__ready();
    if (this.autoplay) this.play();
  }
  override __process(delta: number) {
    super.__process(delta);
    if (this.__playing) this.tree?.audio?.update(this);
  }
  override __exitTree() {
    this.stop();
    super.__exitTree();
  }
}
