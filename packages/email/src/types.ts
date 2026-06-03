export type SendEmailInput = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  metadata?: Record<string, string>;
};

export type SentEmailResult = {
  provider: string;
  providerId: string;
};

export type InboundEmailAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type InboundEmail = {
  provider: string;
  providerId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  attachments: InboundEmailAttachment[];
  raw: unknown;
};

export interface EmailProvider {
  sendEmail(input: SendEmailInput): Promise<SentEmailResult>;
  parseInbound(input: unknown): Promise<InboundEmail>;
}
