CREATE TABLE IF NOT EXISTS "InvoiceUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "parseError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "amountTotal" REAL,
    "currency" TEXT,
    "supplierName" TEXT,
    "supplierIco" TEXT,
    "supplierDic" TEXT,
    "supplierIcDph" TEXT,
    "supplierAddress" TEXT,
    "debtorName" TEXT,
    "debtorIco" TEXT,
    "debtorDic" TEXT,
    "debtorIcDph" TEXT,
    "debtorAddress" TEXT,
    "iban" TEXT,
    "variableSymbol" TEXT,
    "constantSymbol" TEXT,
    "specificSymbol" TEXT,
    "subjectNote" TEXT,
    "rawAiResult" TEXT,
    "aiConfidence" REAL,
    "warnings" TEXT,
    "confirmedByUser" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "InvoiceUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "InvoiceActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT,
    "uploadId" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceActionLog_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InvoiceActionLog_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "InvoiceUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "InvoiceUpload_userId_idx" ON "InvoiceUpload"("userId");
CREATE INDEX IF NOT EXISTS "InvoiceUpload_status_idx" ON "InvoiceUpload"("status");
CREATE INDEX IF NOT EXISTS "InvoiceUpload_createdAt_idx" ON "InvoiceUpload"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_uploadId_key" ON "Invoice"("uploadId");
CREATE INDEX IF NOT EXISTS "Invoice_userId_idx" ON "Invoice"("userId");
CREATE INDEX IF NOT EXISTS "Invoice_invoiceNumber_idx" ON "Invoice"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "Invoice_dueDate_idx" ON "Invoice"("dueDate");
CREATE INDEX IF NOT EXISTS "Invoice_createdAt_idx" ON "Invoice"("createdAt");
CREATE INDEX IF NOT EXISTS "InvoiceActionLog_invoiceId_idx" ON "InvoiceActionLog"("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceActionLog_uploadId_idx" ON "InvoiceActionLog"("uploadId");
CREATE INDEX IF NOT EXISTS "InvoiceActionLog_action_idx" ON "InvoiceActionLog"("action");
CREATE INDEX IF NOT EXISTS "InvoiceActionLog_createdAt_idx" ON "InvoiceActionLog"("createdAt");
