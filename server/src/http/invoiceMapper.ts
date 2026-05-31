import type { Invoice, InvoiceUpload } from "@prisma/client";
import { formatIsoDate, parseWarnings } from "../domain/validators.js";

export type InvoiceWithUpload = Invoice & {
  upload: InvoiceUpload;
};

export function mapInvoice(invoice: InvoiceWithUpload) {
  return {
    id: invoice.id,
    uploadId: invoice.uploadId,
    userId: invoice.userId,
    invoiceNumber: invoice.invoiceNumber,
    issueDate: formatIsoDate(invoice.issueDate),
    dueDate: formatIsoDate(invoice.dueDate),
    amountTotal: invoice.amountTotal,
    currency: invoice.currency,
    supplierName: invoice.supplierName,
    supplierIco: invoice.supplierIco,
    supplierDic: invoice.supplierDic,
    supplierIcDph: invoice.supplierIcDph,
    supplierAddress: invoice.supplierAddress,
    debtorName: invoice.debtorName,
    debtorIco: invoice.debtorIco,
    debtorDic: invoice.debtorDic,
    debtorIcDph: invoice.debtorIcDph,
    debtorAddress: invoice.debtorAddress,
    iban: invoice.iban,
    variableSymbol: invoice.variableSymbol,
    constantSymbol: invoice.constantSymbol,
    specificSymbol: invoice.specificSymbol,
    subjectNote: invoice.subjectNote,
    aiConfidence: invoice.aiConfidence,
    warnings: parseWarnings(invoice.warnings),
    confirmedByUser: invoice.confirmedByUser,
    confirmedAt: invoice.confirmedAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
    upload: {
      id: invoice.upload.id,
      fileName: invoice.upload.fileName,
      fileType: invoice.upload.fileType,
      fileSize: invoice.upload.fileSize,
      status: invoice.upload.status,
      parseError: invoice.upload.parseError,
      createdAt: invoice.upload.createdAt.toISOString(),
      updatedAt: invoice.upload.updatedAt.toISOString()
    }
  };
}
