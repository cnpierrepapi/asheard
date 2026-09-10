import { readFileSync } from "node:fs";

/**
 * A thin client over the CALL-E Calls API.
 *
 * Deliberately not the published SDK. The docs pin `@call-e/calle@0.2.2` while
 * npm actually ships 0.7.0, and both SDK source repositories the docs link to
 * return 404, so there is no way to read what the installed version does. Until
 * that is sorted out, fetch against the documented HTTP contract is the thing
 * we can actually reason about.
 *
 * Nothing here decides to place a call. The caller does that, and the ledger
 * has to have reserved the intent first.
 */

export interface CalleConfig {
  /**
   * Send the key somewhere other than the approved origin. Off by default, and
   * plain HTTP is refused regardless unless the host is loopback.
   */
  allowUnapprovedBaseUrl?: boolean;
  apiKey: string;
  baseUrl?: string;
}

export interface CreateCallRequest {
  task: string;
  recipients?: Array<{ phones: string[]; region?: string; locale?: string }>;
  result_schema?: Record<string, unknown>;
  recipient_result_schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
}

export interface CompletionConfidence {
  score: number;
  label: string;
}

export interface CallTaskRecipient {
  id?: string;
  phones?: string[];
  region?: string;
  locale?: string;
  status?: string;
  structured_result?: Record<string, unknown> | null;
  summary?: string | null;
  attempts?: Array<{
    id?: string;
    phone?: string;
    status?: string;
    failure_code?: string | null;
    failure_message?: string | null;
    transcript_turns?: Array<{ offset_seconds?: number; speaker?: string; text?: string }>;
  }>;
}

export interface CallTask {
  id: string;
  object?: string;
  status: string;
  task?: string;
  structured_result?: Record<string, unknown> | null;
  summary?: string | null;
  task_completed?: boolean | null;
  completion_confidence?: CompletionConfidence | null;
  evidence?: string[] | null;
  recipients?: CallTaskRecipient[] | null;
  failure_code?: string | null;
  failure_message?: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export class CalleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details: unknown) {
    super(`${code}: ${message}`);
    this.name = "CalleApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** The only origin this client will send a key to without being told twice. */
export const APPROVED_BASE_URL = "https://api.heycall-e.com";

/**
 * Decide where the key is allowed to go.
 *
 * Every request from this client carries `Authorization: Bearer <your key>`, so
 * whoever controls the base URL controls where your key ends up. A client that
 * quietly posts credentials to any string handed to it is a footgun, and the
 * fix costs nothing: default to the real origin, refuse plaintext outright, and
 * make anything else an explicit decision the caller has to write down.
 *
 * `allowUnapprovedBaseUrl` exists for a local fake server during development.
 * It still refuses plain HTTP unless the host is loopback, because a key sent
 * unencrypted over a network is gone whatever the host was.
 */
export function resolveBaseUrl(candidate: string | undefined, allowUnapproved: boolean): string {
  if (candidate === undefined || candidate === "") return APPROVED_BASE_URL;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`baseUrl is not a URL: ${candidate}`);
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(
      `Refusing to send an API key over ${url.protocol}//. Use https, or a loopback host for a local fake server.`,
    );
  }

  const trimmed = candidate.replace(/\/+$/, "");
  if (trimmed === APPROVED_BASE_URL) return trimmed;

  if (!allowUnapproved) {
    throw new Error(
      `Refusing to send an API key to ${url.origin}. Pass allowUnapprovedBaseUrl: true if you meant it.`,
    );
  }
  return trimmed;
}

