import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput
} from "@aws-sdk/client-sesv2";
import { Buffer } from "node:buffer";
import { EmailProvider, InboundEmail, SendEmailInput, SentEmailResult } from "./types";
import { extractRawMimeInput, parseMimeEmail } from "./mime";
import { EmailProviderError, type EmailProviderErrorCode } from "./errors";

export type SesEmailProviderOptions = {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: SESv2Client;
};

export class SesEmailProvider implements EmailProvider {
  private readonly client: SESv2Client;

  constructor(options: SesEmailProviderOptions) {
    this.client =
      options.client ??
      new SESv2Client({
        region: options.region,
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey
              }
            : undefined
      });
  }

  async sendEmail(input: SendEmailInput): Promise<SentEmailResult> {
    let result: SendEmailCommandOutput;
    try {
      result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: input.from,
          ReplyToAddresses: input.replyTo,
          Destination: {
            ToAddresses: input.to,
            CcAddresses: input.cc,
            BccAddresses: input.bcc
          },
          Content: buildSesContent(input),
          EmailTags: Object.entries(input.metadata ?? {}).map(([Name, Value]) => ({ Name, Value }))
        })
      );
    } catch (error) {
      throw toSesEmailProviderError(error);
    }

    return {
      provider: "ses",
      providerId: result.MessageId ?? "unknown"
    };
  }

  async parseInbound(input: unknown): Promise<InboundEmail> {
    const { raw, providerId } = extractRawMimeInput(input);
    return parseMimeEmail(raw, "ses", providerId);
  }
}

function buildSesContent(input: SendEmailInput) {
  if (input.attachments?.length) {
    return {
      Raw: {
        Data: Buffer.from(buildRawMimeMessage(input))
      }
    };
  }

  return {
    Simple: {
      Subject: { Data: input.subject },
      Body: {
        Text: { Data: input.textBody },
        Html: input.htmlBody ? { Data: input.htmlBody } : undefined
      }
    }
  };
}

function buildRawMimeMessage(input: SendEmailInput): string {
  const mixedBoundary = `fakturio-mixed-${randomMimeBoundary()}`;
  const alternativeBoundary = `fakturio-alt-${randomMimeBoundary()}`;
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    input.cc?.length ? `Cc: ${input.cc.join(", ")}` : null,
    input.replyTo?.length ? `Reply-To: ${input.replyTo.join(", ")}` : null,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
  ].filter(Boolean);

  const parts = [
    ...headers,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    chunkBase64(Buffer.from(input.textBody, "utf8").toString("base64")),
    "",
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    chunkBase64(
      Buffer.from(input.htmlBody ?? htmlFromText(input.textBody), "utf8").toString(
        "base64"
      )
    ),
    "",
    `--${alternativeBoundary}--`
  ];

  for (const attachment of input.attachments ?? []) {
    parts.push(
      "",
      `--${mixedBoundary}`,
      `Content-Type: ${attachment.contentType}; name="${escapeMimeParameter(attachment.fileName)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeMimeParameter(attachment.fileName)}"`,
      "",
      chunkBase64(Buffer.from(attachment.content).toString("base64"))
    );
  }

  parts.push("", `--${mixedBoundary}--`, "");
  return parts.join("\r\n");
}

function randomMimeBoundary(): string {
  return Math.random().toString(16).slice(2);
}

function encodeMimeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function escapeMimeParameter(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function htmlFromText(value: string): string {
  return `<pre>${value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;
}

function chunkBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trim();
}

function toSesEmailProviderError(error: unknown): unknown {
  const name = awsErrorName(error);
  if (!name) {
    return error;
  }

  const permanentCode = permanentSesErrorCode(name);
  if (permanentCode) {
    return new EmailProviderError({
      code: permanentCode,
      provider: "ses",
      message: `SES rejected the email with ${name}.`,
      retryable: false,
      cause: error
    });
  }

  return new EmailProviderError({
    code: name === "TooManyRequestsException" ? "TOO_MANY_REQUESTS" : "TRANSIENT_PROVIDER_ERROR",
    provider: "ses",
    message: `SES send failed with ${name}.`,
    retryable: true,
    cause: error
  });
}

function permanentSesErrorCode(name: string): EmailProviderErrorCode | null {
  switch (name) {
    case "MessageRejected":
    case "BadRequestException":
      return "MESSAGE_REJECTED";
    case "MailFromDomainNotVerifiedException":
      return "MAIL_FROM_DOMAIN_NOT_VERIFIED";
    case "AccountSendingPausedException":
      return "ACCOUNT_SENDING_PAUSED";
    case "SendingPausedException":
      return "SENDING_PAUSED";
    default:
      return null;
  }
}

function awsErrorName(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as { name?: unknown; Code?: unknown; code?: unknown };
  if (typeof record.name === "string" && record.name) {
    return record.name;
  }
  if (typeof record.Code === "string" && record.Code) {
    return record.Code;
  }
  if (typeof record.code === "string" && record.code) {
    return record.code;
  }
  return null;
}
