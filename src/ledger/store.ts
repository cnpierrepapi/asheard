/**
 * Where intents live.
 *
 * The interface is the contract; the in-memory version is here so tests and the
 * fixture demo run with nothing installed. A real deployment swaps in Postgres
 * or SQLite behind the same four methods.
 *
 * One thing the interface enforces and an implementation must not relax:
 * `reserve` is keyed on the idempotency key, so reserving the same authorized
 * action twice hands back the record that already exists instead of making a
 * second one. That is the whole point of the key.
 */

import { randomUUID } from "node:crypto";

import {
  type Authorization,
  type Channel,
  type Intent,
  type IntentState,
  type RecoverySecret,
  assertTransition,
  deriveIdempotencyKey,
} from "./intent.js";

export interface IntentStore {
  /** Create the record, or return the existing one for the same key. */
  reserve(auth: Authorization, channel: Channel): Promise<Intent>;
  get(id: string): Promise<Intent | null>;
  findByKey(idempotencyKey: string): Promise<Intent | null>;
  /** Move state and optionally bind an id or record why a human is needed. */
  advance(
    id: string,
    to: IntentState,
    patch?: { boundId?: string; reasons?: string[] },
  ): Promise<Intent>;
  /** Stash the private pair that can recover an ambiguous submission. */
  putRecoverySecret(id: string, secret: RecoverySecret): Promise<void>;
  /**
   * Take the secret back out. Deliberately separate from `get`, so a routine
   * read of an intent can never leak a confirm token into a log or a response.
   */
  takeRecoverySecret(id: string): Promise<RecoverySecret | null>;
}

export class MemoryIntentStore implements IntentStore {
  private readonly byId = new Map<string, Intent>();
  private readonly byKey = new Map<string, string>();
  private readonly secrets = new Map<string, RecoverySecret>();

  async reserve(auth: Authorization, channel: Channel): Promise<Intent> {
    const idempotencyKey = deriveIdempotencyKey(auth, channel);
    const existingId = this.byKey.get(idempotencyKey);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (existing) return structuredClone(existing);
    }

    const now = new Date().toISOString();
    const intent: Intent = {
      id: `int_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      idempotencyKey,
      channel,
      authorization: { ...auth },
      state: "reserved",
      boundId: null,
      reasons: [],
      createdAt: now,
      updatedAt: now,
    };

    this.byId.set(intent.id, intent);
    this.byKey.set(idempotencyKey, intent.id);
    return structuredClone(intent);
  }

  async get(id: string): Promise<Intent | null> {
    const found = this.byId.get(id);
    return found ? structuredClone(found) : null;
  }

  async findByKey(idempotencyKey: string): Promise<Intent | null> {
    const id = this.byKey.get(idempotencyKey);
    return id ? this.get(id) : null;
  }

  async advance(
    id: string,
    to: IntentState,
    patch: { boundId?: string; reasons?: string[] } = {},
  ): Promise<Intent> {
    const current = this.byId.get(id);
    if (!current) throw new Error(`No intent ${id}.`);

    assertTransition(current.state, to);

    if (patch.boundId && current.boundId && patch.boundId !== current.boundId) {
      throw new Error(
        `Intent ${id} is already bound to ${current.boundId} and cannot be rebound to ${patch.boundId}.`,
      );
    }

    const next: Intent = {
      ...current,
      state: to,
      boundId: patch.boundId ?? current.boundId,
      reasons: patch.reasons ?? current.reasons,
      updatedAt: new Date().toISOString(),
    };

    this.byId.set(id, next);
    return structuredClone(next);
  }

  async putRecoverySecret(id: string, secret: RecoverySecret): Promise<void> {
    if (!this.byId.has(id)) throw new Error(`No intent ${id}.`);
    this.secrets.set(id, { ...secret });
  }

  async takeRecoverySecret(id: string): Promise<RecoverySecret | null> {
    const secret = this.secrets.get(id);
    return secret ? { ...secret } : null;
  }
}
