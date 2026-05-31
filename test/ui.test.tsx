import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../client/src/App";
import type { ApiInvoice } from "../client/src/types";

const invoice: ApiInvoice = {
  id: "inv_1",
  uploadId: "upl_1",
  invoiceNumber: "FV-2026-00124",
  issueDate: "2026-05-20",
  dueDate: "2026-06-03",
  amountTotal: 480,
  currency: "EUR",
  supplierName: "ABC s.r.o.",
  supplierIco: "12345678",
  supplierDic: "2020123456",
  supplierIcDph: "SK2020123456",
  supplierAddress: "Hlavná 12, Bratislava",
  debtorName: "XYZ s.r.o.",
  debtorIco: "87654321",
  debtorDic: "2020654321",
  debtorIcDph: "SK2020654321",
  debtorAddress: "Dlhá 4, Košice",
  iban: "SK1211000000002941987654",
  variableSymbol: "202600124",
  constantSymbol: null,
  specificSymbol: null,
  subjectNote: "Dodanie služieb",
  aiConfidence: 0.86,
  warnings: ["Skontrolujte IBAN."],
  confirmedByUser: null,
  confirmedAt: null,
  createdAt: "2026-05-31T09:00:00.000Z",
  updatedAt: "2026-05-31T09:00:00.000Z",
  upload: {
    id: "upl_1",
    fileName: "faktura.pdf",
    fileType: "application/pdf",
    fileSize: 1024,
    status: "NEEDS_REVIEW",
    parseError: null,
    createdAt: "2026-05-31T09:00:00.000Z",
    updatedAt: "2026-05-31T09:00:00.000Z"
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FAKTURIO UI", () => {
  it("loads parsed invoice data, saves edits, and confirms", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/invoices") {
        return json({ invoices: [invoice] });
      }

      if (url === "/api/invoices/inv_1" && method === "PATCH") {
        const body = JSON.parse(String(init?.body));
        return json({ invoice: { ...invoice, ...body, updatedAt: "2026-05-31T09:01:00.000Z" } });
      }

      if (url === "/api/invoices/inv_1/confirm" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return json({
          invoice: {
            ...invoice,
            ...body,
            confirmedByUser: "local-user",
            confirmedAt: "2026-05-31T09:02:00.000Z",
            upload: { ...invoice.upload, status: "REGISTERED" }
          }
        });
      }

      return json({ error: "Not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    const invoiceNumber = await screen.findByLabelText("Faktúra č.*");
    await waitFor(() => expect(invoiceNumber).toHaveValue("FV-2026-00124"));
    expect(screen.getAllByText("NEEDS_REVIEW").length).toBeGreaterThan(0);
    expect(screen.getByText("Skontrolujte IBAN.")).toBeInTheDocument();

    await user.clear(invoiceNumber);
    await user.type(invoiceNumber, "FV-2026-00125");
    await user.tab();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/invoices/inv_1",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    const confirmButton = screen.getByRole("button", { name: /Potvrdiť a uložiť/i });
    await waitFor(() => expect(confirmButton).not.toBeDisabled());
    await user.click(confirmButton);

    await screen.findByText("Faktúra bola registrovaná.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/invoices/inv_1/confirm",
      expect.objectContaining({ method: "POST" })
    );
  });
});

function json(payload: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" }
    })
  );
}
