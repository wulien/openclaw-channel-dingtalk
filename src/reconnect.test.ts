import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  computeBackoff,
  resolveReconnectPolicy,
  sleepWithAbort,
  newConnectionId,
  DEFAULT_RECONNECT_POLICY,
  type ReconnectPolicy,
} from "./reconnect.js";

describe("reconnect", () => {
  describe("resolveReconnectPolicy", () => {
    it("should return default policy when no overrides provided", () => {
      const policy = resolveReconnectPolicy();
      expect(policy).toEqual(DEFAULT_RECONNECT_POLICY);
    });

    it("should apply partial overrides to default policy", () => {
      const policy = resolveReconnectPolicy({ initialMs: 5000 });
      expect(policy.initialMs).toBe(5000);
      expect(policy.maxMs).toBe(DEFAULT_RECONNECT_POLICY.maxMs);
      expect(policy.factor).toBe(DEFAULT_RECONNECT_POLICY.factor);
    });

    it("should clamp initialMs to minimum 250ms", () => {
      const policy = resolveReconnectPolicy({ initialMs: 100 });
      expect(policy.initialMs).toBe(250);
    });

    it("should ensure maxMs is at least initialMs", () => {
      const policy = resolveReconnectPolicy({ initialMs: 10000, maxMs: 5000 });
      expect(policy.maxMs).toBeGreaterThanOrEqual(policy.initialMs);
    });

    it("should clamp factor between 1.1 and 10", () => {
      const tooLow = resolveReconnectPolicy({ factor: 0.5 });
      expect(tooLow.factor).toBeGreaterThanOrEqual(1.1);

      const tooHigh = resolveReconnectPolicy({ factor: 20 });
      expect(tooHigh.factor).toBeLessThanOrEqual(10);
    });

    it("should clamp jitter between 0 and 1", () => {
      const negative = resolveReconnectPolicy({ jitter: -0.5 });
      expect(negative.jitter).toBeGreaterThanOrEqual(0);

      const tooHigh = resolveReconnectPolicy({ jitter: 2 });
      expect(tooHigh.jitter).toBeLessThanOrEqual(1);
    });

    it("should floor maxAttempts to integer", () => {
      const policy = resolveReconnectPolicy({ maxAttempts: 5.7 });
      expect(policy.maxAttempts).toBe(5);
    });
  });

  describe("computeBackoff", () => {
    let policy: ReconnectPolicy;

    beforeEach(() => {
      policy = {
        initialMs: 1000,
        maxMs: 10000,
        factor: 2,
        jitter: 0, // No jitter for predictable tests
        maxAttempts: 10,
      };
    });

    it("should return initialMs for attemptNumber 0", () => {
      const delay = computeBackoff(policy, 0);
      expect(delay).toBe(1000);
    });

    it("should return initialMs for attemptNumber 1", () => {
      const delay = computeBackoff(policy, 1);
      expect(delay).toBe(1000);
    });

    it("should apply exponential backoff", () => {
      const attempt2 = computeBackoff(policy, 2);
      const attempt3 = computeBackoff(policy, 3);
      const attempt4 = computeBackoff(policy, 4);

      expect(attempt2).toBe(2000); // 1000 * 2^1
      expect(attempt3).toBe(4000); // 1000 * 2^2
      expect(attempt4).toBe(8000); // 1000 * 2^3
    });

    it("should cap at maxMs", () => {
      const attempt5 = computeBackoff(policy, 5);
      expect(attempt5).toBe(10000); // Capped at maxMs

      const attempt10 = computeBackoff(policy, 10);
      expect(attempt10).toBe(10000); // Still capped
    });

    it("should apply jitter when configured", () => {
      const policyWithJitter = { ...policy, jitter: 0.25 };
      const delays = Array.from({ length: 10 }, () => computeBackoff(policyWithJitter, 2));

      // With jitter, results should vary
      const uniqueValues = new Set(delays);
      expect(uniqueValues.size).toBeGreaterThan(1);

      // All values should be within jitter range of base (2000)
      const base = 2000;
      const jitterAmount = base * 0.25;
      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(base - jitterAmount);
        expect(delay).toBeLessThanOrEqual(base + jitterAmount);
      });
    });

    it("should handle factor 1.8 like WhatsApp default", () => {
      const whatsappPolicy: ReconnectPolicy = {
        initialMs: 2000,
        maxMs: 30000,
        factor: 1.8,
        jitter: 0,
        maxAttempts: 12,
      };

      const attempt1 = computeBackoff(whatsappPolicy, 1);
      const attempt2 = computeBackoff(whatsappPolicy, 2);
      const attempt3 = computeBackoff(whatsappPolicy, 3);

      expect(attempt1).toBe(2000);
      expect(attempt2).toBe(3600); // 2000 * 1.8^1
      expect(attempt3).toBe(6480); // 2000 * 1.8^2
    });

    it("should never return less than initialMs", () => {
      const policyWithJitter = { ...policy, jitter: 0.5 }; // High jitter
      const delays = Array.from({ length: 100 }, () => computeBackoff(policyWithJitter, 2));

      delays.forEach((delay) => {
        expect(delay).toBeGreaterThanOrEqual(policy.initialMs);
      });
    });
  });

  describe("sleepWithAbort", () => {
    it("should resolve after specified milliseconds", async () => {
      const start = Date.now();
      await sleepWithAbort(100);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(elapsed).toBeLessThan(150); // Allow some variance
    });

    it("should reject if signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(sleepWithAbort(100, controller.signal)).rejects.toThrow("Aborted");
    });

    it("should reject when signal is aborted during sleep", async () => {
      const controller = new AbortController();

      const sleepPromise = sleepWithAbort(1000, controller.signal);

      // Abort after 100ms
      setTimeout(() => controller.abort(), 100);

      await expect(sleepPromise).rejects.toThrow("Aborted");
    });

    it("should cleanup timeout on abort", async () => {
      const controller = new AbortController();
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const sleepPromise = sleepWithAbort(1000, controller.signal);

      setTimeout(() => controller.abort(), 50);

      await expect(sleepPromise).rejects.toThrow("Aborted");
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it("should resolve normally without abort signal", async () => {
      const start = Date.now();
      await sleepWithAbort(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe("newConnectionId", () => {
    it("should generate UUID format string", () => {
      const id = newConnectionId();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id).toMatch(uuidRegex);
    });

    it("should generate unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => newConnectionId()));
      expect(ids.size).toBe(100);
    });
  });
});
