import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { EmailProvider, InboundEmail, SendEmailInput, SentEmailResult } from "./types";

export type SesEmailProviderOptions = {
  region: string;
  client?: SESv2Client;
};

export class SesEmailProvider implements EmailProvider {
  private readonly client: SESv2Client;

  constructor(options: SesEmailProviderOptions) {
    this.client = options.client ?? new SESv2Client({ region: options.region });
  }

  async sendEmail(input: SendEmailInput): Promise<SentEmailResult> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: input.from,
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

    return {
      provider: "ses",
      providerId: result.MessageId ?? "unknown"
    };
  }

  async parseInbound(input: unknown): Promise<InboundEmail> {
    return {
      provider: "ses",
      providerId: "ses-inbound-unparsed",
      from: "",
      to: [],
      cc: [],
      subject: null,
      textBody: null,
      htmlBody: null,
      attachments: [],
      raw: input
    };
  }
}
