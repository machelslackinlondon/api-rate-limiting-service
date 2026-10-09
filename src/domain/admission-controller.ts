import { OverloadedError } from './errors';

export class AdmissionController {
  #inFlight = 0;

  constructor(readonly maxInFlight: number) {}

  get inFlight(): number {
    return this.#inFlight;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.maxInFlight) {
      throw new OverloadedError();
    }

    this.#inFlight += 1;
    try {
      return await operation();
    } finally {
      this.#inFlight -= 1;
    }
  }
}
