export type IntegrationErrorCode =
  | 'unsupported_capability' | 'authentication' | 'rate_limited'
  | 'not_found' | 'invalid_payload' | 'unavailable' | 'ambiguous_outcome';

/** Sanitized errors only. Raw provider bodies belong in restricted server storage. */
export class IntegrationError extends Error {
  constructor(readonly code: IntegrationErrorCode, readonly provider: string) {
    super(`Integration ${provider}: ${code}`);
    this.name = 'IntegrationError';
  }
}
