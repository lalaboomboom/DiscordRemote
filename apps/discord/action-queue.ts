/** Serializes one terminal/channel while allowing independent diagnostics. */
export class ActionQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const task = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = task.catch(() => {});
    this.tails.set(key, tail);
    void tail.finally(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return task;
  }
}
