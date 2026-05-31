export const INVOICE_UPLOAD_STATUSES = [
  "UPLOADED",
  "PARSING",
  "PARSED",
  "NEEDS_REVIEW",
  "REGISTERED",
  "PARSE_FAILED",
  "CANCELLED"
] as const;

export type InvoiceUploadStatus = (typeof INVOICE_UPLOAD_STATUSES)[number];

export const ACTIONS = {
  uploadCreated: "UPLOAD_CREATED",
  aiParseStarted: "AI_PARSE_STARTED",
  aiParseCompleted: "AI_PARSE_COMPLETED",
  aiParseFailed: "AI_PARSE_FAILED",
  userConfirmed: "USER_CONFIRMED",
  userEditedField: "USER_EDITED_FIELD",
  invoiceRegistered: "INVOICE_REGISTERED",
  uploadCancelled: "UPLOAD_CANCELLED"
} as const;

export const LOCAL_USER_ID = "local-user";
