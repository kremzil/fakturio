import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaseStatus } from "./case-status";

export const PAYMENT_CHECK_TOKEN_VERSION = 1;
export const PAYMENT_CHECK_TOKEN_PURPOSE = "payment-check" as const;

export type PaymentCheckAction = "PAID" | "NOT_PAID";

export type PaymentCheckTokenClaims = {
  version: number;
  purpose: typeof PAYMENT_CHECK_TOKEN_PURPOSE;
  caseId: string;
  organizationId: string;
  action: PaymentCheckAction;
  expiresAt: number;
};

export type CreatePaymentCheckTokenInput = {
  caseId: string;
  organizationId: string;
  action: PaymentCheckAction;
  expiresAt: number;
};

export type VerifyPaymentCheckTokenOptions = {
  now?: number;
  expectedCaseId?: string;
  expectedAction?: PaymentCheckAction;
};

export type PaymentCheckTokenVerifyFailure =
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "WRONG_PURPOSE"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "CASE_MISMATCH"
  | "ACTION_MISMATCH";

export type PaymentCheckTokenVerifyResult =
  | { ok: true; claims: PaymentCheckTokenClaims }
  | { ok: false; reason: PaymentCheckTokenVerifyFailure };

function encodePayload(claims: PaymentCheckTokenClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createPaymentCheckToken(input: CreatePaymentCheckTokenInput, secret: string): string {
  assertSecret(secret);
  const claims: PaymentCheckTokenClaims = {
    version: PAYMENT_CHECK_TOKEN_VERSION,
    purpose: PAYMENT_CHECK_TOKEN_PURPOSE,
    caseId: input.caseId,
    organizationId: input.organizationId,
    action: input.action,
    expiresAt: input.expiresAt
  };
  const payload = encodePayload(claims);
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPaymentCheckToken(
  token: string,
  secret: string,
  options: VerifyPaymentCheckTokenOptions = {}
): PaymentCheckTokenVerifyResult {
  assertSecret(secret);

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return { ok: false, reason: "MALFORMED" };
  }

  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = sign(payload, secret);

  if (!constantTimeEquals(providedSignature, expectedSignature)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let claims: PaymentCheckTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PaymentCheckTokenClaims;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (!isPlausibleClaims(claims)) {
    return { ok: false, reason: "MALFORMED" };
  }

  if (claims.version !== PAYMENT_CHECK_TOKEN_VERSION) {
    return { ok: false, reason: "UNSUPPORTED_VERSION" };
  }

  if (claims.purpose !== PAYMENT_CHECK_TOKEN_PURPOSE) {
    return { ok: false, reason: "WRONG_PURPOSE" };
  }

  const now = options.now ?? Date.now();
  if (claims.expiresAt <= now) {
    return { ok: false, reason: "EXPIRED" };
  }

  if (options.expectedCaseId !== undefined && options.expectedCaseId !== claims.caseId) {
    return { ok: false, reason: "CASE_MISMATCH" };
  }

  if (options.expectedAction !== undefined && options.expectedAction !== claims.action) {
    return { ok: false, reason: "ACTION_MISMATCH" };
  }

  return { ok: true, claims };
}

function isPlausibleClaims(value: unknown): value is PaymentCheckTokenClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.version === "number" &&
    typeof claims.purpose === "string" &&
    typeof claims.caseId === "string" &&
    typeof claims.organizationId === "string" &&
    (claims.action === "PAID" || claims.action === "NOT_PAID") &&
    typeof claims.expiresAt === "number"
  );
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < 16) {
    throw new Error("Payment-check token secret must be at least 16 characters.");
  }
}

/**
 * Reads the dedicated payment-check token secret. This is intentionally separate from
 * AUTH_SECRET so the two keys can be rotated independently. Fails fast in production
 * when the secret is missing; allows an insecure development fallback only outside production.
 */
export function requirePaymentCheckTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.PAYMENT_CHECK_TOKEN_SECRET;
  if (secret && secret.length >= 16) {
    return secret;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("PAYMENT_CHECK_TOKEN_SECRET (min 16 chars) is required in production.");
  }

  return "dev-insecure-payment-check-secret";
}

export const PAYMENT_CHECK_TOKEN_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * State-based idempotency rules for payment-check actions.
 *
 * Because the HMAC token is stateless (no nonce/consumedAt), we cannot guarantee strict
 * single-use. Instead, replay safety comes from the case status:
 *  - PAID again while CLOSED_PAID    -> NOOP (success)
 *  - NOT_PAID again while OVERDUE    -> NOOP (success)
 *  - NOT_PAID after CLOSED_PAID      -> CONFLICT (reject)
 *  - PAID after OVERDUE             -> APPLY CLOSED_PAID
 */
export type PaymentCheckTransition =
  | { outcome: "APPLY"; nextStatus: CaseStatus }
  | { outcome: "NOOP"; currentStatus: CaseStatus }
  | { outcome: "CONFLICT"; currentStatus: CaseStatus; reason: string };

const TERMINAL_STATUSES: CaseStatus[] = ["CLOSED_PAID", "CLOSED_CANCELLED", "CLOSED_UNRESOLVED"];

export function resolvePaymentCheckTransition(
  action: PaymentCheckAction,
  currentStatus: CaseStatus
): PaymentCheckTransition {
  if (action === "PAID") {
    if (currentStatus === "CLOSED_PAID") {
      return { outcome: "NOOP", currentStatus };
    }
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      return { outcome: "CONFLICT", currentStatus, reason: "Case is already closed and cannot be marked paid." };
    }
    return { outcome: "APPLY", nextStatus: "CLOSED_PAID" };
  }

  // action === "NOT_PAID"
  if (currentStatus === "OVERDUE") {
    return { outcome: "NOOP", currentStatus };
  }
  if (currentStatus === "CLOSED_PAID") {
    return { outcome: "CONFLICT", currentStatus, reason: "Case is already closed as paid." };
  }
  if (TERMINAL_STATUSES.includes(currentStatus)) {
    return { outcome: "CONFLICT", currentStatus, reason: "Case is already closed." };
  }
  if (currentStatus === "WAITING_FOR_DUE_DATE" || currentStatus === "DUE_SOON") {
    return { outcome: "APPLY", nextStatus: "OVERDUE" };
  }

  // Case already progressed into collection beyond OVERDUE: do not regress its status.
  return { outcome: "NOOP", currentStatus };
}
