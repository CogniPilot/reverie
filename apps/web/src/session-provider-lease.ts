/** In-process provider-epoch evidence. Neither JSON nor a matching SID can create a lease. */
class ProviderLease {
  #owner: object;
  #current: () => boolean;
  #account: string | undefined;
  #epoch: number | symbol;
  constructor(owner: object, current: () => boolean, account: string | undefined, epoch: number | symbol) {
    this.#owner = owner;
    this.#epoch = epoch;
    this.#current = current;
    this.#account = account;
    Object.freeze(this);
  }
  sameEpoch(other: ProviderLease): boolean {return this.#owner === other.#owner && this.#epoch === other.#epoch && this.#account === other.#account;}
  originalOwner(): {owner: string | undefined} {return {owner: this.#account};}
  current(owner: object = this.#owner): boolean {return owner === this.#owner && this.#current();}
}
export type SessionProviderLease = ProviderLease;
export function issueSessionProviderLease(owner: object, current: () => boolean, account?: string, epoch: number | symbol = Symbol('provider-epoch')): SessionProviderLease {
  return new ProviderLease(owner, current, account, epoch);
}
export function sessionProviderLeaseCurrent(lease: unknown, owner?: object): boolean {
  return lease instanceof ProviderLease && lease.current(owner);
}

/** Original account evidence stays in process and is never copied to a public item. */
export function sessionProviderLeaseOwner(lease: unknown): {owner: string | undefined} | undefined {
  return lease instanceof ProviderLease ? lease.originalOwner() : undefined;
}

/** Private epoch equality never treats a new HTTP report as fresh consent. */
export function sessionProviderLeaseSameEpoch(first: unknown, second: unknown): boolean {
  return first instanceof ProviderLease && second instanceof ProviderLease && first.sameEpoch(second);
}
