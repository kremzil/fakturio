export type EmailProviderErrorCode =
  | "MESSAGE_REJECTED"
  | "MAIL_FROM_DOMAIN_NOT_VERIFIED"
  | "ACCOUNT_SENDING_PAUSED"
  | "SENDING_PAUSED"
  | "TOO_MANY_REQUESTS"
  | "TRANSIENT_PROVIDER_ERROR";

export class EmailProviderError extends Error {
  readonly code: EmailProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly cause: unknown;

  constructor(input: {
    code: EmailProviderErrorCode;
    provider: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "EmailProviderError";
    this.code = input.code;
    this.provider = input.provider;
    this.retryable = input.retryable;
    this.cause = input.cause;
  }
}

export function isPermanentEmailProviderError(
  error: unknown
): error is EmailProviderError {
  return error instanceof EmailProviderError && !error.retryable;
}
