import {
  SESv2Client,
  SendEmailCommand,
  type SendEmailCommandOutput
} from "@aws-sdk/client-sesv2";
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
          Content: {
            Simple: {
              Subject: { Data: input.subject },
              Body: {
                Text: { Data: input.textBody },
                Html: input.htmlBody ? { Data: input.htmlBody } : undefined
              }
            }
          },
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
