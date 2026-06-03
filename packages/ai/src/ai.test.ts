import { describe, expect, it } from "vitest";
import { buildInvoiceFileInput } from "./input";
import { MockAiProvider } from "./mock-provider";

describe("AI provider", () => {
  it("sends PDFs as Responses input_file with data-url file_data", () => {
    expect(
      buildInvoiceFileInput({
        fileName: "faktura.pdf",
        mimeType: "application/pdf",
        base64: "JVBERi0xLjQ="
      })
    ).toEqual({
      type: "input_file",
      filename: "faktura.pdf",
      file_data: "data:application/pdf;base64,JVBERi0xLjQ="
    });
  });

  it("sends images as high-detail data-url image inputs", () => {
    expect(
      buildInvoiceFileInput({
        fileName: "faktura.png",
        mimeType: "image/png",
        base64: "iVBORw0KGgo="
      })
    ).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,iVBORw0KGgo=",
      detail: "high"
    });
  });

  it("keeps a deterministic mock extraction path", async () => {
    const result = await new MockAiProvider().extractInvoice({
      fileName: "faktura.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3])
    });

    expect(result.currency).toBe("EUR");
    expect(result.manualReviewRequired).toBe(false);
  });
});
