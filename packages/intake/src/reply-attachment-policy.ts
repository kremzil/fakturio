import type { InboundEmailAttachment } from "@fakturio/email";

export const DEFAULT_MAX_REPLY_ATTACHMENTS = 10;
export const DEFAULT_MAX_REPLY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REPLY_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
export const ALLOWED_REPLY_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export type RejectedReplyAttachment = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  reason:
    | "UNSUPPORTED_TYPE"
    | "FILE_TOO_LARGE"
    | "TOO_MANY_ATTACHMENTS"
    | "TOTAL_SIZE_EXCEEDED";
};

export function selectReplyAttachments(
  attachments: InboundEmailAttachment[],
  limits: {
    maxAttachments?: number;
    maxAttachmentBytes?: number;
    maxTotalBytes?: number;
  } = {}
): {
  accepted: InboundEmailAttachment[];
  rejected: RejectedReplyAttachment[];
} {
  const maxAttachments =
    limits.maxAttachments ?? DEFAULT_MAX_REPLY_ATTACHMENTS;
  const maxAttachmentBytes =
    limits.maxAttachmentBytes ?? DEFAULT_MAX_REPLY_ATTACHMENT_BYTES;
  const maxTotalBytes =
    limits.maxTotalBytes ?? DEFAULT_MAX_REPLY_ATTACHMENT_TOTAL_BYTES;
  const accepted: InboundEmailAttachment[] = [];
  const rejected: RejectedReplyAttachment[] = [];
  let acceptedBytes = 0;

  for (const [index, attachment] of attachments.entries()) {
    const sizeBytes = attachment.bytes.byteLength;
    let reason: RejectedReplyAttachment["reason"] | null = null;
    if (index >= maxAttachments) {
      reason = "TOO_MANY_ATTACHMENTS";
    } else if (!ALLOWED_REPLY_ATTACHMENT_MIME_TYPES.has(attachment.mimeType)) {
      reason = "UNSUPPORTED_TYPE";
    } else if (sizeBytes > maxAttachmentBytes) {
      reason = "FILE_TOO_LARGE";
    } else if (acceptedBytes + sizeBytes > maxTotalBytes) {
      reason = "TOTAL_SIZE_EXCEEDED";
    }

    if (reason) {
      rejected.push({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes,
        reason
      });
      continue;
    }

    accepted.push(attachment);
    acceptedBytes += sizeBytes;
  }

  return { accepted, rejected };
}
