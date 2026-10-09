export interface TimestampQueueOptions {
  compactAt?: number;
}

export class TimestampQueue {
  readonly #compactAt: number;
  #head = 0;
  #values: number[] = [];

  constructor(options: TimestampQueueOptions = {}) {
    this.#compactAt = options.compactAt ?? 1024;
  }

  get length(): number {
    return this.#values.length - this.#head;
  }

  oldest(): number | undefined {
    return this.#values[this.#head];
  }

  newest(): number | undefined {
    return this.length === 0 ? undefined : this.#values[this.#values.length - 1];
  }

  push(timestamp: number): void {
    const newest = this.newest();
    if (newest !== undefined && timestamp < newest) {
      throw new Error('timestamps must be monotonic');
    }
    this.#values.push(timestamp);
  }

  prune(cutoff: number): number {
    const startingHead = this.#head;

    while (this.#head < this.#values.length) {
      const timestamp = this.#values[this.#head];
      if (timestamp === undefined || timestamp > cutoff) {
        break;
      }
      this.#head += 1;
    }

    const removed = this.#head - startingHead;
    if (this.#head === this.#values.length) {
      this.#values = [];
      this.#head = 0;
    } else if (
      this.#head >= this.#compactAt &&
      this.#head * 2 >= this.#values.length
    ) {
      this.#values = this.#values.slice(this.#head);
      this.#head = 0;
    }

    return removed;
  }
}
