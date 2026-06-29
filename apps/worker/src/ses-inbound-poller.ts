import { basename } from "node:path/posix";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig
} from "@aws-sdk/client-s3";
import { SesEmailProvider, type InboundEmail } from "@fakturio/email";
import {
  processInboundEmail,
  type InboundEmailProcessingResult
} from "@fakturio/intake";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;

export type SesInboundPollerConfig = {
  enabled: boolean;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket: string;
  pendingPrefix: string;
  processedPrefix: string;
  failedPrefix: string;
  batchSize: number;
  pollIntervalMs: number;
};

export type SesInboundS3Object = {
  key: string;
  size?: number;
};

export type SesInboundObjectStore = {
  listPendingObjects(input: {
    prefix: string;
    batchSize: number;
  }): Promise<SesInboundS3Object[]>;
  readObject(input: { key: string }): Promise<Uint8Array>;
  moveObject(input: { sourceKey: string; destinationKey: string }): Promise<void>;
};

export type SesInboundProcessResult = {
  key: string;
  destinationKey: string;
  outcome: "PROCESSED" | "FAILED";
  processing: InboundEmailProcessingResult | null;
  error: string | null;
};

export function sesInboundPollerConfig(
  env: NodeJS.ProcessEnv = process.env
): SesInboundPollerConfig {
  const bucket = (env.SES_INBOUND_BUCKET || "").trim();
  const enabled =
    env.SES_INBOUND_POLLING === "1" ||
    (env.EMAIL_DRIVER === "ses" && bucket.length > 0 && env.SES_INBOUND_POLLING !== "0");

  return {
    enabled,
    region: env.AWS_REGION || "eu-central-1",
    accessKeyId: env.SES_AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.SES_AWS_SECRET_ACCESS_KEY || undefined,
    bucket,
    pendingPrefix: normalizePrefix(env.SES_INBOUND_PREFIX || "inbound/"),
    processedPrefix: normalizePrefix(env.SES_INBOUND_PROCESSED_PREFIX || "processed/"),
    failedPrefix: normalizePrefix(env.SES_INBOUND_FAILED_PREFIX || "failed/"),
    batchSize: positiveInt(env.SES_INBOUND_POLL_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    pollIntervalMs: positiveInt(
      env.SES_INBOUND_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS
    )
  };
}

export class S3SesInboundObjectStore implements SesInboundObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: S3ClientConfig = {}
  ) {
    this.client = new S3Client(options);
  }

  async listPendingObjects(input: {
    prefix: string;
    batchSize: number;
  }): Promise<SesInboundS3Object[]> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: input.prefix,
        MaxKeys: input.batchSize
      })
    );

    return (result.Contents ?? [])
      .filter((item) => item.Key && item.Key !== input.prefix)
      .map((item) => ({
        key: item.Key as string,
        size: item.Size
      }));
  }

  async readObject(input: { key: string }): Promise<Uint8Array> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key
      })
    );
    return bodyToBytes(result.Body);
  }

  async moveObject(input: {
    sourceKey: string;
    destinationKey: string;
  }): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeS3CopySourceKey(input.sourceKey)}`,
        Key: input.destinationKey
      })
    );
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: input.sourceKey
      })
    );
  }
}

export async function processSesInboundS3Batch(input: {
  config: SesInboundPollerConfig;
  store?: SesInboundObjectStore;
  parseInbound?: (input: unknown) => Promise<InboundEmail>;
  processEmail?: (email: InboundEmail) => Promise<InboundEmailProcessingResult>;
  logger?: Pick<Console, "log" | "warn" | "error">;
}): Promise<SesInboundProcessResult[]> {
  if (!input.config.enabled) {
    return [];
  }
  if (!input.config.bucket) {
    throw new Error("SES_INBOUND_BUCKET is required when SES inbound polling is enabled.");
  }

  const logger = input.logger ?? console;
  const store =
    input.store ??
    new S3SesInboundObjectStore(input.config.bucket, {
      region: input.config.region,
      credentials:
        input.config.accessKeyId && input.config.secretAccessKey
          ? {
              accessKeyId: input.config.accessKeyId,
              secretAccessKey: input.config.secretAccessKey
            }
          : undefined
    });
  const parseInbound =
    input.parseInbound ??
    ((payload: unknown) =>
      new SesEmailProvider({ region: input.config.region }).parseInbound(payload));
  const processEmail = input.processEmail ?? processInboundEmail;

  const objects = await store.listPendingObjects({
    prefix: input.config.pendingPrefix,
    batchSize: input.config.batchSize
  });
  const results: SesInboundProcessResult[] = [];

  for (const object of objects) {
    if (shouldSkipObject(object)) {
      continue;
    }

    const result = await processSesInboundS3Object({
      config: input.config,
      store,
      object,
      parseInbound,
      processEmail
    });
    results.push(result);

    if (result.outcome === "FAILED") {
      logger.warn(
        `SES inbound object ${object.key} moved to ${result.destinationKey}: ${result.error}`
      );
    } else {
      logger.log(
        `SES inbound object ${object.key} processed as ${result.processing?.kind}.`
      );
    }
  }

  return results;
}

export async function processSesInboundS3Object(input: {
  config: SesInboundPollerConfig;
  store: SesInboundObjectStore;
  object: SesInboundS3Object;
  parseInbound: (input: unknown) => Promise<InboundEmail>;
  processEmail: (email: InboundEmail) => Promise<InboundEmailProcessingResult>;
}): Promise<SesInboundProcessResult> {
  try {
    const raw = await input.store.readObject({ key: input.object.key });
    const email = await input.parseInbound({
      providerId: input.object.key,
      raw
    });
    const processing = await input.processEmail(email);
    if (processing.kind === "UNMATCHED") {
      const destinationKey = destinationObjectKey(
        input.config,
        input.object.key,
        input.config.failedPrefix
      );
      await input.store.moveObject({
        sourceKey: input.object.key,
        destinationKey
      });
      return {
        key: input.object.key,
        destinationKey,
        outcome: "FAILED",
        processing,
        error: processing.reason
      };
    }

    const destinationKey = destinationObjectKey(
      input.config,
      input.object.key,
      input.config.processedPrefix
    );
    await input.store.moveObject({
      sourceKey: input.object.key,
      destinationKey
    });
    return {
      key: input.object.key,
      destinationKey,
      outcome: "PROCESSED",
      processing,
      error: null
    };
  } catch (error) {
    const destinationKey = destinationObjectKey(
      input.config,
      input.object.key,
      input.config.failedPrefix
    );
    await input.store.moveObject({
      sourceKey: input.object.key,
      destinationKey
    });
    return {
      key: input.object.key,
      destinationKey,
      outcome: "FAILED",
      processing: null,
      error: error instanceof Error ? error.message : "Unknown SES inbound processing error."
    };
  }
}

function destinationObjectKey(
  config: SesInboundPollerConfig,
  sourceKey: string,
  destinationPrefix: string
): string {
  const suffix = sourceKey.startsWith(config.pendingPrefix)
    ? sourceKey.slice(config.pendingPrefix.length)
    : basename(sourceKey);
  return `${destinationPrefix}${suffix || basename(sourceKey)}`;
}

function shouldSkipObject(object: SesInboundS3Object): boolean {
  return (
    object.key.endsWith("/") ||
    basename(object.key) === "AMAZON_SES_SETUP_NOTIFICATION"
  );
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function encodeS3CopySourceKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) {
    throw new Error("SES inbound S3 object has no body.");
  }

  if (body instanceof Uint8Array) {
    return body;
  }

  if (
    typeof body === "object" &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray ===
      "function"
  ) {
    return (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }

  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported SES inbound S3 object body type.");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}
