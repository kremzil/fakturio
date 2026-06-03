import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetSignedUrlInput, PutObjectInput, StorageProvider, StoredObject, buildCaseObjectKey } from "./types";

export type S3StorageProviderOptions = {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  client?: S3Client;
};

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly canCreateBucket: boolean;

  constructor(options: S3StorageProviderOptions) {
    this.bucket = options.bucket;
    this.canCreateBucket = Boolean(options.endpoint);
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint || undefined,
        forcePathStyle: options.forcePathStyle,
        credentials:
          options.accessKeyId && options.secretAccessKey
            ? {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey
              }
            : undefined
      });
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const key = buildCaseObjectKey(input);
    await this.ensureBucket();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType
      })
    );

    return {
      bucket: this.bucket,
      key,
      sizeBytes: input.body.byteLength,
      contentType: input.contentType
    };
  }

  async getSignedUrl(input: GetSignedUrlInput): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key
      }),
      { expiresIn: input.expiresInSeconds ?? 900 }
    );
  }

  async deleteObject(input: { bucket: string; key: string }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: input.bucket,
        Key: input.key
      })
    );
  }

  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!this.canCreateBucket) {
        throw error;
      }

      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
