/** One in-process claim owner. Unknown effects never become safe merely with time. */
export class LaunchReservation {
  #state: 'active' | 'dispatching' | 'unconfirmed' | 'released' = 'active';
  constructor(private readonly expiresAt: number) {}
  blocks(now: number): boolean {
    return this.#state === 'dispatching' || this.#state === 'unconfirmed' || (this.#state === 'active' && this.expiresAt > now);
  }
  beginDispatch(): boolean {
    if (this.#state !== 'active') return false;
    this.#state = 'dispatching';
    return true;
  }
  retainUnconfirmed(): void {
    if (this.#state === 'active' || this.#state === 'dispatching') this.#state = 'unconfirmed';
  }
  release(): boolean {
    if (this.#state !== 'active' && this.#state !== 'dispatching') return false;
    this.#state = 'released';
    return true;
  }
  owns<K>(map: ReadonlyMap<K, LaunchReservation>, key: K): boolean {return map.get(key) === this;}
  /** A predecessor must never remove or replace a successor's reservation. */
  removeOwned<K>(map: Map<K, LaunchReservation>, key: K): void {
    if (this.owns(map, key)) map.delete(key);
  }
}
