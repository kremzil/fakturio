import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import type { InboundEmail } from "./types";

export async function parseMimeEmail(
  raw: string | Uint8Array | Buffer,
  provider: string,
  providerId?: string | null
): Promise<InboundEmail> {
  const bytes = typeof raw === "string" ? Buffer.from(raw) : Buffer.from(raw);
  const parsed = await simpleParser(bytes);
  const messageId = normalizeMessageId(parsed.messageId);

  return {
    provider,
    providerId:
      providerId?.trim() ||
      messageId ||
      createHash("sha256").update(bytes).digest("hex"),
    messageId,
    inReplyTo: normalizeMessageId(parsed.inReplyTo),
    references: normalizeReferences(parsed.references),
    autoSubmitted: headerValue(parsed.headers.get("auto-submitted")),
    precedence: headerValue(parsed.headers.get("precedence")),
    from: firstAddress(parsed.from) ?? "",
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? null,
    textBody: parsed.text ?? null,
    htmlBody: typeof parsed.html === "string" ? parsed.html : null,
    attachments: parsed.attachments.map((attachment) => ({
      fileName: attachment.filename || "attachment",
      mimeType: attachment.contentType || "application/octet-stream",
      bytes: Uint8Array.from(attachment.content)
    })),
    raw: {
      messageId,
      inReplyTo: normalizeMessageId(parsed.inReplyTo),
      references: normalizeReferences(parsed.references),
      autoSubmitted: headerValue(parsed.headers.get("auto-submitted")),
      precedence: headerValue(parsed.headers.get("precedence")),
      date: parsed.date?.toISOString() ?? null
    }
  };
}

function headerValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().toLowerCase() || null;
  }
  return null;
}

export function extractRawMimeInput(input: unknown): {
  raw: string | Uint8Array | Buffer;
  providerId?: string | null;
} {
  if (typeof input === "string" || input instanceof Uint8Array || Buffer.isBuffer(input)) {
    return { raw: input };
  }

  if (!input || typeof input !== "object") {
    throw new Error("Inbound email payload does not contain raw MIME content.");
  }

  const candidate = input as Record<string, unknown>;
  const providerId =
    readString(candidate.providerId) ??
    readString(candidate.messageId) ??
    readNestedString(candidate, ["mail", "messageId"]);
  const raw =
    readRaw(candidate.raw) ??
    readRaw(candidate.content) ??
    readNestedRaw(candidate, ["mail", "content"]);

  if (!raw) {
    throw new Error(
      "Inbound SES payload must include raw MIME content from the SES receipt/S3 adapter."
    );
  }

  return {
    raw: candidate.contentEncoding === "base64" && typeof raw === "string"
      ? Buffer.from(raw, "base64")
      : raw,
    providerId
  };
}

function addresses(field: unknown): string[] {
  const value = (field as { value?: Array<{ address?: string; group?: Array<{ address?: string }> }> } | undefined)?.value ?? [];
  return value.flatMap((entry) => {
    if (entry.address) {
      return [entry.address.toLowerCase()];
    }
    return (entry.group ?? [])
      .map((groupEntry) => groupEntry.address?.toLowerCase())
      .filter((address): address is string => Boolean(address));
  });
}

function firstAddress(field: unknown): string | null {
  return addresses(field)[0] ?? null;
}

function normalizeReferences(value: string[] | string | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .flatMap((item) => item.split(/\s+/))
    .map(normalizeMessageId)
    .filter((item): item is string => Boolean(item));
}

function normalizeMessageId(value: string | undefined | null): string | null {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || null;
}

function readRaw(value: unknown): string | Uint8Array | Buffer | null {
  return typeof value === "string" || value instanceof Uint8Array || Buffer.isBuffer(value)
    ? value
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNestedString(
  input: Record<string, unknown>,
  path: string[]
): string | null {
  return readString(readNested(input, path));
}

function readNestedRaw(
  input: Record<string, unknown>,
  path: string[]
): string | Uint8Array | Buffer | null {
  return readRaw(readNested(input, path));
}

function readNested(input: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = input;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
