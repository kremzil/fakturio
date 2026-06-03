import type { AiProvider } from "@fakturio/shared";
import type { InboundEmail } from "@fakturio/email";
import type { StorageProvider } from "@fakturio/storage";

export type IntakeActor = {
  actorType: "USER" | "EMAIL_PROVIDER" | "SYSTEM";
  actorId?: string;
};

export type InvoiceFilePayload = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

export type CreateFromUploadInput = InvoiceFilePayload & {
  organizationId: string;
  userId: string;
};

export type CreateFromEmailInput = {
  organizationId: string;
  email: InboundEmail;
};

export type IntakeCaseResult = {
  caseId: string;
  status: string;
  parseError: string | null;
};

export type InvoiceIntakeDependencies = {
  ai: AiProvider;
  storage: StorageProvider;
};
