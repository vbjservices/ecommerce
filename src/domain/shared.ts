/** Internal UUIDs; external identifiers always live in explicit mapping fields. */
export type Id = string;
export type Timestamp = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Decimal strings avoid floating-point money arithmetic. Unknown is null. */
export interface Money { amount: string; currency: string }
export interface Observation<T> {
  value: T | null;
  source: string;
  retrievedAt: Timestamp;
}
