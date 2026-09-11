/**
 * The ceiling on a demo that dials real phones.
 *
 * This page places actual calls on somebody's actual account, which has a
 * finite balance. Without a cap the first person to hold down a key spends the
 * lot, and the demo is dead for everyone after them.
 *
 * So the cap is checked before the call, not after, and it fails closed. If the
 * counter cannot be read the answer is no. A demo that quietly keeps dialling
 * when its own limiter is broken is worse than a demo that is briefly down.
 */

import { pipeline, redisConfigured } from "./redis";

/** How many demo calls may go out in one day, across everybody. */
export const DAILY_CALL_CAP = Number(process.env.DEMO_DAILY_CALL_CAP ?? 40);

/** How many a single visitor may place in one day. */
export const PER_VISITOR_CAP = Number(process.env.DEMO_VISITOR_CALL_CAP ?? 3);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Plain sentence for the UI. Present only when `allowed` is false. */
  reason?: string;
  /** What is left today across everybody, when it can be read. */
  remainingToday?: number;
}

function asCount(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * Take one call off the budget, or refuse.
 *
 * The increments happen before the call is placed and are not given back if the
 * call fails. That is on purpose: a failed attempt still costs the account, and
 * a limiter that refunds errors is a limiter somebody can beat by causing them.
 */
export async function spendOne(visitorId: string): Promise<BudgetVerdict> {
  if (!redisConfigured()) {
    return {
      allowed: false,
      reason: "The demo is not wired to its counter right now, so it will not place a call.",
    };
  }

  const day = today();
  const globalKey = `demo:calls:${day}`;
  const visitorKey = `demo:calls:${day}:${visitorId}`;

  try {
    const [globalCount, , visitorCount] = await pipeline([
      ["INCR", globalKey],
      ["EXPIRE", globalKey, "172800"],
      ["INCR", visitorKey],
      ["EXPIRE", visitorKey, "172800"],
    ]);

    const used = asCount(globalCount);
    const mine = asCount(visitorCount);

    // Every attempt counts, refused or not, so a held-down button cannot dig
    // past the cap. The wording says attempts for that reason: saying "calls"
    // here claimed calls had gone out when some had been refused.
    if (mine > PER_VISITOR_CAP) {
      return {
        allowed: false,
        reason: `You've hit today's limit of ${PER_VISITOR_CAP} call attempts from here, so nothing was dialled. The briefing and the paste page still work without placing a call.`,
      };
    }
    if (used > DAILY_CALL_CAP) {
      return {
        allowed: false,
        reason:
          "Today's demo call attempts have all been used, so nothing was dialled. The briefing and the paste page still work without placing a call.",
      };
    }

    return { allowed: true, remainingToday: Math.max(0, DAILY_CALL_CAP - used) };
  } catch {
    // Fail closed. Not knowing the count is not permission to dial.
    return {
      allowed: false,
      reason: "The demo could not check its own call budget, so it did not place a call.",
    };
  }
}
