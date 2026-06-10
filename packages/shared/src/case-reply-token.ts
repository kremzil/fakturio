import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_BYTES = 12;
const REPLY_LOCAL_PREFIX = "reply+";

export function createCaseReplyAddress(
  input: { caseId: string; domain: string },
  secret: string
): string {
  const caseId = normalizeCaseId(input.caseId);
  const domain = input.domain.trim().toLowerCase();
  if (!domain || domain.includes("@")) {
    throw new Error("Reply email domain is invalid.");
  }

  const signature = signCaseId(caseId, secret);
  const localPart = `${REPLY_LOCAL_PREFIX}${caseId}.${signature}`;
  if (localPart.length > 64) {
    throw new Error("Case id is too long for a signed reply email address.");
  }

  return `${localPart}@${domain}`;
}

export function verifyCaseReplyAddress(
  address: string,
  secret: string
): { caseId: string } | null {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) {
    return null;
  }

  const localPart = normalized.slice(0, at);
  if (!localPart.startsWith(REPLY_LOCAL_PREFIX)) {
    return null;
  }

  const signedValue = localPart.slice(REPLY_LOCAL_PREFIX.length);
  const separator = signedValue.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }

  const caseId = signedValue.slice(0, separator);
  const provided = signedValue.slice(separator + 1);
  const expected = signCaseId(caseId, secret);
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);

  if (
    providedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(providedBytes, expectedBytes)
  ) {
    return null;
  }

  return { caseId };
}

export function requireInboundReplyTokenSecret(
  env: NodeJS.ProcessEnv = process.env
): string {
  const secret = env.INBOUND_REPLY_TOKEN_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("INBOUND_REPLY_TOKEN_SECRET must contain at least 32 characters.");
  }
  return "dev-insecure-inbound-reply-secret";
}

function signCaseId(caseId: string, secret: string): string {
  if (secret.length < 16) {
    throw new Error("Inbound reply token secret is too short.");
  }
  return createHmac("sha256", secret)
    .update(`case-reply:v1:${caseId}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString("hex");
}

function normalizeCaseId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(normalized)) {
    throw new Error("Case id contains characters that are unsafe in an email local part.");
  }
  return normalized;
}
