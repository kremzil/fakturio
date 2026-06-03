"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, Clock3, FileText, Gavel, Mail, RefreshCw, UploadCloud } from "lucide-react";
import type { DashboardCase } from "@/lib/case-data";

const statusLabels: Record<string, string> = {
  RECEIVED: "Prijaté",
  PARSED: "Načítané",
  MANUAL_REVIEW_REQUIRED: "Na kontrolu",
  WAITING_FOR_DUE_DATE: "Čaká na splatnosť",
  OVERDUE: "Po splatnosti",
  EMAIL_REMINDER_1_SENT: "1. pripomienka",
  EMAIL_REMINDER_2_SENT: "2. pripomienka",
  PAYMENT_REQUEST_SENT: "Výzva odoslaná",
  READY_FOR_LEGAL_ACTION: "Pripravené pre právnika",
  CLOSED_PAID: "Uhradené",
  CLOSED_CANCELLED: "Zastavené",
  CLOSED_UNRESOLVED: "Nevyriešené"
};

type ReviewFormState = {
  invoiceNumber: string;
  supplierName: string;
  debtorName: string;
  debtorEmail: string;
  amountTotal: string;
  currency: string;
  dueDate: string;
  iban: string;
  variableSymbol: string;
};

export function Dashboard({ initialCases }: { initialCases: DashboardCase[] }) {
  const [cases, setCases] = useState(initialCases);
  const [selectedId, setSelectedId] = useState(initialCases[0]?.id ?? null);
  const [isUploading, setUploading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [isConfirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? cases[0] ?? null, [cases, selectedId]);
  const [reviewForm, setReviewForm] = useState<ReviewFormState>(() => toReviewForm(initialCases[0] ?? null));

  useEffect(() => {
    setReviewForm(toReviewForm(selected));
    setValidationErrors([]);
  }, [selected]);

  async function uploadInvoice(formData: FormData) {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Vyberte PDF alebo obrázok faktúry.");
      return;
    }

    setUploading(true);
    setMessage(null);

    const response = await fetch("/api/cases/upload", {
      method: "POST",
      body: formData
    });
    const payload = await response.json();
    setUploading(false);

    if (!response.ok) {
      setMessage(payload.error ?? "Nahratie zlyhalo.");
      return;
    }

    setCases((current) => [payload.case, ...current.filter((item) => item.id !== payload.case.id)]);
    setSelectedId(payload.case.id);
    setMessage("Faktúra bola načítaná do nového prípadu.");
  }

  async function markPaid(caseId: string) {
    const response = await fetch(`/api/cases/${caseId}/mark-paid`, { method: "POST" });
    const payload = await response.json();
    if (response.ok) {
      setCases((current) => current.map((item) => (item.id === caseId ? payload.case : item)));
      setMessage("Prípad bol označený ako uhradený.");
    } else {
      setMessage(payload.error ?? "Zmena statusu zlyhala.");
    }
  }

  async function saveDraft() {
    if (!selected) {
      return;
    }

    setSaving(true);
    setMessage(null);
    setValidationErrors([]);

    const response = await fetch(`/api/cases/${selected.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toDraftPayload(reviewForm))
    });
    const payload = await response.json();
    setSaving(false);

    if (response.ok) {
      setCases((current) => current.map((item) => (item.id === selected.id ? payload.case : item)));
      setMessage("Zmeny boli uložené.");
    } else {
      setMessage(payload.error ?? "Uloženie zlyhalo.");
    }
  }

  async function confirmCase() {
    if (!selected) {
      return;
    }

    await saveDraft();
    setConfirming(true);
    setMessage(null);
    setValidationErrors([]);

    const response = await fetch(`/api/cases/${selected.id}/confirm`, { method: "POST" });
    const payload = await response.json();
    setConfirming(false);

    if (response.ok) {
      setCases((current) => current.map((item) => (item.id === selected.id ? payload.case : item)));
      setMessage("Faktúra bola potvrdená a uložená do workflow.");
    } else {
      setValidationErrors(payload.errors ?? [payload.error ?? "Potvrdenie zlyhalo."]);
    }
  }

  function updateReviewField(field: keyof ReviewFormState, value: string) {
    setReviewForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <main className="min-h-screen p-4 text-ink md:p-6">
      <div className="grid min-h-[calc(100vh-48px)] grid-cols-1 overflow-hidden rounded-lg border border-zincLine bg-paper shadow-panel lg:grid-cols-[220px_minmax(420px,1fr)_440px]">
        <aside className="border-b border-zincLine bg-ink p-5 text-paper lg:border-b-0 lg:border-r">
          <div className="font-display text-3xl tracking-normal">FAKTURIO</div>
          <div className="mt-2 text-xs uppercase tracking-[0.18em] text-paper/55">soft collection OS</div>
          <nav className="mt-10 space-y-2 text-sm">
            {[
              ["Prípady", FileText],
              ["Komunikácia", Mail],
              ["Workflow", Clock3],
              ["Legal package", Gavel],
              ["Archív", Archive]
            ].map(([label, Icon]) => (
              <button
                key={label as string}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-paper/78 transition hover:bg-paper/10 hover:text-paper"
              >
                <Icon className="h-4 w-4" />
                {label as string}
              </button>
            ))}
          </nav>
          <div className="mt-10 rounded-md border border-paper/15 p-3 text-xs leading-5 text-paper/65">
            AI pripravuje štruktúrované údaje a návrhy. Stav prípadu riadi backend workflow, nie model.
          </div>
        </aside>

        <section className="border-b border-zincLine lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-4 border-b border-zincLine p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="font-display text-3xl">Kontrola faktúr</h1>
              <p className="mt-1 text-sm text-steel">Prijaté faktúry, termíny splatnosti a automatizovaný soft-collection workflow.</p>
            </div>
            <form action={uploadInvoice} className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-ink/15 bg-white px-3 py-2 text-sm transition hover:border-ink/35">
                <UploadCloud className="h-4 w-4" />
                <span>Nahrať inú faktúru</span>
                <input className="hidden" name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" />
              </label>
              <button
                className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-3 text-sm text-paper transition hover:bg-ink/90 disabled:opacity-50"
                disabled={isUploading}
                type="submit"
              >
                {isUploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Spracovať
              </button>
            </form>
          </div>

          {message ? <div className="border-b border-zincLine bg-ledger/35 px-5 py-3 text-sm">{message}</div> : null}

          <div className="grid gap-3 p-4">
            {cases.map((item) => (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`grid gap-3 rounded-md border p-4 text-left transition ${
                  selected?.id === item.id ? "border-ink bg-white" : "border-zincLine bg-white/58 hover:border-ink/30"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em] text-steel">
                      <span>{statusLabels[item.status] ?? item.status}</span>
                      <span>{item.sourceType === "EMAIL" ? "Email" : "Upload"}</span>
                    </div>
                    <div className="mt-1 text-lg font-semibold">{item.invoiceNumber ?? "Bez čísla faktúry"}</div>
                  </div>
                  <div className="rounded-md bg-ink px-2 py-1 text-xs text-paper">
                    {item.amountTotal ? `${item.amountTotal.toFixed(2)} ${item.currency ?? ""}` : "suma ?"}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm text-steel">
                  <span>{item.debtorName ?? "Dlžník neznámy"}</span>
                  <span className="text-right">Splatnosť {item.dueDate ?? "?"}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <aside className="bg-[#fbfaf6] p-5">
          {selected ? (
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-steel">Revízia prípadu</div>
                <h2 className="mt-2 font-display text-3xl">Načítané údaje z faktúry</h2>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <ReviewField label="Faktúra č." value={reviewForm.invoiceNumber} onChange={(value) => updateReviewField("invoiceNumber", value)} />
                <ReviewField label="Dátum splatnosti" type="date" value={reviewForm.dueDate} onChange={(value) => updateReviewField("dueDate", value)} />
                <ReviewField label="Dodávateľ" value={reviewForm.supplierName} onChange={(value) => updateReviewField("supplierName", value)} />
                <ReviewField label="Odberateľ" value={reviewForm.debtorName} onChange={(value) => updateReviewField("debtorName", value)} />
                <ReviewField label="Suma na úhradu" type="number" value={reviewForm.amountTotal} onChange={(value) => updateReviewField("amountTotal", value)} />
                <ReviewField label="Mena" value={reviewForm.currency} onChange={(value) => updateReviewField("currency", value)} />
                <ReviewField label="IBAN" value={reviewForm.iban} onChange={(value) => updateReviewField("iban", value)} className="col-span-2" />
                <ReviewField
                  label="Variabilný symbol"
                  value={reviewForm.variableSymbol}
                  onChange={(value) => updateReviewField("variableSymbol", value)}
                  className="col-span-2"
                />
              </div>

              {selected.warnings.length > 0 ? (
                <div className="rounded-md border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
                  <div className="mb-2 flex items-center gap-2 font-semibold">
                    <AlertTriangle className="h-4 w-4" />
                    Vyžaduje pozornosť
                  </div>
                  {selected.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              ) : null}

              {validationErrors.length > 0 ? (
                <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                  {validationErrors.map((error) => (
                    <div key={error}>{error}</div>
                  ))}
                </div>
              ) : null}

              <div className="rounded-md border border-zincLine bg-white p-4">
                <div className="mb-3 text-sm font-semibold">Timeline</div>
                <div className="space-y-3">
                  {selected.events.length === 0 ? (
                    <div className="text-sm text-steel">Zatiaľ bez udalostí.</div>
                  ) : (
                    selected.events.map((event) => (
                      <div key={event.id} className="border-l-2 border-ledger pl-3 text-sm">
                        <div className="font-medium">{event.type}</div>
                        <div className="text-steel">{event.note ?? new Date(event.createdAt).toLocaleString("sk-SK")}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  className="rounded-md border border-ink/20 px-3 py-2 text-sm transition hover:border-ink/45 disabled:opacity-50"
                  disabled={isSaving || isConfirming}
                  onClick={saveDraft}
                >
                  {isSaving ? "Ukladám..." : "Uložiť zmeny"}
                </button>
                <button
                  className="flex-1 rounded-md bg-ink px-3 py-2 text-sm text-paper transition hover:bg-ink/90 disabled:opacity-50"
                  disabled={isSaving || isConfirming}
                  onClick={confirmCase}
                >
                  {isConfirming ? "Potvrdzujem..." : "Potvrdiť a uložiť"}
                </button>
                <button className="rounded-md border border-ink/20 px-3 py-2 text-sm" onClick={() => markPaid(selected.id)}>
                  Uhradené
                </button>
              </div>
            </div>
          ) : (
            <div className="text-sm text-steel">Nahrajte faktúru alebo vyberte prípad.</div>
          )}
        </aside>
      </div>
    </main>
  );
}

function ReviewField({
  label,
  value,
  onChange,
  type = "text",
  className = ""
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date";
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs uppercase tracking-[0.13em] text-steel">{label}</span>
      <input
        className="mt-1 h-10 w-full rounded-md border border-zincLine bg-white px-3 text-sm font-medium outline-none transition focus:border-ink"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function toReviewForm(item: DashboardCase | null): ReviewFormState {
  return {
    invoiceNumber: item?.invoiceNumber ?? "",
    supplierName: item?.supplierName ?? "",
    debtorName: item?.debtorName ?? "",
    debtorEmail: item?.debtorEmail ?? "",
    amountTotal: item?.amountTotal?.toString() ?? "",
    currency: item?.currency ?? "EUR",
    dueDate: item?.dueDate ?? "",
    iban: item?.iban ?? "",
    variableSymbol: item?.variableSymbol ?? ""
  };
}

function toDraftPayload(form: ReviewFormState) {
  return {
    invoiceNumber: form.invoiceNumber,
    supplierName: form.supplierName,
    debtorName: form.debtorName,
    debtorEmail: form.debtorEmail,
    amountTotal: form.amountTotal ? Number(form.amountTotal) : null,
    currency: form.currency,
    dueDate: form.dueDate,
    iban: form.iban,
    variableSymbol: form.variableSymbol
  };
}
