CREATE TYPE "PaymentCheckReason" AS ENUM (
    'DUE_DATE',
    'FOLLOW_UP',
    'DEBTOR_CLAIMED_PAID',
    'PROMISE_DUE',
    'INSTALLMENT_PAYMENT'
);

CREATE TYPE "PaymentCheckStatus" AS ENUM (
    'PENDING',
    'SENT',
    'RESOLVED_PAID',
    'RESOLVED_NOT_PAID'
);

CREATE TYPE "InstallmentPlanStatus" AS ENUM (
    'PROPOSED',
    'ACTIVE',
    'COMPLETED',
    'BROKEN',
    'REJECTED'
);

CREATE TYPE "InstallmentPaymentStatus" AS ENUM (
    'PENDING',
    'PAID',
    'MISSED',
    'MANUAL_REVIEW_REQUIRED'
);

ALTER TABLE "Case"
ADD COLUMN "nextActionAt" TIMESTAMP(3),
ADD COLUMN "automationPausedAt" TIMESTAMP(3),
ADD COLUMN "automationPauseReason" TEXT,
ADD COLUMN "clarificationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "promiseExtensionUsed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "PaymentPromise"
ADD COLUMN "communicationId" TEXT;

CREATE TABLE "PaymentCheck" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "communicationId" TEXT,
    "installmentPaymentId" TEXT,
    "sourceKey" TEXT NOT NULL,
    "reason" "PaymentCheckReason" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "PaymentCheckStatus" NOT NULL DEFAULT 'PENDING',
    "expectedAmount" DECIMAL(12,2),
    "currency" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentCheck_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstallmentPlan" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceCommunicationId" TEXT,
    "status" "InstallmentPlanStatus" NOT NULL DEFAULT 'PROPOSED',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "brokenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstallmentPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstallmentPayment" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "InstallmentPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "missedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstallmentPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommunicationAttachment" (
    "id" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentCheck_installmentPaymentId_key" ON "PaymentCheck"("installmentPaymentId");
CREATE UNIQUE INDEX "PaymentCheck_sourceKey_key" ON "PaymentCheck"("sourceKey");
CREATE INDEX "PaymentCheck_caseId_idx" ON "PaymentCheck"("caseId");
CREATE INDEX "PaymentCheck_status_idx" ON "PaymentCheck"("status");
CREATE INDEX "PaymentCheck_expiresAt_idx" ON "PaymentCheck"("expiresAt");
CREATE INDEX "InstallmentPlan_caseId_idx" ON "InstallmentPlan"("caseId");
CREATE INDEX "InstallmentPlan_status_idx" ON "InstallmentPlan"("status");
CREATE UNIQUE INDEX "InstallmentPayment_planId_sequence_key" ON "InstallmentPayment"("planId", "sequence");
CREATE INDEX "InstallmentPayment_dueDate_idx" ON "InstallmentPayment"("dueDate");
CREATE INDEX "InstallmentPayment_status_idx" ON "InstallmentPayment"("status");
CREATE INDEX "Case_nextActionAt_idx" ON "Case"("nextActionAt");
CREATE INDEX "Case_automationPausedAt_idx" ON "Case"("automationPausedAt");
CREATE INDEX "PaymentPromise_communicationId_idx" ON "PaymentPromise"("communicationId");
CREATE INDEX "CommunicationAttachment_communicationId_idx" ON "CommunicationAttachment"("communicationId");
CREATE UNIQUE INDEX "CommunicationAttachment_storageBucket_storageKey_key" ON "CommunicationAttachment"("storageBucket", "storageKey");
CREATE UNIQUE INDEX "CommunicationAttachment_communicationId_sha256_originalName_key" ON "CommunicationAttachment"("communicationId", "sha256", "originalName");

ALTER TABLE "PaymentPromise"
ADD CONSTRAINT "PaymentPromise_communicationId_fkey"
FOREIGN KEY ("communicationId") REFERENCES "Communication"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentCheck"
ADD CONSTRAINT "PaymentCheck_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "Case"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaymentCheck"
ADD CONSTRAINT "PaymentCheck_communicationId_fkey"
FOREIGN KEY ("communicationId") REFERENCES "Communication"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PaymentCheck"
ADD CONSTRAINT "PaymentCheck_installmentPaymentId_fkey"
FOREIGN KEY ("installmentPaymentId") REFERENCES "InstallmentPayment"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InstallmentPlan"
ADD CONSTRAINT "InstallmentPlan_caseId_fkey"
FOREIGN KEY ("caseId") REFERENCES "Case"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstallmentPlan"
ADD CONSTRAINT "InstallmentPlan_sourceCommunicationId_fkey"
FOREIGN KEY ("sourceCommunicationId") REFERENCES "Communication"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InstallmentPayment"
ADD CONSTRAINT "InstallmentPayment_planId_fkey"
FOREIGN KEY ("planId") REFERENCES "InstallmentPlan"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommunicationAttachment"
ADD CONSTRAINT "CommunicationAttachment_communicationId_fkey"
FOREIGN KEY ("communicationId") REFERENCES "Communication"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
