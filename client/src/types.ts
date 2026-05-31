export type UploadStatus =
  | "UPLOADED"
  | "PARSING"
  | "PARSED"
  | "NEEDS_REVIEW"
  | "REGISTERED"
  | "PARSE_FAILED"
  | "CANCELLED";

export type ApiInvoice = {
  id: string;
  uploadId: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amountTotal: number | null;
  currency: string | null;
  supplierName: string | null;
  supplierIco: string | null;
  supplierDic: string | null;
  supplierIcDph: string | null;
  supplierAddress: string | null;
  debtorName: string | null;
  debtorIco: string | null;
  debtorDic: string | null;
  debtorIcDph: string | null;
  debtorAddress: string | null;
  iban: string | null;
  variableSymbol: string | null;
  constantSymbol: string | null;
  specificSymbol: string | null;
  subjectNote: string | null;
  aiConfidence: number | null;
  warnings: string[];
  confirmedByUser: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  upload: {
    id: string;
    fileName: string;
    fileType: string;
    fileSize: number;
    status: UploadStatus;
    parseError: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

export type InvoicePayload = {
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  amountTotal: number | null;
  currency: string | null;
  supplierName: string | null;
  supplierIco: string | null;
  supplierDic: string | null;
  supplierIcDph: string | null;
  supplierAddress: string | null;
  debtorName: string | null;
  debtorIco: string | null;
  debtorDic: string | null;
  debtorIcDph: string | null;
  debtorAddress: string | null;
  iban: string | null;
  variableSymbol: string | null;
  constantSymbol: string | null;
  specificSymbol: string | null;
  subjectNote: string | null;
};
