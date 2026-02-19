import { randomUUID } from "node:crypto";

export type ReconnectPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  maxAttempts: number;
};

export const DEFAULT_HEARTBEAT_SECONDS = 30;
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,      // Initial delay: 2 seconds
  maxMs: 30_000,         // Max delay: 30 seconds
  factor: 1.8,           // Exponential factor: 1.8
  jitter: 0.25,          // Random jitter: 25%
  maxAttempts: 12,       // Max reconnection attempts
};

const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

export function resolveReconnectPolicy(
  overrides?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  const merged = {
    ...DEFAULT_RECONNECT_POLICY,
    ...overrides,
  } as ReconnectPolicy;

  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}

/**
 * Compute exponential backoff delay with jitter
 */
export function computeBackoff(policy: ReconnectPolicy, attemptNumber: number): number {
  if (attemptNumber <= 0) {
    return policy.initialMs;
  }
  const exponential = policy.initialMs * Math.pow(policy.factor, attemptNumber - 1);
  const capped = Math.min(exponential, policy.maxMs);
  const jitterAmount = capped * policy.jitter;
  const jitter = (Math.random() - 0.5) * 2 * jitterAmount;
  return Math.max(policy.initialMs, Math.floor(capped + jitter));
}

/**
 * Sleep with abort signal support
 */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function newConnectionId(): string {
  return randomUUID();
}
