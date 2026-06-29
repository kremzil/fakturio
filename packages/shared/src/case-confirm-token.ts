import { createHmac, timingSafeEqual } from "node:crypto";

export const CASE_CONFIRM_TOKEN_VERSION = 1;
export const CASE_CONFIRM_TOKEN_PURPOSE = "case-confirm" as const;
export const CASE_CONFIRM_TOKEN_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type CaseConfirmTokenClaims = {
  version: typeof CASE_CONFIRM_TOKEN_VERSION;
  purpose: typeof CASE_CONFIRM_TOKEN_PURPOSE;
  caseId: string;
  organizationId: string;
  action: "CONFIRM_AND_START";
  expiresAt: number;
};

export type CaseConfirmTokenVerifyResult =
  | { ok: true; claims: CaseConfirmTokenClaims }
  | {
      ok: false;
      reason:
        | "MALFORMED"
        | "UNSUPPORTED_VERSION"
        | "WRONG_PURPOSE"
        | "BAD_SIGNATURE"
        | "EXPIRED"
        | "CASE_MISMATCH"
        | "ACTION_MISMATCH";
    };

export function createCaseConfirmToken(
  input: {
    caseId: string;
    organizationId: string;
    expiresAt: number;
  },
  secret: string
): string {
  assertSecret(secret);
  const claims: CaseConfirmTokenClaims = {
    version: CASE_CONFIRM_TOKEN_VERSION,
    purpose: CASE_CONFIRM_TOKEN_PURPOSE,
    caseId: input.caseId,
    organizationId: input.organizationId,
    action: "CONFIRM_AND_START",
    expiresAt: input.expiresAt
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyCaseConfirmToken(
  token: string,
  secret: string,
  options: { now?: number; expectedCaseId?: string } = {}
): CaseConfirmTokenVerifyResult {
  assertSecret(secret);
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) {
    return { ok: false, reason: "MALFORMED" };
  }

  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!constantTimeEquals(providedSignature, sign(payload, secret))) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let claims: CaseConfirmTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CaseConfirmTokenClaims;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (!isPlausibleClaims(claims)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (claims.version !== CASE_CONFIRM_TOKEN_VERSION) {
    return { ok: false, reason: "UNSUPPORTED_VERSION" };
  }
  if (claims.purpose !== CASE_CONFIRM_TOKEN_PURPOSE) {
    return { ok: false, reason: "WRONG_PURPOSE" };
  }
  if (claims.action !== "CONFIRM_AND_START") {
    return { ok: false, reason: "ACTION_MISMATCH" };
  }
  if (claims.expiresAt <= (options.now ?? Date.now())) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (options.expectedCaseId !== undefined && options.expectedCaseId !== claims.caseId) {
    return { ok: false, reason: "CASE_MISMATCH" };
  }

  return { ok: true, claims };
}

export function requireCaseConfirmTokenSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.CASE_CONFIRM_TOKEN_SECRET || env.PAYMENT_CHECK_TOKEN_SECRET;
  if (secret && secret.length >= 16) {
    return secret;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("CASE_CONFIRM_TOKEN_SECRET or PAYMENT_CHECK_TOKEN_SECRET (min 16 chars) is required in production.");
  }
  return "dev-insecure-case-confirm-secret";
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function isPlausibleClaims(value: unknown): value is CaseConfirmTokenClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const claims = value as Record<string, unknown>;
  return (
    typeof claims.version === "number" &&
    typeof claims.purpose === "string" &&
    typeof claims.caseId === "string" &&
    typeof claims.organizationId === "string" &&
    typeof claims.action === "string" &&
    typeof claims.expiresAt === "number"
  );
}

function assertSecret(secret: string): void {
  if (!secret || secret.length < 16) {
    throw new Error("Case-confirm token secret must be at least 16 characters.");
  }
}
