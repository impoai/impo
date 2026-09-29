/** An application error safe to return across the Instant HTTP boundary. */
export class ServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ServiceError';
  }
}

export class LeaseLostError extends Error {
  constructor() { super('Worker no longer owns this job'); this.name = 'LeaseLostError'; }
}
