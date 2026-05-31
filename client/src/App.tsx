import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  Check,
  FileText,
  Loader2,
  ReceiptText,
  RotateCcw,
  Settings,
  UploadCloud
} from "lucide-react";
import { cancelUpload, confirmInvoice, listInvoices, patchInvoice, uploadInvoice } from "./api";
import type { ApiInvoice, InvoicePayload, UploadStatus } from "./types";

type FormState = Omit<InvoicePayload, "amountTotal"> & {
  amountTotal: string;
};

const emptyForm: FormState = {
  invoiceNumber: "",
  issueDate: "",
  dueDate: "",
  amountTotal: "",
  currency: "EUR",
  supplierName: "",
  supplierIco: "",
  supplierDic: "",
  supplierIcDph: "",
  supplierAddress: "",
  debtorName: "",
  debtorIco: "",
  debtorDic: "",
  debtorIcDph: "",
  debtorAddress: "",
  iban: "",
  variableSymbol: "",
  constantSymbol: "",
  specificSymbol: "",
  subjectNote: ""
};

const statusLabels: Record<UploadStatus, string> = {
  UPLOADED: "UPLOADED",
  PARSING: "PARSING",
  PARSED: "PARSED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  REGISTERED: "REGISTERED",
  PARSE_FAILED: "PARSE_FAILED",
  CANCELLED: "CANCELLED"
};

const statusTone: Record<UploadStatus, string> = {
  UPLOADED: "neutral",
  PARSING: "blue",
  PARSED: "blue",
  NEEDS_REVIEW: "amber",
  REGISTERED: "green",
  PARSE_FAILED: "red",
  CANCELLED: "neutral"
};

function toForm(invoice: ApiInvoice | null): FormState {
  if (!invoice) {
    return emptyForm;
  }

  return {
    invoiceNumber: invoice.invoiceNumber ?? "",
    issueDate: invoice.issueDate ?? "",
    dueDate: invoice.dueDate ?? "",
    amountTotal: invoice.amountTotal === null ? "" : String(invoice.amountTotal),
    currency: invoice.currency ?? "EUR",
    supplierName: invoice.supplierName ?? "",
    supplierIco: invoice.supplierIco ?? "",
    supplierDic: invoice.supplierDic ?? "",
    supplierIcDph: invoice.supplierIcDph ?? "",
    supplierAddress: invoice.supplierAddress ?? "",
    debtorName: invoice.debtorName ?? "",
    debtorIco: invoice.debtorIco ?? "",
    debtorDic: invoice.debtorDic ?? "",
    debtorIcDph: invoice.debtorIcDph ?? "",
    debtorAddress: invoice.debtorAddress ?? "",
    iban: invoice.iban ?? "",
    variableSymbol: invoice.variableSymbol ?? "",
    constantSymbol: invoice.constantSymbol ?? "",
    specificSymbol: invoice.specificSymbol ?? "",
    subjectNote: invoice.subjectNote ?? ""
  };
}

function toPayload(form: FormState): InvoicePayload {
  const text = (value: string | null) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const amount = form.amountTotal.replace(",", ".").trim();

  return {
    invoiceNumber: text(form.invoiceNumber),
    issueDate: text(form.issueDate),
    dueDate: text(form.dueDate),
    amountTotal: amount.length > 0 && !Number.isNaN(Number(amount)) ? Number(amount) : null,
    currency: text(form.currency),
    supplierName: text(form.supplierName),
    supplierIco: text(form.supplierIco),
    supplierDic: text(form.supplierDic),
    supplierIcDph: text(form.supplierIcDph),
    supplierAddress: text(form.supplierAddress),
    debtorName: text(form.debtorName),
    debtorIco: text(form.debtorIco),
    debtorDic: text(form.debtorDic),
    debtorIcDph: text(form.debtorIcDph),
    debtorAddress: text(form.debtorAddress),
    iban: text(form.iban),
    variableSymbol: text(form.variableSymbol),
    constantSymbol: text(form.constantSymbol),
    specificSymbol: text(form.specificSymbol),
    subjectNote: text(form.subjectNote)
  };
}

