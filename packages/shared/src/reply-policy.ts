import type { DebtorReplyClassification } from "./invoice";

export const DEBTOR_REPLY_CONFIDENCE_THRESHOLD = 0.8;
export const PROMISE_EXTENSION_MAX_DAYS = 10;
export const INSTALLMENT_PAYMENT_DAY_OFFSETS = [5, 19, 33] as const;

export type ReplyPolicyInput = {
  classification: DebtorReplyClassification;
  senderMatchesDebtor: boolean;
  automated: boolean;
  clarificationCount: number;
  promiseExtensionUsed: boolean;
  receivedAt: Date;
  hasProposedInstallmentPlan: boolean;
  expectedAmount: number | null;
};

export type ReplyPolicyDecision =
  | { kind: "IGNORE"; reason: "AUTOMATED_REPLY" | "OTHER" }
  | { kind: "CHECK_PAYMENT_NOW" }
  | { kind: "KEEP_EXISTING_DEADLINE" }
  | { kind: "ACCEPT_PROMISE"; paymentDate: Date }
  | { kind: "PROPOSE_INSTALLMENT" }
  | { kind: "ACTIVATE_INSTALLMENT" }
  | { kind: "REJECT_INSTALLMENT" }
  | { kind: "PAUSE_DISPUTE" }
  | {
      kind: "PAUSE_MANUAL_REVIEW";
      reason: "AMOUNT_MISMATCH" | "SENDER_MISMATCH";
    }
  | { kind: "REQUEST_CLARIFICATION" }
  | { kind: "PAUSE_UNCLEAR" };

export function decideDebtorReply(input: ReplyPolicyInput): ReplyPolicyDecision {
  if (input.automated || input.classification.intent === "AUTOMATED_REPLY") {
    return { kind: "IGNORE", reason: "AUTOMATED_REPLY" };
  }
  if (!input.senderMatchesDebtor) {
    return { kind: "PAUSE_MANUAL_REVIEW", reason: "SENDER_MISMATCH" };
  }

  if (
    input.classification.confidence < DEBTOR_REPLY_CONFIDENCE_THRESHOLD ||
    input.classification.intent === "NEEDS_HUMAN" ||
    input.classification.warnings.length > 0
  ) {
    return input.clarificationCount === 0
      ? { kind: "REQUEST_CLARIFICATION" }
      : { kind: "PAUSE_UNCLEAR" };
  }

  if (
    input.classification.mentionedPaymentAmount !== null &&
    input.expectedAmount !== null &&
    Math.abs(
      input.classification.mentionedPaymentAmount - input.expectedAmount
    ) >= 0.01
  ) {
    return { kind: "PAUSE_MANUAL_REVIEW", reason: "AMOUNT_MISMATCH" };
  }

  switch (input.classification.intent) {
    case "PAID":
      return { kind: "CHECK_PAYMENT_NOW" };
    case "PROMISED_TO_PAY":
      if (input.promiseExtensionUsed) {
        return { kind: "KEEP_EXISTING_DEADLINE" };
      }
      if (
        !isValidFutureIsoDate(
          input.classification.promisedPaymentDate,
          input.receivedAt
        )
      ) {
        return input.clarificationCount === 0
          ? { kind: "REQUEST_CLARIFICATION" }
          : { kind: "PAUSE_UNCLEAR" };
      }
      return {
        kind: "ACCEPT_PROMISE",
        paymentDate: cappedPromiseDate(
          input.classification.promisedPaymentDate,
          input.receivedAt
        )
      };
    case "INSTALLMENT_REQUEST":
      return { kind: "PROPOSE_INSTALLMENT" };
    case "INSTALLMENT_ACCEPTED":
      return input.hasProposedInstallmentPlan &&
        input.classification.explicitInstallmentAcceptance
        ? { kind: "ACTIVATE_INSTALLMENT" }
        : input.clarificationCount === 0
          ? { kind: "REQUEST_CLARIFICATION" }
          : { kind: "PAUSE_UNCLEAR" };
    case "INSTALLMENT_REJECTED":
      return { kind: "REJECT_INSTALLMENT" };
    case "DISPUTE":
      return { kind: "PAUSE_DISPUTE" };
    case "IGNORE_OR_OTHER":
    default:
      return input.clarificationCount === 0
        ? { kind: "REQUEST_CLARIFICATION" }
        : { kind: "PAUSE_UNCLEAR" };
  }
}

export function calculateInstallmentSchedule(
  totalAmount: number,
  acceptedFrom: Date
): Array<{ sequence: number; amount: number; dueDate: Date }> {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("Installment total must be a positive amount.");
  }
  const totalCents = Math.round(totalAmount * 100);
  const baseCents = Math.floor(totalCents / 3);
  const amounts = [baseCents, baseCents, totalCents - baseCents * 2];

  return INSTALLMENT_PAYMENT_DAY_OFFSETS.map((days, index) => ({
    sequence: index + 1,
    amount: amounts[index] / 100,
    dueDate: addUtcDays(startOfUtcDay(acceptedFrom), days)
  }));
}

function cappedPromiseDate(value: string | null, receivedAt: Date): Date {
  const maximum = addUtcDays(startOfUtcDay(receivedAt), PROMISE_EXTENSION_MAX_DAYS);
  const parsed = parseIsoDate(value!);
  return parsed.getTime() > maximum.getTime() ? maximum : parsed;
}

function isValidFutureIsoDate(
  value: string | null,
  receivedAt: Date
): boolean {
  if (!value) {
    return false;
  }
  const parsed = parseIsoDate(value);
  return parsed.getTime() > receivedAt.getTime();
}

function parseIsoDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(Number.NaN);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return new Date(Number.NaN);
  }
  return parsed;
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
