import { EmailProvider, InboundEmail, SendEmailInput, SentEmailResult } from "./types";

export class FixtureEmailProvider implements EmailProvider {
  readonly sent: SendEmailInput[] = [];

  async sendEmail(input: SendEmailInput): Promise<SentEmailResult> {
    this.sent.push(input);

    return {
      provider: "fixture",
      providerId: `fixture-${this.sent.length}`
    };
  }

  async parseInbound(input: unknown): Promise<InboundEmail> {
    const candidate = input as Partial<InboundEmail>;

    return {
      provider: "fixture",
      providerId: candidate.providerId ?? "fixture-inbound",
      from: candidate.from ?? "debtor@example.com",
      to: candidate.to ?? ["system@example.com"],
      cc: candidate.cc ?? [],
      subject: candidate.subject ?? null,
      textBody: candidate.textBody ?? null,
      htmlBody: candidate.htmlBody ?? null,
      attachments: candidate.attachments ?? [],
      raw: input
    };
  }
}
