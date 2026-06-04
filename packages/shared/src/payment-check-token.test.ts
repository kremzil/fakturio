import { describe, expect, it } from "vitest";
import {
  createPaymentCheckToken,
  resolvePaymentCheckTransition,
  verifyPaymentCheckToken
} from "./payment-check-token";

const SECRET = "test-secret-at-least-16-chars";
const FUTURE = Date.now() + 60_000;

function baseToken(overrides: Partial<{ caseId: string; organizationId: string; action: "PAID" | "NOT_PAID"; expiresAt: number }> = {}) {
  return createPaymentCheckToken(
    {
      caseId: overrides.caseId ?? "case-1",
      organizationId: overrides.organizationId ?? "org-1",
      action: overrides.action ?? "PAID",
      expiresAt: overrides.expiresAt ?? FUTURE
    },
    SECRET
  );
}

describe("payment-check token", () => {
  it("creates and verifies a valid token", () => {
    const token = baseToken();
    const result = verifyPaymentCheckToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject({
        caseId: "case-1",
        organizationId: "org-1",
        action: "PAID",
        purpose: "payment-check",
        version: 1
      });
    }
  });

  it("rejects a token signed with a different secret", () => {
    const token = baseToken();
    const result = verifyPaymentCheckToken(token, "another-secret-16chars-long");
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const token = baseToken();
    const [payload, signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ version: 1, purpose: "payment-check", caseId: "case-2", organizationId: "org-1", action: "PAID", expiresAt: FUTURE })
    ).toString("base64url");
    const result = verifyPaymentCheckToken(`${tampered}.${signature}`, SECRET);
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(payload).not.toBe(tampered);
  });

  it("rejects an expired token", () => {
    const token = baseToken({ expiresAt: Date.now() - 1000 });
    const result = verifyPaymentCheckToken(token, SECRET);
    expect(result).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("honors an injected clock for expiry", () => {
    const expiresAt = Date.now() + 5_000;
    const token = baseToken({ expiresAt });
    expect(verifyPaymentCheckToken(token, SECRET, { now: expiresAt + 1 })).toEqual({ ok: false, reason: "EXPIRED" });
    expect(verifyPaymentCheckToken(token, SECRET, { now: expiresAt - 1 }).ok).toBe(true);
  });

  it("rejects a caseId mismatch against the bound route", () => {
    const token = baseToken({ caseId: "case-1" });
    const result = verifyPaymentCheckToken(token, SECRET, { expectedCaseId: "case-2" });
    expect(result).toEqual({ ok: false, reason: "CASE_MISMATCH" });
  });

  it("rejects an action mismatch against the bound route", () => {
    const token = baseToken({ action: "PAID" });
    const result = verifyPaymentCheckToken(token, SECRET, { expectedAction: "NOT_PAID" });
    expect(result).toEqual({ ok: false, reason: "ACTION_MISMATCH" });
  });

  it("rejects malformed tokens", () => {
    expect(verifyPaymentCheckToken("not-a-token", SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyPaymentCheckToken("", SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("requires a sufficiently long secret", () => {
    expect(() => createPaymentCheckToken({ caseId: "c", organizationId: "o", action: "PAID", expiresAt: FUTURE }, "short")).toThrow();
  });
});

describe("payment-check state-based idempotency", () => {
  it("PAID closes an active case as CLOSED_PAID", () => {
    expect(resolvePaymentCheckTransition("PAID", "WAITING_FOR_DUE_DATE")).toEqual({ outcome: "APPLY", nextStatus: "CLOSED_PAID" });
    expect(resolvePaymentCheckTransition("PAID", "OVERDUE")).toEqual({ outcome: "APPLY", nextStatus: "CLOSED_PAID" });
  });

  it("PAID is an idempotent no-op when already CLOSED_PAID", () => {
    expect(resolvePaymentCheckTransition("PAID", "CLOSED_PAID")).toEqual({ outcome: "NOOP", currentStatus: "CLOSED_PAID" });
  });

  it("PAID conflicts when the case is closed in a non-paid terminal state", () => {
    expect(resolvePaymentCheckTransition("PAID", "CLOSED_CANCELLED").outcome).toBe("CONFLICT");
    expect(resolvePaymentCheckTransition("PAID", "CLOSED_UNRESOLVED").outcome).toBe("CONFLICT");
  });

  it("NOT_PAID marks a waiting case OVERDUE", () => {
    expect(resolvePaymentCheckTransition("NOT_PAID", "WAITING_FOR_DUE_DATE")).toEqual({ outcome: "APPLY", nextStatus: "OVERDUE" });
    expect(resolvePaymentCheckTransition("NOT_PAID", "DUE_SOON")).toEqual({ outcome: "APPLY", nextStatus: "OVERDUE" });
  });

  it("NOT_PAID is an idempotent no-op when already OVERDUE", () => {
    expect(resolvePaymentCheckTransition("NOT_PAID", "OVERDUE")).toEqual({ outcome: "NOOP", currentStatus: "OVERDUE" });
  });

  it("NOT_PAID conflicts after the case was closed as paid", () => {
    expect(resolvePaymentCheckTransition("NOT_PAID", "CLOSED_PAID").outcome).toBe("CONFLICT");
  });

  it("NOT_PAID does not regress a case that already progressed in collection", () => {
    expect(resolvePaymentCheckTransition("NOT_PAID", "EMAIL_REMINDER_1_SENT")).toEqual({
      outcome: "NOOP",
      currentStatus: "EMAIL_REMINDER_1_SENT"
    });
  });
});
