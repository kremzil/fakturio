import nodemailer from "nodemailer";
import { EmailProvider, InboundEmail, SendEmailInput, SentEmailResult } from "./types";

export type MailpitEmailProviderOptions = {
  host: string;
  port: number;
};

export class MailpitEmailProvider implements EmailProvider {
  private readonly transport: nodemailer.Transporter;

  constructor(options: MailpitEmailProviderOptions) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: false
    });
  }

  async sendEmail(input: SendEmailInput): Promise<SentEmailResult> {
    const result = await this.transport.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.textBody,
      html: input.htmlBody
    });

    return {
      provider: "mailpit",
      providerId: result.messageId
    };
  }

  async parseInbound(input: unknown): Promise<InboundEmail> {
    return {
      provider: "mailpit",
      providerId: "mailpit-inbound-unparsed",
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
