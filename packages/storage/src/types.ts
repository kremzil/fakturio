export type PutObjectInput = {
  organizationId: string;
  caseId: string;
  fileName: string;
  contentType: string;
  body: Uint8Array;
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

export interface StorageProvider {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getSignedUrl(input: GetSignedUrlInput): Promise<string>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export function buildCaseObjectKey(input: { organizationId: string; caseId: string; fileName: string }): string {
  const cleanFileName = input.fileName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `organizations/${input.organizationId}/cases/${input.caseId}/invoice/${Date.now()}-${cleanFileName || "invoice"}`;
}
