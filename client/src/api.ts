import type { ApiInvoice, InvoicePayload } from "./types";

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      Array.isArray(payload.errors) && payload.errors.length > 0
        ? payload.errors.join(" ")
        : payload.error ?? "Požiadavka zlyhala.";
    throw new Error(message);
  }

  return payload as T;
}

export async function listInvoices() {
  return parseResponse<{ invoices: ApiInvoice[] }>(await fetch("/api/invoices"));
}

export async function uploadInvoice(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return parseResponse<{ invoice: ApiInvoice; parseError: string | null }>(
    await fetch("/api/invoice-uploads", {
      method: "POST",
      body: formData
    })
  );
}

export async function patchInvoice(id: string, payload: Partial<InvoicePayload>) {
  return parseResponse<{ invoice: ApiInvoice }>(
    await fetch(`/api/invoices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export async function confirmInvoice(id: string, payload: Partial<InvoicePayload>) {
  return parseResponse<{ invoice: ApiInvoice }>(
    await fetch(`/api/invoices/${id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  );
}

export async function cancelUpload(uploadId: string) {
  return parseResponse<{ invoice: ApiInvoice | null; upload: { id: string; status: string } }>(
    await fetch(`/api/invoice-uploads/${uploadId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    })
  );
}
