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
      reason:
        | "AMOUNT_MISMATCH"
        | "SENDER_MISMATCH"
        | "NON_STANDARD_INSTALLMENT_TERMS";
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
      const requestedCount =
        input.classification.requestedInstallmentCount ??
        extractInstallmentCount(input.classification.summary);
      if (
        input.hasProposedInstallmentPlan ||
        (requestedCount !== null && requestedCount !== 3)
      ) {
        return {
          kind: "PAUSE_MANUAL_REVIEW",
          reason: "NON_STANDARD_INSTALLMENT_TERMS"
        };
      }
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

export function calculateCustomInstallmentSchedule(
  totalAmount: number,
  acceptedFrom: Date,
  input: {
    paymentCount: number;
    firstPaymentAmount?: number | null;
    paymentAmounts?: number[];
    dueDates?: string[];
  }
): Array<{ sequence: number; amount: number; dueDate: Date }> {
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    throw new Error("Installment total must be a positive amount.");
  }
  if (!Number.isInteger(input.paymentCount) || input.paymentCount < 2 || input.paymentCount > 24) {
    throw new Error("Custom installment count must be between 2 and 24.");
  }

  const amounts = resolveInstallmentAmounts(
    totalAmount,
    input.paymentCount,
    input.firstPaymentAmount ?? null,
    input.paymentAmounts ?? []
  );
  const dueDates = resolveInstallmentDueDates(
    acceptedFrom,
    input.paymentCount,
    input.dueDates ?? []
  );

  return amounts.map((amount, index) => ({
    sequence: index + 1,
    amount,
    dueDate: dueDates[index]
  }));
}

function resolveInstallmentAmounts(
  totalAmount: number,
  paymentCount: number,
  firstPaymentAmount: number | null,
  explicitAmounts: number[]
): number[] {
  const totalCents = Math.round(totalAmount * 100);
  if (explicitAmounts.length > 0) {
    if (explicitAmounts.length !== paymentCount) {
      throw new Error("Explicit installment amounts must match the payment count.");
    }
    const cents = explicitAmounts.map((amount) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Installment amounts must be positive.");
      }
      return Math.round(amount * 100);
    });
    const sum = cents.reduce((acc, amount) => acc + amount, 0);
    if (sum !== totalCents) {
      throw new Error("Explicit installment amounts must sum to the total amount.");
    }
    return cents.map((amount) => amount / 100);
  }

  if (firstPaymentAmount !== null) {
    const firstCents = Math.round(firstPaymentAmount * 100);
    if (firstCents <= 0 || firstCents >= totalCents) {
      throw new Error("First installment amount must be lower than the total amount.");
    }
    const restCount = paymentCount - 1;
    const restTotal = totalCents - firstCents;
    const baseRest = Math.floor(restTotal / restCount);
    return [
      firstCents,
      ...Array.from({ length: restCount }, (_, index) =>
        index === restCount - 1
          ? restTotal - baseRest * (restCount - 1)
          : baseRest
      )
    ].map((amount) => amount / 100);
  }

  const base = Math.floor(totalCents / paymentCount);
  return Array.from({ length: paymentCount }, (_, index) =>
    index === paymentCount - 1
      ? totalCents - base * (paymentCount - 1)
      : base
  ).map((amount) => amount / 100);
}

function resolveInstallmentDueDates(
  acceptedFrom: Date,
  paymentCount: number,
  explicitDueDates: string[]
): Date[] {
  if (explicitDueDates.length > 0) {
    if (explicitDueDates.length !== paymentCount) {
      throw new Error("Explicit installment dates must match the payment count.");
    }
    return explicitDueDates.map((value) => {
      const parsed = parseIsoDate(value);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= acceptedFrom.getTime()) {
        throw new Error("Installment dates must be valid future ISO dates.");
      }
      return parsed;
    });
  }

  const start = startOfUtcDay(acceptedFrom);
  return Array.from({ length: paymentCount }, (_, index) =>
    addUtcDays(start, 5 + index * 14)
  );
}

function extractInstallmentCount(value: string): number | null {
  const normalized = value.toLowerCase();
  const digit = normalized.match(
    /\b(\d{1,2})\s*(?:installments?|spl[aá]tok|spl[aá]tky|payments?|платеж|платёж)/u
  );
  if (digit) {
    return Number(digit[1]);
  }
  const words: Record<string, number> = {
    two: 2,
    dve: 2,
    dva: 2,
    три: 3,
    tri: 3,
    three: 3,
    four: 4,
    styri: 4,
    štyri: 4,
    five: 5,
    pat: 5,
    päť: 5,
    пять: 5
  };
  for (const [word, count] of Object.entries(words)) {
    if (
      normalized.includes(`${word} installment`) ||
      normalized.includes(`${word} spl`) ||
      normalized.includes(`${word} payment`) ||
      normalized.includes(`${word} плат`)
    ) {
      return count;
    }
  }
  return null;
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
