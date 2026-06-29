export type PutObjectInput = {
  organizationId: string;
  caseId: string;
  fileName: string;
  contentType: string;
  body: Uint8Array;
  kind?: "invoice" | "communication-attachment";
};

export type StoredObject = {
  bucket: string;
  key: string;
  sizeBytes: number;
  contentType: string;
};

export type GetSignedUrlInput = {
  bucket: string;
  key: string;
  expiresInSeconds?: number;
};

export type StoredObjectBody = {
  body: Uint8Array;
  contentType: string | null;
  sizeBytes: number | null;
};

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(input: { bucket: string; key: string }): Promise<StoredObjectBody>;
  getSignedUrl(input: GetSignedUrlInput): Promise<string>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export function buildCaseObjectKey(input: {
  organizationId: string;
  caseId: string;
  fileName: string;
  kind?: "invoice" | "communication-attachment";
}): string {
  const cleanFileName = input.fileName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const kind = input.kind ?? "invoice";
  return `organizations/${input.organizationId}/cases/${input.caseId}/${kind}/${Date.now()}-${cleanFileName || "file"}`;
}
