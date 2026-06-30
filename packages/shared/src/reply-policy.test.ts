import { describe, expect, it } from "vitest";
import {
  calculateInstallmentSchedule,
  decideDebtorReply
} from "./reply-policy";

const receivedAt = new Date("2026-06-11T10:00:00.000Z");

describe("debtor reply policy", () => {
  it("caps a promise at ten calendar days and only accepts one extension", () => {
    expect(
      decideDebtorReply({
        classification: classification({
          intent: "PROMISED_TO_PAY",
          promisedPaymentDate: "2026-07-20"
        }),
        senderMatchesDebtor: true,
        automated: false,
        clarificationCount: 0,
        promiseExtensionUsed: false,
        receivedAt,
        hasProposedInstallmentPlan: false,
        expectedAmount: 100
      })
    ).toMatchObject({
      kind: "ACCEPT_PROMISE",
      paymentDate: new Date("2026-06-21T00:00:00.000Z")
    });

    expect(
      decideDebtorReply({
        classification: classification({ intent: "PROMISED_TO_PAY" }),
        senderMatchesDebtor: true,
        automated: false,
        clarificationCount: 0,
        promiseExtensionUsed: true,
        receivedAt,
        hasProposedInstallmentPlan: false,
        expectedAmount: 100
      })
    ).toEqual({ kind: "KEEP_EXISTING_DEADLINE" });
  });

  it("requires explicit acceptance of an existing installment proposal", () => {
    const base = {
      senderMatchesDebtor: true,
      automated: false,
      promiseExtensionUsed: false,
      receivedAt,
      hasProposedInstallmentPlan: true,
      expectedAmount: 100
    };
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({
          intent: "INSTALLMENT_ACCEPTED",
          explicitInstallmentAcceptance: true
        }),
        clarificationCount: 0
      })
    ).toEqual({ kind: "ACTIVATE_INSTALLMENT" });
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({
          intent: "INSTALLMENT_ACCEPTED",
          explicitInstallmentAcceptance: false
        }),
        clarificationCount: 0
      })
    ).toEqual({ kind: "REQUEST_CLARIFICATION" });
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({
          intent: "INSTALLMENT_ACCEPTED",
          explicitInstallmentAcceptance: false
        }),
        clarificationCount: 1
      })
    ).toEqual({ kind: "PAUSE_UNCLEAR" });
  });

  it("asks once for clarification and then pauses", () => {
    const lowConfidence = classification({
      intent: "PAID",
      confidence: 0.5
    });
    const base = {
      classification: lowConfidence,
      senderMatchesDebtor: true,
      automated: false,
      promiseExtensionUsed: false,
      receivedAt,
      hasProposedInstallmentPlan: false,
      expectedAmount: 100
    };
    expect(decideDebtorReply({ ...base, clarificationCount: 0 })).toEqual({
      kind: "REQUEST_CLARIFICATION"
    });
    expect(decideDebtorReply({ ...base, clarificationCount: 1 })).toEqual({
      kind: "PAUSE_UNCLEAR"
    });
  });

  it("treats missing or invalid promise dates as unclear", () => {
    const base = {
      senderMatchesDebtor: true,
      automated: false,
      clarificationCount: 0,
      promiseExtensionUsed: false,
      receivedAt,
      hasProposedInstallmentPlan: false,
      expectedAmount: 100
    };
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({
          intent: "PROMISED_TO_PAY",
          promisedPaymentDate: null
        })
      })
    ).toEqual({ kind: "REQUEST_CLARIFICATION" });
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({
          intent: "PROMISED_TO_PAY",
          promisedPaymentDate: "2026-02-31"
        })
      })
    ).toEqual({ kind: "REQUEST_CLARIFICATION" });
  });

  it("pauses for manual review when a reply mentions a different amount", () => {
    expect(
      decideDebtorReply({
        classification: classification({
          intent: "PAID",
          mentionedPaymentAmount: 40
        }),
        senderMatchesDebtor: true,
        automated: false,
        clarificationCount: 0,
        promiseExtensionUsed: false,
        receivedAt,
        hasProposedInstallmentPlan: false,
        expectedAmount: 100
      })
    ).toEqual({
      kind: "PAUSE_MANUAL_REVIEW",
      reason: "AMOUNT_MISMATCH"
    });
  });

  it("routes sender mismatches to manual review and ignores automated replies", () => {
    const base = {
      classification: classification({ intent: "PAID" }),
      automated: false,
      clarificationCount: 0,
      promiseExtensionUsed: false,
      receivedAt,
      hasProposedInstallmentPlan: false,
      expectedAmount: 100
    };
    expect(
      decideDebtorReply({ ...base, senderMatchesDebtor: false })
    ).toEqual({ kind: "PAUSE_MANUAL_REVIEW", reason: "SENDER_MISMATCH" });
    expect(
      decideDebtorReply({
        ...base,
        senderMatchesDebtor: true,
        automated: true
      })
    ).toEqual({ kind: "IGNORE", reason: "AUTOMATED_REPLY" });
  });

  it("pauses disputes and handles installment request/rejection deterministically", () => {
    const base = {
      senderMatchesDebtor: true,
      automated: false,
      clarificationCount: 0,
      promiseExtensionUsed: false,
      receivedAt,
      hasProposedInstallmentPlan: false,
      expectedAmount: 100
    };
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({ intent: "DISPUTE" })
      })
    ).toEqual({ kind: "PAUSE_DISPUTE" });
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({ intent: "INSTALLMENT_REQUEST" })
      })
    ).toEqual({ kind: "PROPOSE_INSTALLMENT" });
    expect(
      decideDebtorReply({
        ...base,
        classification: classification({ intent: "INSTALLMENT_REJECTED" })
      })
    ).toEqual({ kind: "REJECT_INSTALLMENT" });
  });
});

describe("installment schedule", () => {
  it("creates +5/+19/+33 dates and puts rounding remainder in the last payment", () => {
    expect(calculateInstallmentSchedule(100, receivedAt)).toEqual([
      {
        sequence: 1,
        amount: 33.33,
        dueDate: new Date("2026-06-16T00:00:00.000Z")
      },
      {
        sequence: 2,
        amount: 33.33,
        dueDate: new Date("2026-06-30T00:00:00.000Z")
      },
      {
        sequence: 3,
        amount: 33.34,
        dueDate: new Date("2026-07-14T00:00:00.000Z")
      }
    ]);
  });
});

function classification(
  overrides: Partial<{
    intent:
      | "PAID"
      | "PROMISED_TO_PAY"
      | "DISPUTE"
      | "INSTALLMENT_REQUEST"
      | "INSTALLMENT_ACCEPTED"
      | "INSTALLMENT_REJECTED"
      | "AUTOMATED_REPLY"
      | "NEEDS_HUMAN"
      | "IGNORE_OR_OTHER";
    promisedPaymentDate: string | null;
    explicitInstallmentAcceptance: boolean;
    mentionedPaymentAmount: number | null;
    confidence: number;
  }>
) {
  return {
    intent: overrides.intent ?? "IGNORE_OR_OTHER",
    promisedPaymentDate: overrides.promisedPaymentDate ?? null,
    installmentRequested: overrides.intent === "INSTALLMENT_REQUEST",
    explicitInstallmentAcceptance:
      overrides.explicitInstallmentAcceptance ?? false,
    mentionedPaymentAmount: overrides.mentionedPaymentAmount ?? null,
    summary: "Test",
    confidence: overrides.confidence ?? 0.95,
    warnings: []
  };
}