export class CalleClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: CalleConfig) {
    if (!config.apiKey) throw new Error("A CALL-E API key is required.");
    this.apiKey = config.apiKey;
    this.baseUrl = resolveBaseUrl(config.baseUrl, config.allowUnapprovedBaseUrl === true);
  }

  private async request<T>(
    path: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string; details?: unknown } })
        .error;
      throw new CalleApiError(
        response.status,
        error?.code ?? "unknown",
        error?.message ?? response.statusText,
        error?.details ?? null,
      );
    }

    return body as T;
  }

  /**
   * Check the key without doing anything.
   *
   * Reads a call id that cannot exist. A documented 404 means the key was
   * accepted and no call was created; 401 or 403 mean the key is the problem.
   * The Dify plugin CALL-E ships uses the same probe.
   */
  async verifyCredentials(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.getCall("call_asheard_credential_probe_00000000000000");
      return { ok: true, detail: "The probe id unexpectedly exists, but the key was accepted." };
    } catch (error) {
      if (error instanceof CalleApiError) {
        if (error.code === "not_found") {
          return { ok: true, detail: "Key accepted. No call was created." };
        }
        return { ok: false, detail: `${error.code}: ${error.message}` };
      }
      throw error;
    }
  }

  /** Place a call. This rings a real phone. */
  async createCall(request: CreateCallRequest, idempotencyKey: string): Promise<CallTask> {
    return this.request<CallTask>("/v1/calls", {
      method: "POST",
      body: JSON.stringify(request),
      idempotencyKey,
    });
  }

  async getCall(callId: string): Promise<CallTask> {
    return this.request<CallTask>(`/v1/calls/${encodeURIComponent(callId)}`);
  }

  async listEvents(callId: string, limit = 50): Promise<{ data: unknown[] }> {
    return this.request(`/v1/calls/${encodeURIComponent(callId)}/events?limit=${limit}`);
  }

  /**
   * Poll until the call reaches a terminal status.
   *
   * A timeout here stops the polling, not the call. The MCP guide makes the
   * same point and it is just as true over HTTP: giving up on watching is not
   * the same as the call ending, so this throws a named error the caller can
   * tell apart from a failure.
   */
  async waitForResult(
    callId: string,
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      onPoll?: (call: CallTask) => void;
      /**
       * Keep reading after the status goes terminal until a structured result
       * turns up.
       *
       * Terminal does not mean finished. Most calls carry `structured_result`
       * the moment the status goes terminal, and now and then one comes back
       * null and has it filled in later. Same endpoint, same shape of call, different answer.
       *
       * So a client that reads once on the terminal status gets the result
       * most of the time, which is the worst possible failure rate. It looks
       * solid in testing and drops a result in production now and then.
       *
       * Only pass this when a result schema was actually sent. A call that
       * never asked for a result will wait out the whole window for something
       * that was never coming.
       */
      settleForResult?: boolean;
      /** How long to keep reading after terminal. */
      settleMs?: number;
    } = {},
  ): Promise<{ call: CallTask; settledAfterMs: number }> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const intervalMs = options.intervalMs ?? 5_000;
    const settleMs = options.settleMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    let terminal: CallTask | null = null;

    for (;;) {
      const call = await this.getCall(callId);
      options.onPoll?.(call);
      if (isTerminal(call.status)) {
        terminal = call;
        break;
      }

      if (Date.now() >= deadline) {
        const error = new Error(
          `Stopped watching ${callId} after ${timeoutMs}ms. The call has not ended; it is still running.`,
        );
        error.name = "WatchTimeoutError";
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (!options.settleForResult || terminal.structured_result != null) {
      return { call: terminal, settledAfterMs: 0 };
    }

    const settleStart = Date.now();
    const settleDeadline = settleStart + settleMs;

    while (Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      const call = await this.getCall(callId);
      options.onPoll?.(call);
      if (call.structured_result != null) {
        return { call, settledAfterMs: Date.now() - settleStart };
      }
      terminal = call;
    }

    // Nothing turned up. Hand back what the call actually says rather than
    // waiting forever, and let the caller record that the wait was spent.
    return { call: terminal, settledAfterMs: Date.now() - settleStart };
  }
}

/**
 * Pull one named key out of a plain KEY=VALUE file.
 *
 * Reads it at the moment of use and hands back only the one line asked for, so
 * a file holding several unrelated secrets never gets loaded into the process
 * wholesale or written anywhere near the repo.
 */
export function readKeyFromEnvFile(path: string, match: string): string {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes(match)) continue;
    const value = line.includes("=") ? line.slice(line.indexOf("=") + 1) : line;
    return value.trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`No line containing "${match}" in ${path}.`);
}
