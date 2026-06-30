import { describe, expect, it, vi } from "vitest";
import type { InboundEmail } from "@fakturio/email";
import {
  processSesInboundS3Batch,
  sesInboundPollerConfig,
  type SesInboundObjectStore
} from "./ses-inbound-poller";

const baseConfig = sesInboundPollerConfig({
  EMAIL_DRIVER: "ses",
  AWS_REGION: "eu-central-1",
  SES_INBOUND_BUCKET: "test-bucket",
  SES_INBOUND_PREFIX: "inbound/",
  SES_INBOUND_PROCESSED_PREFIX: "processed/",
  SES_INBOUND_FAILED_PREFIX: "failed/",
  SES_INBOUND_POLL_BATCH_SIZE: "10"
} as unknown as NodeJS.ProcessEnv);

describe("SES inbound S3 poller", () => {
  it("parses a pending S3 object, processes the email and archives it", async () => {
    const store = objectStore([
      {
        key: "inbound/message-1",
        bytes: mimeBytes("reply+case@example.com")
      }
    ]);
    const processEmail = vi.fn(async () => ({
      kind: "DEBTOR_REPLY" as const,
      reply: {
        caseId: "case-1",
        organizationId: "org-1",
        communicationId: "comm-1",
        classification: null,
        classificationPending: true,
        duplicate: false
      }
    }));

    const results = await processSesInboundS3Batch({
      config: baseConfig,
      store,
      processEmail,
      logger: silentLogger()
    });

    expect(results).toMatchObject([
      {
        key: "inbound/message-1",
        destinationKey: "processed/message-1",
        outcome: "PROCESSED",
        error: null
      }
    ]);
    expect(processEmail).toHaveBeenCalledWith(
      expect.objectContaining<Partial<InboundEmail>>({
        provider: "ses",
        providerId: "inbound/message-1",
        to: ["reply+case@example.com"],
        subject: "Inbound test"
      })
    );
    expect(store.moveObject).toHaveBeenCalledWith({
      sourceKey: "inbound/message-1",
      destinationKey: "processed/message-1"
    });
  });

  it("moves unmatched mail to the failed prefix without retrying forever", async () => {
    const store = objectStore([
      {
        key: "inbound/message-2",
        bytes: mimeBytes("unknown@example.com")
      }
    ]);

    const results = await processSesInboundS3Batch({
      config: baseConfig,
      store,
      processEmail: async () => ({
        kind: "UNMATCHED",
        reason: "NO_REPLY_CASE_OR_INTAKE_ROUTE"
      }),
      logger: silentLogger()
    });

    expect(results).toMatchObject([
      {
        key: "inbound/message-2",
        destinationKey: "failed/message-2",
        outcome: "FAILED",
        error: "NO_REPLY_CASE_OR_INTAKE_ROUTE"
      }
    ]);
    expect(store.moveObject).toHaveBeenCalledWith({
      sourceKey: "inbound/message-2",
      destinationKey: "failed/message-2"
    });
  });

  it("leaves transient processing errors pending for retry", async () => {
    const store = objectStore([
      {
        key: "inbound/message-3",
        bytes: mimeBytes("reply+case@example.com")
      }
    ]);

    const results = await processSesInboundS3Batch({
      config: baseConfig,
      store,
      processEmail: async () => {
        throw new Error("Temporary AI timeout");
      },
      logger: silentLogger()
    });

    expect(results).toMatchObject([
      {
        key: "inbound/message-3",
        destinationKey: "inbound/message-3",
        outcome: "RETRYABLE_ERROR",
        error: "Temporary AI timeout"
      }
    ]);
    expect(store.moveObject).not.toHaveBeenCalled();
  });

  it("leaves transient S3 read errors pending for retry", async () => {
    const store = objectStore([
      {
        key: "inbound/message-4",
        bytes: mimeBytes("reply+case@example.com")
      }
    ]);
    store.readObject.mockRejectedValueOnce(new Error("S3 timeout"));

    const results = await processSesInboundS3Batch({
      config: baseConfig,
      store,
      logger: silentLogger()
    });

    expect(results).toMatchObject([
      {
        key: "inbound/message-4",
        destinationKey: "inbound/message-4",
        outcome: "RETRYABLE_ERROR",
        error: "S3 timeout"
      }
    ]);
    expect(store.moveObject).not.toHaveBeenCalled();
  });

  it("skips the SES setup notification object", async () => {
    const store = objectStore([
      {
        key: "inbound/AMAZON_SES_SETUP_NOTIFICATION",
        bytes: mimeBytes("setup@example.com")
      }
    ]);

    const results = await processSesInboundS3Batch({
      config: baseConfig,
      store,
      logger: silentLogger()
    });

    expect(results).toEqual([]);
    expect(store.readObject).not.toHaveBeenCalled();
    expect(store.moveObject).not.toHaveBeenCalled();
  });
});

function objectStore(
  objects: Array<{ key: string; bytes: Uint8Array }>
): SesInboundObjectStore & {
  readObject: ReturnType<typeof vi.fn>;
  moveObject: ReturnType<typeof vi.fn>;
} {
  const byKey = new Map(objects.map((item) => [item.key, item.bytes]));
  return {
    async listPendingObjects() {
      return objects.map((item) => ({ key: item.key, size: item.bytes.byteLength }));
    },
    readObject: vi.fn(async ({ key }: { key: string }) => {
      const bytes = byKey.get(key);
      if (!bytes) {
        throw new Error(`Missing test object ${key}.`);
      }
      return bytes;
    }),
    moveObject: vi.fn(async () => undefined)
  };
}

function mimeBytes(to: string): Uint8Array {
  return Buffer.from(
    [
      "From: Debtor <debtor@example.com>",
      `To: ${to}`,
      "Message-ID: <inbound-1@example.com>",
      "Subject: Inbound test",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Dobry den."
    ].join("\r\n")
  );
}

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}
