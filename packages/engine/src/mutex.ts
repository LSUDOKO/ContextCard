// Keyed async mutex: serializes budget-debiting sections per card TREE (root id),
// so concurrent tool calls can't double-pass a budget check. Tail-chaining: each
// caller appends to the key's promise chain, so N concurrent callers run strictly
// one at a time. Unchanged from GlassPay — the race it closes is identical
// (read-then-write on the ledger).

export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** Run fn exclusively for `key`; concurrent callers queue on the same key. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    this.tails.set(key, prev.then(() => tail));
    await prev.catch(() => {}); // wait our turn (a rejected predecessor must not break us)
    try {
      return await fn();
    } finally {
      release();
      // drop the key when its chain drains (no more queued callers)
      if (this.tails.get(key) === prev.then(() => tail)) this.tails.delete(key);
    }
  }
}
