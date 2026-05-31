export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
