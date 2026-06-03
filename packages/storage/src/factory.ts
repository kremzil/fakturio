import { S3StorageProvider } from "./s3-provider";
import type { StorageProvider } from "./types";

export function createStorageProvider(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  return new S3StorageProvider({
    bucket: env.AWS_S3_BUCKET || "fakturio-local",
    region: env.AWS_REGION || "eu-central-1",
    endpoint: env.AWS_S3_ENDPOINT || undefined,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE === "1",
    accessKeyId: env.AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY || undefined
  });
}
