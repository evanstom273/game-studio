/**
 * Typed signals (Godot's observer pattern). Declare one per event on a class:
 *
 *   readonly hit = new Signal<[damage: number]>();
 *   enemy.hit.connect((damage) => …);
 *   this.hit.emit(10);
 *
 * Listeners that throw are reported through `Signal.onError` and never stop the others.
 */
export type Listener<A extends unknown[]> = (...args: A) => void;

interface Connection<A extends unknown[]> {
  fn: Listener<A>;
  once: boolean;
  owner?: object;
}

export class Signal<A extends unknown[] = []> {
  /** Global hook for listener errors (the runtime routes these to the console panel). */
  static onError: (error: unknown, signal: Signal<never>) => void = (e) => console.error(e);

  private connections: Connection<A>[] = [];

  constructor(readonly name = '') {}

  /** Connects a listener. `owner` lets `disconnectAll(owner)` remove every listener a node added. Returns a disconnect function. */
  connect(fn: Listener<A>, opts: { once?: boolean; owner?: object } = {}): () => void {
    this.connections.push({ fn, once: !!opts.once, owner: opts.owner });
    return () => this.disconnect(fn);
  }

  once(fn: Listener<A>, owner?: object) {
    return this.connect(fn, { once: true, owner });
  }

  disconnect(fn: Listener<A>) {
    const i = this.connections.findIndex((c) => c.fn === fn);
    if (i >= 0) this.connections.splice(i, 1);
  }

  disconnectAll(owner?: object) {
    this.connections = owner === undefined ? [] : this.connections.filter((c) => c.owner !== owner);
  }

  isConnected(fn: Listener<A>) {
    return this.connections.some((c) => c.fn === fn);
  }

  get listenerCount() {
    return this.connections.length;
  }

  emit(...args: A) {
    if (!this.connections.length) return;
    const list = this.connections.slice();
    this.connections = this.connections.filter((c) => !c.once);
    for (const c of list) {
      try {
        c.fn(...args);
      } catch (e) {
        Signal.onError(e, this as unknown as Signal<never>);
      }
    }
  }
}
