ALTER TABLE "Communication"
ADD COLUMN "messageId" TEXT,
ADD COLUMN "inReplyTo" TEXT,
ADD COLUMN "references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "Communication_messageId_idx" ON "Communication"("messageId");
