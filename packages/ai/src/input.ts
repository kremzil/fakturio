export type InvoiceFileInput = {
  type: "input_file";
  filename: string;
  file_data: string;
};

export type InvoiceImageInput = {
  type: "input_image";
  image_url: string;
  detail: "high";
};

export function buildInvoiceFileInput(input: {
  fileName: string;
  mimeType: string;
  base64: string;
}): InvoiceFileInput | InvoiceImageInput {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;

  return input.mimeType === "application/pdf"
    ? {
        type: "input_file",
        filename: input.fileName,
        file_data: dataUrl
      }
    : {
        type: "input_image",
        image_url: dataUrl,
        detail: "high"
      };
}