export default function App() {
  const [invoices, setInvoices] = useState<ApiInvoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refreshInvoices();
  }, []);

  const selectedInvoice = useMemo(
    () => invoices.find((invoice) => invoice.id === selectedId) ?? invoices[0] ?? null,
    [invoices, selectedId]
  );

  useEffect(() => {
    if (!selectedInvoice) {
      setForm(emptyForm);
      return;
    }

    setSelectedId(selectedInvoice.id);
    setForm(toForm(selectedInvoice));
  }, [selectedInvoice?.id]);

  async function refreshInvoices() {
    try {
      const response = await listInvoices();
      setInvoices(response.invoices);
      setSelectedId((current) => current ?? response.invoices[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Nepodarilo sa načítať faktúry.");
    }
  }

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await uploadInvoice(file);
      setInvoices((current) => [response.invoice, ...current.filter((item) => item.id !== response.invoice.id)]);
      setSelectedId(response.invoice.id);
      setMessage(response.parseError ? "Faktúra čaká na manuálne doplnenie." : "Údaje boli načítané na kontrolu.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Nahratie zlyhalo.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function saveDraft() {
    if (!selectedInvoice) {
      return null;
    }

    setError(null);

    try {
      const response = await patchInvoice(selectedInvoice.id, toPayload(form));
      replaceInvoice(response.invoice);
      return response.invoice;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uloženie úprav zlyhalo.");
      return null;
    }
  }

  async function handleConfirm() {
    if (!selectedInvoice) {
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const response = await confirmInvoice(selectedInvoice.id, toPayload(form));
      replaceInvoice(response.invoice);
      setMessage("Faktúra bola registrovaná.");
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Potvrdenie zlyhalo.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancel() {
    if (!selectedInvoice) {
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      const response = await cancelUpload(selectedInvoice.uploadId);
      if (response.invoice) {
        replaceInvoice(response.invoice);
      } else {
        await refreshInvoices();
      }
      setMessage("Nahratie bolo zrušené.");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Zrušenie zlyhalo.");
    } finally {
      setSaving(false);
    }
  }

  function replaceInvoice(invoice: ApiInvoice) {
    setInvoices((current) =>
      current
        .map((item) => {
          if (item.id !== invoice.id) {
            return item;
          }

          if (item.upload.status === "REGISTERED" && invoice.upload.status !== "REGISTERED") {
            return item;
          }

          return invoice;
        })
        .sort(sortInvoices)
    );
    setSelectedId(invoice.id);
  }

  const total = invoices.length;
  const waiting = invoices.filter((invoice) => invoice.upload.status === "NEEDS_REVIEW").length;
  const registered = invoices.filter((invoice) => invoice.upload.status === "REGISTERED").length;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <strong>FAKTURIO</strong>
            <span>Kontrola faktúr</span>
          </div>
        </div>

        <nav className="nav">
          <button className="nav-item active" type="button">
            <ReceiptText size={18} />
            Faktúry
          </button>
          <button className="nav-item" type="button" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud size={18} />
            Nahrať
          </button>
          <button className="nav-item" type="button">
            <Settings size={18} />
            Nastavenia
          </button>
        </nav>

        <div className="sidebar-summary">
          <Metric label="V systéme" value={total} />
          <Metric label="Na kontrolu" value={waiting} />
          <Metric label="Registrované" value={registered} />
        </div>
      </aside>

      <main className="workspace">
        <section className="list-panel">
          <div className="section-header">
            <div>
              <h1>Faktúry</h1>
              <p>AI parsing → human review → confirmed invoice</p>
            </div>
            <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : <UploadCloud size={17} />}
              Nahrať faktúru
            </button>
          </div>

          <div
            className={`upload-zone ${busy ? "uploading" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void handleFiles(event.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={(event) => void handleFiles(event.target.files)}
            />
            <UploadCloud size={22} />
            <div>
              <strong>Presuňte sem PDF alebo obrázok faktúry.</strong>
              <span>Po nahratí systém automaticky načíta údaje z faktúry.</span>
            </div>
          </div>

          <div className="invoice-table" aria-label="Zoznam faktúr">
            <div className="table-head">
              <span>Číslo faktúry</span>
              <span>Odberateľ</span>
              <span>Suma</span>
              <span>Splatnosť</span>
              <span>Stav</span>
            </div>
            {invoices.length === 0 ? (
              <div className="empty-row">Zatiaľ nie je nahratá žiadna faktúra.</div>
            ) : (
              invoices.map((invoice) => (
                <button
                  className={`table-row ${selectedInvoice?.id === invoice.id ? "selected" : ""}`}
                  key={invoice.id}
                  type="button"
                  onClick={() => setSelectedId(invoice.id)}
                >
                  <span>{invoice.invoiceNumber ?? "Bez čísla"}</span>
                  <span>{invoice.debtorName ?? "Doplniť"}</span>
                  <span>{formatMoney(invoice.amountTotal, invoice.currency)}</span>
                  <span>{invoice.dueDate ?? "Doplniť"}</span>
                  <Status status={invoice.upload.status} />
                </button>
              ))
            )}
          </div>
        </section>

        <section className="preview-panel">
          <div className="preview-header">
            <div>
              <span>Originálny súbor</span>
              <strong>{selectedInvoice?.upload.fileName ?? "Žiadny súbor"}</strong>
            </div>
            {selectedInvoice ? <Status status={selectedInvoice.upload.status} /> : null}
          </div>
          <DocumentPreview invoice={selectedInvoice} />
        </section>

        <section className="review-panel">
          <div className="review-title">
            <div>
              <h2>Načítané údaje z faktúry</h2>
              <p>{selectedInvoice ? "Skontrolujte a opravte polia pred uložením." : "Nahrajte faktúru."}</p>
            </div>
            {selectedInvoice?.aiConfidence !== null && selectedInvoice?.aiConfidence !== undefined ? (
              <span className="confidence">{Math.round(selectedInvoice.aiConfidence * 100)}%</span>
            ) : null}
          </div>

          {error ? (
            <div className="notice error">
              <AlertTriangle size={16} />
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="notice success">
              <Check size={16} />
              {message}
            </div>
          ) : null}
          {selectedInvoice?.warnings.map((warning) => (
            <div className="notice warning" key={warning}>
              <AlertTriangle size={16} />
              {warning}
            </div>
          ))}
          {selectedInvoice?.upload.parseError ? (
            <div className="notice error">
              <AlertTriangle size={16} />
              {selectedInvoice.upload.parseError}
            </div>
          ) : null}

          <form
            className="review-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            <Field label="Faktúra č." value={form.invoiceNumber} required onChange={(value) => updateField("invoiceNumber", value)} onBlur={saveDraft} />
            <div className="two-col">
              <Field label="Dátum vystavenia" type="date" value={form.issueDate} onChange={(value) => updateField("issueDate", value)} onBlur={saveDraft} icon={<CalendarDays size={15} />} />
              <Field label="Dátum splatnosti" type="date" value={form.dueDate} required onChange={(value) => updateField("dueDate", value)} onBlur={saveDraft} icon={<CalendarDays size={15} />} />
            </div>
            <div className="two-col amount-row">
              <Field label="Suma na úhradu" value={form.amountTotal} required onChange={(value) => updateField("amountTotal", value)} onBlur={saveDraft} />
              <Field label="Mena" value={form.currency} onChange={(value) => updateField("currency", value.toUpperCase())} onBlur={saveDraft} />
            </div>

            <Group title="Dodávateľ" icon={<Building2 size={16} />}>
              <Field label="Dodávateľ" value={form.supplierName} onChange={(value) => updateField("supplierName", value)} onBlur={saveDraft} />
              <div className="three-col">
                <Field label="IČO" value={form.supplierIco} onChange={(value) => updateField("supplierIco", value)} onBlur={saveDraft} />
                <Field label="DIČ" value={form.supplierDic} onChange={(value) => updateField("supplierDic", value)} onBlur={saveDraft} />
                <Field label="IČ DPH" value={form.supplierIcDph} onChange={(value) => updateField("supplierIcDph", value)} onBlur={saveDraft} />
              </div>
              <Field label="Adresa" value={form.supplierAddress} onChange={(value) => updateField("supplierAddress", value)} onBlur={saveDraft} />
            </Group>

            <Group title="Odberateľ" icon={<Building2 size={16} />}>
              <Field label="Odberateľ" value={form.debtorName} required onChange={(value) => updateField("debtorName", value)} onBlur={saveDraft} />
              <div className="three-col">
                <Field label="IČO" value={form.debtorIco} onChange={(value) => updateField("debtorIco", value)} onBlur={saveDraft} />
                <Field label="DIČ" value={form.debtorDic} onChange={(value) => updateField("debtorDic", value)} onBlur={saveDraft} />
                <Field label="IČ DPH" value={form.debtorIcDph} onChange={(value) => updateField("debtorIcDph", value)} onBlur={saveDraft} />
              </div>
              <Field label="Adresa" value={form.debtorAddress} onChange={(value) => updateField("debtorAddress", value)} onBlur={saveDraft} />
            </Group>

            <Group title="Platba" icon={<FileText size={16} />}>
              <Field label="IBAN" value={form.iban} onChange={(value) => updateField("iban", value)} onBlur={saveDraft} />
              <div className="three-col">
                <Field label="Variabilný symbol" value={form.variableSymbol} onChange={(value) => updateField("variableSymbol", value)} onBlur={saveDraft} />
                <Field label="Konštantný symbol" value={form.constantSymbol} onChange={(value) => updateField("constantSymbol", value)} onBlur={saveDraft} />
                <Field label="Špecifický symbol" value={form.specificSymbol} onChange={(value) => updateField("specificSymbol", value)} onBlur={saveDraft} />
              </div>
              <Field label="Predmet / poznámka" value={form.subjectNote} onChange={(value) => updateField("subjectNote", value)} onBlur={saveDraft} />
            </Group>

            <div className="form-actions">
              <button className="primary-button" type="submit" disabled={!selectedInvoice || saving}>
                {saving ? <Loader2 className="spin" size={17} /> : <Check size={17} />}
                Potvrdiť a uložiť
              </button>
              <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
                <UploadCloud size={17} />
                Nahrať inú faktúru
              </button>
              <button className="icon-button" type="button" onClick={handleCancel} disabled={!selectedInvoice || saving} title="Zrušiť nahratie">
                <RotateCcw size={17} />
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );

  function updateField<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
}

function Field({
  label,
  value,
  type = "text",
  required = false,
  icon,
  onChange,
  onBlur
}: {
  label: string;
  value: string | null;
  type?: string;
  required?: boolean;
  icon?: ReactNode;
  onChange: (value: string) => void;
  onBlur?: () => Promise<unknown> | unknown;
}) {
  return (
    <label className="field">
      <span>
        {icon}
        {label}
        {required ? <em>*</em> : null}
      </span>
      <input
        type={type}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => void onBlur?.()}
      />
    </label>
  );
}

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="field-group">
      <legend>
        {icon}
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function DocumentPreview({ invoice }: { invoice: ApiInvoice | null }) {
  if (!invoice) {
    return (
      <div className="preview-empty">
        <FileText size={32} />
        <span>PDF alebo obrázok sa zobrazí po nahratí.</span>
      </div>
    );
  }

  const fileUrl = `/api/invoice-uploads/${invoice.uploadId}/file`;

  if (invoice.upload.fileType === "application/pdf") {
    return <iframe className="document-frame" src={fileUrl} title={`Faktúra ${invoice.upload.fileName}`} />;
  }

  return <img className="document-image" src={fileUrl} alt={`Faktúra ${invoice.upload.fileName}`} />;
}

function Status({ status }: { status: UploadStatus }) {
  return <span className={`status ${statusTone[status]}`}>{statusLabels[status]}</span>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null || amount === undefined) {
    return "Doplniť";
  }

  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: currency ?? "EUR"
  }).format(amount);
}

function sortInvoices(a: ApiInvoice, b: ApiInvoice) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
