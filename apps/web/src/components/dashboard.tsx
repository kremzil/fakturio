"use client";

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  CirclePause,
  CirclePlay,
  Clock3,
  FileText,
  Gavel,
  Inbox,
  Mail,
  Menu,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  Search,
  ShieldAlert,
  UploadCloud,
  Users,
  X
} from "lucide-react";
import type {
  DashboardCase,
  DashboardCommunication,
  DashboardEvent
} from "@/lib/case-data";
import type {
  DashboardDebtor,
  DashboardDebtorDetail
} from "@/lib/debtor-data";

const TERMINAL_STATUSES = new Set([
  "CLOSED_PAID",
  "CLOSED_CANCELLED",
  "CLOSED_UNRESOLVED"
]);
const REVIEW_STATUSES = new Set([
  "RECEIVED",
  "PARSED",
  "MANUAL_REVIEW_REQUIRED"
]);
const ATTENTION_STATUSES = new Set([
  "MANUAL_REVIEW_REQUIRED",
  "OVERDUE",
  "INSTALLMENT_BROKEN",
  "READY_FOR_LEGAL_ACTION"
]);
const PROMISE_STATUSES = new Set(["PAYMENT_PROMISED"]);
const INSTALLMENT_STATUSES = new Set([
  "INSTALLMENT_REQUESTED",
  "INSTALLMENT_PLAN_SENT",
  "INSTALLMENT_ACTIVE",
  "INSTALLMENT_BROKEN"
]);
const LEGAL_STATUSES = new Set([
  "INSTALLMENT_BROKEN",
  "FINAL_NOTICE_SENT",
  "READY_FOR_LEGAL_ACTION"
]);

const statusMeta: Record<
  string,
  { label: string; tone: "neutral" | "active" | "warn" | "danger" | "done" }
> = {
  RECEIVED: { label: "Prijaté", tone: "neutral" },
  PARSED: { label: "Načítané", tone: "neutral" },
  MANUAL_REVIEW_REQUIRED: { label: "Na kontrolu", tone: "warn" },
  WAITING_FOR_DUE_DATE: { label: "Čaká na splatnosť", tone: "active" },
  DUE_SOON: { label: "Blíži sa splatnosť", tone: "active" },
  OVERDUE: { label: "Po splatnosti", tone: "danger" },
  EMAIL_REMINDER_1_SENT: { label: "1. pripomienka", tone: "active" },
  EMAIL_REMINDER_2_SENT: { label: "2. pripomienka", tone: "warn" },
  PAYMENT_REQUEST_SENT: { label: "Výzva odoslaná", tone: "warn" },
  CALL_SCHEDULED: { label: "Hovor naplánovaný", tone: "warn" },
  CALL_COMPLETED: { label: "Hovor dokončený", tone: "neutral" },
  PAYMENT_PROMISED: { label: "Prisľúbená platba", tone: "active" },
  INSTALLMENT_REQUESTED: { label: "Žiadosť o splátky", tone: "warn" },
  INSTALLMENT_PLAN_SENT: { label: "Plán odoslaný", tone: "active" },
  INSTALLMENT_ACTIVE: { label: "Aktívne splátky", tone: "active" },
  INSTALLMENT_BROKEN: { label: "Porušené splátky", tone: "danger" },
  FINAL_NOTICE_SENT: { label: "Posledná výzva", tone: "warn" },
  READY_FOR_LEGAL_ACTION: { label: "Pripravené na právne kroky", tone: "danger" },
  CLOSED_PAID: { label: "Uhradené", tone: "done" },
  CLOSED_CANCELLED: { label: "Zastavené", tone: "neutral" },
  CLOSED_UNRESOLVED: { label: "Nevyriešené", tone: "neutral" }
};

type FilterId =
  | "ALL"
  | "ATTENTION"
  | "ACTIVE"
  | "PROMISES"
  | "INSTALLMENTS"
  | "CLOSED"
  | "COMMUNICATIONS"
  | "WORKFLOW"
  | "LEGAL";
type NavView =
  | "CASES"
  | "DEBTORS"
  | "COMMUNICATIONS"
  | "WORKFLOW"
  | "LEGAL"
  | "ARCHIVE";
type DebtorFilterId = "ALL" | "ACTIVE" | "WITHOUT_EMAIL";
type DetailTab = "OVERVIEW" | "TIMELINE" | "COMMUNICATIONS" | "ASSISTANT";
type ToastKind = "success" | "error" | "info";
type ToastMessage = {
  id: number;
  kind: ToastKind;
  text: string;
};
type ConfirmDialogState = {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
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
type ReviewFieldErrors = Partial<Record<keyof ReviewFormState, string>>;
type AssistantReplyState = {
  intent: string | null;
  subject: string | null;
  textBody: string;
};
type AssistantChatMessage = AssistantReplyState & {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  pending?: boolean;
};

export function Dashboard({
  initialCases,
  initialDebtors,
  organizationName
}: {
  initialCases: DashboardCase[];
  initialDebtors: DashboardDebtor[];
  organizationName: string;
}) {
  const [cases, setCases] = useState(initialCases);
  const [debtors, setDebtors] = useState(initialDebtors);
  const [selectedId, setSelectedId] = useState(initialCases[0]?.id ?? null);
  const [selectedDebtorId, setSelectedDebtorId] = useState(
    initialDebtors[0]?.id ?? null
  );
  const [debtorDetails, setDebtorDetails] = useState<
    Record<string, DashboardDebtorDetail>
  >({});
  const [debtorLoadingId, setDebtorLoadingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("ALL");
  const [debtorFilter, setDebtorFilter] = useState<DebtorFilterId>("ALL");
  const [navView, setNavView] = useState<NavView>("CASES");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [detailTab, setDetailTab] = useState<DetailTab>("OVERVIEW");
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [contactEmail, setContactEmail] = useState("");
  const [isContactSaving, setContactSaving] = useState(false);
  const [isUploading, setUploading] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [isConfirming, setConfirming] = useState(false);
  const [isActionPending, startActionTransition] = useTransition();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(
    null
  );
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [assistantThreads, setAssistantThreads] = useState<
    Record<string, AssistantChatMessage[]>
  >({});
  const [assistantPending, setAssistantPending] = useState(false);

  const filteredCases = useMemo(
    () => filterCases(cases, filter, deferredQuery),
    [cases, filter, deferredQuery]
  );
  const filteredDebtors = useMemo(
    () => filterDebtors(debtors, debtorFilter, deferredQuery),
    [debtors, debtorFilter, deferredQuery]
  );
  const selected = useMemo(
    () => cases.find((item) => item.id === selectedId) ?? cases[0] ?? null,
    [cases, selectedId]
  );
  const selectedCaseId = selected?.id ?? null;
  const counts = useMemo(() => summarizeCases(cases), [cases]);
  const debtorCounts = useMemo(() => summarizeDebtors(debtors), [debtors]);
  const selectedDebtor = useMemo(
    () =>
      debtors.find((item) => item.id === selectedDebtorId) ?? debtors[0] ?? null,
    [debtors, selectedDebtorId]
  );
  const [reviewForm, setReviewForm] = useState<ReviewFormState>(() =>
    toReviewForm(initialCases[0] ?? null)
  );

  useEffect(() => {
    setReviewForm(toReviewForm(selected));
    setContactEmail(selected?.debtorEmail ?? "");
    setReviewDirty(false);
  }, [selected]);

  useEffect(() => {
    setValidationErrors([]);
    setAssistantDraft("");
    setDetailTab("OVERVIEW");
  }, [selectedCaseId]);

  const assistantMessages = useMemo(
    () => (selectedCaseId ? assistantThreads[selectedCaseId] ?? [] : []),
    [assistantThreads, selectedCaseId]
  );

  useEffect(() => {
    if (!reviewDirty) {
      return;
    }
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [reviewDirty]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeout = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (
      navView === "DEBTORS" &&
      selectedDebtor &&
      !debtorDetails[selectedDebtor.id] &&
      debtorLoadingId !== selectedDebtor.id
    ) {
      void loadDebtorDetail(selectedDebtor.id);
    }
  }, [navView, selectedDebtor, debtorDetails, debtorLoadingId]);

  async function uploadInvoice(formData: FormData) {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      notify("error", "Vyberte PDF alebo obrázok faktúry.");
      return;
    }
    setUploading(true);
    clearToast();
    try {
      const response = await fetch("/api/cases/upload", {
        method: "POST",
        body: formData
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Nahratie zlyhalo.");
        return;
      }
      replaceCase(payload.case, true);
      notify("success", "Faktúra bola načítaná do nového prípadu.");
    } catch {
      notify("error", "Nahratie zlyhalo. Skontrolujte pripojenie a skúste to znova.");
    } finally {
      setUploading(false);
    }
  }

  async function saveDraft(showMessage = true): Promise<boolean> {
    if (!selected) {
      return false;
    }
    setSaving(true);
    setValidationErrors([]);
    try {
      const response = await fetch(`/api/cases/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toDraftPayload(reviewForm))
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Uloženie zlyhalo.");
        return false;
      }
      replaceCase(payload.case);
      setReviewDirty(false);
      if (showMessage) {
        notify("success", "Zmeny boli uložené.");
      }
      return true;
    } catch {
      notify("error", "Uloženie zlyhalo. Skontrolujte pripojenie a skúste to znova.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function confirmCase() {
    if (!selected || !(await saveDraft(false))) {
      return;
    }
    setConfirming(true);
    clearToast();
    setValidationErrors([]);
    try {
      const response = await fetch(`/api/cases/${selected.id}/confirm`, {
        method: "POST"
      });
      const payload = await readApiPayload(response);
      if (response.ok) {
        replaceCase(payload.case);
        notify("success", "Faktúra bola potvrdená a workflow je aktívny.");
      } else {
        notify("error", payload.error ?? "Potvrdenie zlyhalo.");
        setValidationErrors(
          payload.errors ?? [payload.error ?? "Potvrdenie zlyhalo."]
        );
      }
    } catch {
      notify("error", "Potvrdenie zlyhalo. Skontrolujte pripojenie a skúste to znova.");
    } finally {
      setConfirming(false);
    }
  }

  function runCaseAction(
    action:
      | "MARK_PAID"
      | "PAUSE_AUTOMATION"
      | "RESUME_AUTOMATION"
      | "CANCEL_CASE"
  ) {
    if (!selected) {
      return;
    }
    startActionTransition(async () => {
      clearToast();
      try {
        const response =
          action === "MARK_PAID"
            ? await fetch(`/api/cases/${selected.id}/mark-paid`, {
                method: "POST"
              })
            : await fetch(`/api/cases/${selected.id}/actions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action })
              });
        const payload = await readApiPayload(response);
        if (!response.ok) {
          notify("error", payload.error ?? "Akciu sa nepodarilo vykonať.");
          return;
        }
        replaceCase(payload.case);
        notify("success", actionMessage(action) ?? "Akcia bola vykonaná.");
      } catch {
        notify("error", "Akciu sa nepodarilo vykonať. Skontrolujte pripojenie a skúste to znova.");
      }
    });
  }

  function requestCaseCancel() {
    setConfirmDialog({
      title: "Zastaviť prípad?",
      body: "Automatizácia sa ukončí a prípad sa označí ako zastavený. Túto akciu použite iba vtedy, keď už nechcete pokračovať vo vymáhaní.",
      confirmLabel: "Zastaviť prípad",
      onConfirm: () => runCaseAction("CANCEL_CASE")
    });
  }

  function replaceCase(item: DashboardCase, select = false) {
    setCases((current) => {
      if (select || !current.some((candidate) => candidate.id === item.id)) {
        return [item, ...current.filter((candidate) => candidate.id !== item.id)];
      }
      return current.map((candidate) =>
        candidate.id === item.id ? item : candidate
      );
    });
    if (select) {
      setSelectedId(item.id);
      setMobileDetailOpen(true);
    }
  }

  async function openCase(caseId: string) {
    if (caseId !== selectedId && !confirmDiscardedReview()) {
      return;
    }
    setSelectedId(caseId);
    setMobileDetailOpen(true);
    const item = cases.find((candidate) => candidate.id === caseId);
    if (!item || item.detailsLoaded) {
      return;
    }

    setDetailLoadingId(caseId);
    try {
      const response = await fetch(`/api/cases/${caseId}`);
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Detail prípadu sa nepodarilo načítať.");
        return;
      }
      replaceCase(payload.case);
    } catch {
      notify("error", "Detail prípadu sa nepodarilo načítať. Skontrolujte pripojenie.");
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function loadDebtorDetail(debtorId: string) {
    setDebtorLoadingId(debtorId);
    try {
      const response = await fetch(`/api/debtors/${debtorId}`);
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Históriu dlžníka sa nepodarilo načítať.");
        return;
      }
      setDebtorDetails((current) => ({
        ...current,
        [debtorId]: payload.debtor
      }));
    } catch {
      notify("error", "Históriu dlžníka sa nepodarilo načítať. Skontrolujte pripojenie.");
    } finally {
      setDebtorLoadingId((current) => (current === debtorId ? null : current));
    }
  }

  async function refreshDebtors() {
    try {
      const response = await fetch("/api/debtors");
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Zoznam dlžníkov sa nepodarilo obnoviť.");
        return;
      }
      const refreshed: DashboardDebtor[] = payload.debtors;
      setDebtors(refreshed);
      setDebtorDetails({});
      setSelectedDebtorId((current) =>
        current && refreshed.some((item) => item.id === current)
          ? current
          : refreshed[0]?.id ?? null
      );
    } catch {
      notify("error", "Zoznam dlžníkov sa nepodarilo obnoviť.");
    }
  }

  function openDebtor(debtorId: string) {
    if (!confirmDiscardedReview()) {
      return;
    }
    setSelectedDebtorId(debtorId);
    setMobileDetailOpen(true);
  }

  async function openCaseFromDebtor(item: DashboardCase) {
    replaceCase(item);
    setNavView("CASES");
    setFilter("ALL");
    setQuery("");
    setSelectedId(item.id);
    setMobileDetailOpen(true);
    if (item.detailsLoaded) {
      return;
    }
    setDetailLoadingId(item.id);
    try {
      const response = await fetch(`/api/cases/${item.id}`);
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Detail prípadu sa nepodarilo načítať.");
        return;
      }
      replaceCase(payload.case);
    } catch {
      notify("error", "Detail prípadu sa nepodarilo načítať. Skontrolujte pripojenie.");
    } finally {
      setDetailLoadingId(null);
    }
  }

  function updateReviewField(field: keyof ReviewFormState, value: string) {
    setReviewForm((current) => ({
      ...current,
      [field]: field === "currency" ? value.toUpperCase().slice(0, 3) : value
    }));
    setReviewDirty(true);
  }

  function confirmDiscardedReview() {
    return (
      !reviewDirty ||
      window.confirm("Máte neuložené zmeny. Chcete ich zahodiť?")
    );
  }

  function closeMobileDetail() {
    if (confirmDiscardedReview()) {
      setMobileDetailOpen(false);
    }
  }

  function navigateDashboard(view: NavView) {
    if (!confirmDiscardedReview()) {
      return;
    }
    setNavView(view);
    setMobileDetailOpen(false);
    if (view === "DEBTORS") {
      setDebtorFilter("ALL");
      void refreshDebtors();
    }
    setFilter(
      view === "COMMUNICATIONS"
        ? "COMMUNICATIONS"
        : view === "WORKFLOW"
          ? "WORKFLOW"
          : view === "LEGAL"
            ? "LEGAL"
            : view === "ARCHIVE"
              ? "CLOSED"
              : "ALL"
    );
  }

  async function saveDebtorContact() {
    if (!selected) {
      return;
    }
    setContactSaving(true);
    clearToast();
    try {
      const response = await fetch(`/api/cases/${selected.id}/contact`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtorEmail: contactEmail })
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        notify("error", payload.error ?? "Kontakt sa nepodarilo uložiť.");
        return;
      }
      replaceCase(payload.case);
      notify("success", "Email dlžníka bol uložený. Teraz môžete obnoviť workflow.");
    } catch {
      notify("error", "Kontakt sa nepodarilo uložiť. Skontrolujte pripojenie a skúste to znova.");
    } finally {
      setContactSaving(false);
    }
  }

  async function sendAssistantMessage(messageOverride?: string) {
    if (!selected) {
      return;
    }
    const message = (messageOverride ?? assistantDraft).trim();
    if (!message) {
      notify("error", "Napíšte pokyn pre asistenta.");
      return;
    }
    const caseId = selected.id;
    const userMessage: AssistantChatMessage = {
      id: `user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "user",
      intent: null,
      subject: "Vy",
      textBody: message,
      createdAt: new Date().toISOString()
    };
    const pendingMessage: AssistantChatMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      role: "assistant",
      intent: null,
      subject: "Asistent spracúva pokyn",
      textBody: "Čítam prípad, vyhodnocujem pokyn a pripravujem odpoveď.",
      createdAt: new Date().toISOString(),
      pending: true
    };
    appendAssistantMessages(caseId, [userMessage, pendingMessage]);
    setAssistantDraft("");
    setAssistantPending(true);
    clearToast();
    try {
      const response = await fetch(`/api/cases/${caseId}/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      const payload = await readApiPayload(response);
      if (!response.ok) {
        replaceAssistantPending(caseId, pendingMessage.id, {
          role: "system",
          subject: "Pokyn sa nepodarilo spracovať",
          textBody: payload.error ?? "Asistent nedokázal spracovať pokyn.",
          intent: null
        });
        notify("error", payload.error ?? "Asistent nedokázal spracovať pokyn.");
        return;
      }
      replaceCase(payload.case);
      replaceAssistantPending(caseId, pendingMessage.id, {
        role: "assistant",
        intent: payload.assistant?.intent ?? null,
        subject: payload.assistant?.reply?.subject ?? null,
        textBody:
          payload.assistant?.reply?.textBody ??
          "Pokyn bol spracovaný. Detail prípadu bol aktualizovaný."
      });
      notify("success", "Asistent spracoval pokyn.");
    } catch {
      replaceAssistantPending(caseId, pendingMessage.id, {
        role: "system",
        subject: "Chyba spojenia",
        textBody: "Asistent nedokázal spracovať pokyn. Skontrolujte pripojenie.",
        intent: null
      });
      notify("error", "Asistent nedokázal spracovať pokyn. Skontrolujte pripojenie.");
    } finally {
      setAssistantPending(false);
    }
  }

  function appendAssistantMessages(caseId: string, messages: AssistantChatMessage[]) {
    setAssistantThreads((current) => ({
      ...current,
      [caseId]: [...(current[caseId] ?? []), ...messages]
    }));
  }

  function replaceAssistantPending(
    caseId: string,
    messageId: string,
    replacement: Omit<AssistantChatMessage, "id" | "createdAt" | "pending">
  ) {
    setAssistantThreads((current) => ({
      ...current,
      [caseId]: (current[caseId] ?? []).map((item) =>
        item.id === messageId
          ? {
              ...item,
              ...replacement,
              pending: false,
              createdAt: new Date().toISOString()
            }
          : item
      )
    }));
  }

  function notify(kind: ToastKind, text: string) {
    setToast({ id: Date.now(), kind, text });
  }

  function clearToast() {
    setToast(null);
  }

  return (
    <main className="min-h-screen bg-[#edf0ed] text-ink">
      <ToastNotice toast={toast} onDismiss={clearToast} />
      <ConfirmDialog
        dialog={confirmDialog}
        onClose={() => setConfirmDialog(null)}
      />
      <div className="min-h-screen xl:grid xl:grid-cols-[196px_430px_minmax(0,1fr)]">
        <Sidebar
          counts={counts}
          debtorCount={debtors.length}
          organizationName={organizationName}
          activeView={navView}
          onNavigate={navigateDashboard}
        />

        <section
          className={`border-b border-zincLine bg-[#f8f8f5] xl:block xl:min-h-screen xl:border-b-0 xl:border-r ${
            mobileDetailOpen ? "hidden" : "block"
          }`}
        >
          <div className="border-b border-zincLine bg-white px-5 pb-4 pt-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">{navViewTitle(navView)}</h1>
                <p className="mt-1 text-xs text-steel">
                  {navView === "DEBTORS"
                    ? `${debtorCounts.active} ${debtorCounts.active === 1 ? "aktívny" : "aktívnych"} · ${debtorCounts.cases} ${slovakCaseLabel(debtorCounts.cases)} spolu`
                    : `${counts.open} otvorených · ${counts.attention} vyžaduje zásah`}
                </p>
              </div>
              <UploadInvoiceButton
                isUploading={isUploading}
                uploadInvoice={uploadInvoice}
              />
            </div>

            <label className="mt-4 flex h-10 items-center gap-2 border border-zincLine bg-[#fafaf8] px-3 focus-within:border-ink">
              <Search className="h-4 w-4 text-steel" />
              <input
                aria-label="Hľadať faktúru alebo dlžníka"
                className="w-full border-0 bg-transparent p-0 text-sm outline-none ring-0 placeholder:text-steel/65 focus:ring-0"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  navView === "DEBTORS"
                    ? "Hľadať dlžníka, email alebo IČO"
                    : "Hľadať faktúru alebo dlžníka"
                }
              />
            </label>

            {navView === "DEBTORS" ? (
              <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border border-zincLine bg-zincLine">
                {debtorFilterOptions(debtorCounts).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={debtorFilter === option.id}
                    onClick={() => setDebtorFilter(option.id)}
                    className={`min-h-12 px-2 py-2 text-left transition ${
                      debtorFilter === option.id
                        ? "bg-[#14261f] text-white shadow-[inset_0_-3px_0_#42b8a8]"
                        : "bg-white text-ink hover:bg-[#f1f2ed]"
                    }`}
                  >
                    <span className="block text-[11px]">{option.label}</span>
                    <span className="mt-0.5 block text-sm font-semibold">
                      {option.count}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border border-zincLine bg-zincLine sm:grid-cols-6 xl:grid-cols-3 2xl:grid-cols-6">
                {filterOptions(counts).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={filter === option.id}
                  onClick={() => {
                    setNavView("CASES");
                    setFilter(option.id);
                  }}
                  className={`min-h-12 px-2 py-2 text-left transition ${
                    filter === option.id
                      ? "bg-[#14261f] text-white shadow-[inset_0_-3px_0_#42b8a8]"
                      : "bg-white text-ink hover:bg-[#f1f2ed]"
                  }`}
                >
                  <span className="block text-[11px]">{option.label}</span>
                  <span className="mt-0.5 block text-sm font-semibold">
                    {option.count}
                  </span>
                </button>
                ))}
              </div>
            )}
          </div>

          <div className="max-h-[640px] overflow-y-auto xl:max-h-[calc(100vh-230px)]">
            {navView === "DEBTORS" && filteredDebtors.length ? (
              filteredDebtors.map((item) => (
                <DebtorRow
                  key={item.id}
                  item={item}
                  selected={selectedDebtor?.id === item.id}
                  onSelect={() => openDebtor(item.id)}
                />
              ))
            ) : navView !== "DEBTORS" && filteredCases.length ? (
              filteredCases.map((item) => (
                <CaseRow
                  key={item.id}
                  item={item}
                  selected={selected?.id === item.id}
                  onSelect={() => openCase(item.id)}
                />
              ))
            ) : (
              <div className="px-6 py-16 text-center">
                <Inbox className="mx-auto h-7 w-7 text-steel/55" />
                <p className="mt-3 text-sm font-medium">
                  {navView === "DEBTORS" ? "Žiadni dlžníci" : "Žiadne prípady"}
                </p>
                <p className="mt-1 text-xs text-steel">
                  Zmeňte filter alebo vyhľadávanie.
                </p>
              </div>
            )}
          </div>
        </section>

        <section
          className={`min-w-0 bg-white xl:block xl:min-h-screen ${
            mobileDetailOpen ? "block" : "hidden"
          }`}
        >
          {navView === "DEBTORS" ? (
            selectedDebtor ? (
              <DebtorDetailPanel
                item={selectedDebtor}
                detail={debtorDetails[selectedDebtor.id] ?? null}
                loading={debtorLoadingId === selectedDebtor.id}
                onBack={closeMobileDetail}
                onOpenCase={openCaseFromDebtor}
              />
            ) : (
              <div className="flex min-h-[500px] items-center justify-center text-sm text-steel">
                Zatiaľ nie sú evidovaní žiadni dlžníci.
              </div>
            )
          ) : selected ? (
            <>
              <CaseHeader
                item={selected}
                pending={isActionPending}
                onAction={runCaseAction}
                onCancel={requestCaseCancel}
                onBack={closeMobileDetail}
              />
              <DetailTabs
                active={detailTab}
                onChange={setDetailTab}
                item={selected}
              />
              {detailLoadingId === selected.id ? (
                <div className="border-b border-zincLine px-5 py-3 text-sm text-steel">
                  Načítavam úplnú históriu prípadu…
                </div>
              ) : null}
              <div className="xl:max-h-[calc(100vh-137px)] xl:overflow-y-auto">
                {detailTab === "OVERVIEW" ? (
                  <OverviewPanel
                    item={selected}
                    form={reviewForm}
                    validationErrors={validationErrors}
                    isSaving={isSaving}
                    isConfirming={isConfirming}
                    onFieldChange={updateReviewField}
                    onSave={() => saveDraft()}
                    onConfirm={confirmCase}
                    contactEmail={contactEmail}
                    isContactSaving={isContactSaving}
                    onContactEmailChange={setContactEmail}
                    onSaveContact={saveDebtorContact}
                  />
                ) : detailTab === "TIMELINE" ? (
                  <TimelinePanel events={selected.events} />
                ) : detailTab === "COMMUNICATIONS" ? (
                  <CommunicationsPanel
                    communications={selected.communications}
                  />
                ) : (
                  <AssistantPanel
                    item={selected}
                    draft={assistantDraft}
                    messages={assistantMessages}
                    pending={assistantPending}
                    onDraftChange={setAssistantDraft}
                    onSubmit={() => sendAssistantMessage()}
                    onQuickCommand={(message) => sendAssistantMessage(message)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex min-h-[500px] items-center justify-center text-sm text-steel">
              Nahrajte faktúru alebo vyberte prípad.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Sidebar({
  counts,
  debtorCount,
  organizationName,
  activeView,
  onNavigate
}: {
  counts: ReturnType<typeof summarizeCases>;
  debtorCount: number;
  organizationName: string;
  activeView: NavView;
  onNavigate: (view: NavView) => void;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileMenuOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const backgroundElements = Array.from(
      document.querySelectorAll<HTMLElement>(
        "main > div > :not([data-mobile-menu-layer])"
      )
    );
    backgroundElements.forEach((element) => element.setAttribute("inert", ""));

    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);

    return () => {
      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach((element) => element.removeAttribute("inert"));
      window.removeEventListener("keydown", handleDialogKeys);
      openerRef.current?.focus();
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header className="flex h-16 items-center justify-between border-b border-white/10 bg-[#073f3f] px-5 text-white xl:hidden">
        <div className="text-lg font-bold tracking-[0.12em]">FAKTURIO</div>
        <button
          ref={openerRef}
          type="button"
          title="Otvoriť menu"
          aria-label="Otvoriť hlavné menu"
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-navigation"
          onClick={() => setMobileMenuOpen(true)}
          className="flex h-10 w-10 items-center justify-center border border-white/20 hover:bg-white/10"
        >
          <Menu className="h-5 w-5" />
        </button>
      </header>

      {mobileMenuOpen ? (
        <div
          data-mobile-menu-layer
          className="fixed inset-0 z-50 xl:hidden"
        >
          <button
            type="button"
            aria-label="Zavrieť hlavné menu"
            onClick={() => setMobileMenuOpen(false)}
            className="absolute inset-0 z-0 bg-black/45 [animation:overlay-in_160ms_ease-out]"
          />
          <aside
            ref={drawerRef}
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Hlavné menu"
            className="relative z-10 flex h-full w-[min(320px,calc(100vw-48px))] flex-col bg-[#073f3f] text-white shadow-2xl [animation:drawer-in_180ms_ease-out]"
          >
            <div className="flex h-16 items-center justify-between border-b border-white/12 px-5">
              <div className="text-xl font-bold tracking-[0.12em]">
                FAKTURIO
              </div>
              <button
                type="button"
                autoFocus
                title="Zavrieť menu"
                aria-label="Zavrieť hlavné menu"
                onClick={() => setMobileMenuOpen(false)}
                className="flex h-9 w-9 items-center justify-center hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <Navigation
              counts={counts}
              debtorCount={debtorCount}
              activeView={activeView}
              onSelect={(view) => {
                onNavigate(view);
                setMobileMenuOpen(false);
              }}
            />
            <AccountSummary organizationName={organizationName} counts={counts} />
          </aside>
        </div>
      ) : null}

      <aside className="hidden bg-[#073f3f] text-white xl:flex xl:min-h-screen xl:flex-col">
        <div className="flex min-h-20 items-center border-b border-white/10 px-5">
          <div className="text-xl font-bold tracking-[0.12em]">FAKTURIO</div>
        </div>
        <Navigation
          counts={counts}
          debtorCount={debtorCount}
          activeView={activeView}
          onSelect={onNavigate}
        />
        <AccountSummary organizationName={organizationName} counts={counts} />
      </aside>
    </>
  );
}

function Navigation({
  counts,
  debtorCount,
  activeView,
  onSelect
}: {
  counts: ReturnType<typeof summarizeCases>;
  debtorCount: number;
  activeView: NavView;
  onSelect: (view: NavView) => void;
}) {
  return (
    <nav
      aria-label="Hlavná navigácia"
      className="flex-1 space-y-1 px-3 py-4"
    >
      <NavItem
        icon={FileText}
        label="Prípady"
        active={activeView === "CASES"}
        count={counts.open}
        onClick={() => onSelect("CASES")}
      />
      <NavItem
        icon={Users}
        label="Dlžníci"
        active={activeView === "DEBTORS"}
        count={debtorCount}
        onClick={() => onSelect("DEBTORS")}
      />
      <NavItem
        icon={Mail}
        label="Komunikácia"
        active={activeView === "COMMUNICATIONS"}
        count={counts.communications}
        onClick={() => onSelect("COMMUNICATIONS")}
      />
      <NavItem
        icon={Clock3}
        label="Workflow"
        active={activeView === "WORKFLOW"}
        count={counts.paused}
        onClick={() => onSelect("WORKFLOW")}
      />
      <NavItem
        icon={Gavel}
        label="Právne kroky"
        active={activeView === "LEGAL"}
        count={counts.legal}
        onClick={() => onSelect("LEGAL")}
      />
      <NavItem
        icon={Archive}
        label="Archív"
        active={activeView === "ARCHIVE"}
        count={counts.closed}
        onClick={() => onSelect("ARCHIVE")}
      />
    </nav>
  );
}

function AccountSummary({
  organizationName,
  counts
}: {
  organizationName: string;
  counts: ReturnType<typeof summarizeCases>;
}) {
  const status =
    counts.attention > 0
      ? `${counts.attention} vyžaduje zásah`
      : `${counts.open} ${slovakOpenCaseLabel(counts.open)} prípadov`;
  return (
    <div className="border-t border-white/15 p-4">
      <div className="text-xs text-white/55">Aktívny účet</div>
      <div className="mt-1 truncate text-sm font-medium">{organizationName}</div>
      <div className="mt-4 flex items-center gap-2 text-xs text-white/65">
        <CheckCircle2
          className={`h-4 w-4 ${counts.attention > 0 ? "text-[#e2bd78]" : "text-ledger"}`}
        />
        {status}
      </div>
    </div>
  );
}

function ToastNotice({
  toast,
  onDismiss
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
}) {
  if (!toast) {
    return null;
  }
  const tone =
    toast.kind === "success"
      ? "border-[#75a45c] bg-[#f1f8ee] text-[#244d18]"
      : toast.kind === "error"
        ? "border-[#d29a62] bg-[#fff7ed] text-[#7a321d]"
        : "border-zincLine bg-white text-ink";
  const Icon = toast.kind === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div
      key={toast.id}
      role={toast.kind === "error" ? "alert" : "status"}
      aria-live={toast.kind === "error" ? "assertive" : "polite"}
      className={`fixed right-4 top-4 z-50 flex max-w-[calc(100vw-2rem)] items-start gap-3 border px-4 py-3 text-sm shadow-sm sm:max-w-md ${tone}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{toast.text}</div>
      <button
        type="button"
        aria-label="Zavrieť oznámenie"
        onClick={onDismiss}
        className="ml-2 text-current opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  onClose
}: {
  dialog: ConfirmDialogState | null;
  onClose: () => void;
}) {
  if (!dialog) {
    return null;
  }
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <div className="w-full max-w-md border border-zincLine bg-white p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div>
            <h2 id="confirm-dialog-title" className="text-lg font-semibold">
              {dialog.title}
            </h2>
            <p className="mt-2 text-sm text-steel">{dialog.body}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 border border-zincLine px-4 text-sm hover:border-ink"
          >
            Späť
          </button>
          <button
            type="button"
            onClick={() => {
              const onConfirm = dialog.onConfirm;
              onClose();
              onConfirm();
            }}
            className="h-10 bg-[#9c3e25] px-4 text-sm text-white hover:bg-[#84331f]"
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active = false,
  count,
  onClick
}: {
  icon: typeof FileText;
  label: string;
  active?: boolean;
  count: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={count ? `${label}: ${count}` : label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`relative flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-sm transition ${
        active
          ? "bg-white/12 text-white before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-[#42b8a8]"
          : "text-white/72 hover:bg-white/8"
      }`}
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
      {count ? (
        <span className="ml-auto min-w-5 text-right text-xs text-white/55">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function UploadInvoiceButton({
  isUploading,
  uploadInvoice
}: {
  isUploading: boolean;
  uploadInvoice: (formData: FormData) => Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <form action={uploadInvoice}>
      <button
        type="button"
        title="Nahrať faktúru"
        aria-label="Nahrať faktúru"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="flex h-10 cursor-pointer items-center gap-2 bg-ink px-3 text-sm text-white transition hover:bg-[#274039]"
      >
        {isUploading ? (
          <RefreshCw className="h-4 w-4 animate-spin" />
        ) : (
          <UploadCloud className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">Nahrať</span>
      </button>
      <input
        ref={fileInputRef}
        className="hidden"
        name="file"
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        disabled={isUploading}
      />
    </form>
  );
}

function DebtorRow({
  item,
  selected,
  onSelect
}: {
  item: DashboardDebtor;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative w-full border-b border-zincLine px-5 py-4 text-left transition ${
        selected ? "bg-white" : "bg-[#f8f8f5] hover:bg-white"
      }`}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-1 bg-[#08736e]" />
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase text-steel">
            <StatusDot tone={item.openCaseCount ? "active" : "done"} />
            {item.openCaseCount ? "Aktívny dlžník" : "Bez otvorených prípadov"}
          </div>
          <div className="mt-2 truncate text-[15px] font-semibold">
            {item.name}
          </div>
          <div className="mt-0.5 truncate text-xs text-steel">
            {item.email ?? item.ico ? item.email ?? `IČO ${item.ico}` : "Kontakt nie je doplnený"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold">
            {formatDebtorAmounts(item.openAmounts)}
          </div>
          <div className="mt-1 text-xs text-steel">
            {item.openCaseCount} {slovakOpenCaseLabel(item.openCaseCount)}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-steel">
        <span>{item.caseCount} {slovakCaseLabel(item.caseCount)}</span>
        <span>
          {item.lastCaseAt ? `Naposledy ${formatDate(item.lastCaseAt)}` : "Bez faktúr"}
        </span>
      </div>
    </button>
  );
}

function DebtorDetailPanel({
  item,
  detail,
  loading,
  onBack,
  onOpenCase
}: {
  item: DashboardDebtor;
  detail: DashboardDebtorDetail | null;
  loading: boolean;
  onBack: () => void;
  onOpenCase: (item: DashboardCase) => void;
}) {
  return (
    <>
      <header className="flex min-h-[88px] items-center gap-3 border-b border-zincLine px-6 py-4">
        <button
          type="button"
          title="Späť na zoznam"
          aria-label="Späť na zoznam dlžníkov"
          onClick={onBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center border border-zincLine hover:border-ink xl:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-steel">
            <Users className="h-3.5 w-3.5" />
            <span>{item.caseCount} {slovakCaseLabel(item.caseCount)}</span>
            <span>·</span>
            <span>
              {item.openCaseCount} {slovakOpenCaseLabel(item.openCaseCount)}
            </span>
          </div>
          <h2 className="mt-1 truncate text-2xl font-semibold">{item.name}</h2>
        </div>
      </header>

      <div className="xl:max-h-[calc(100vh-88px)] xl:overflow-y-auto">
        <div className="space-y-6 p-6">
          <div className="grid grid-cols-3 gap-px border border-zincLine bg-zincLine">
            <DebtorMetric label="Otvorený dlh" value={formatDebtorAmounts(item.openAmounts)} />
            <DebtorMetric label="Otvorené" value={String(item.openCaseCount)} />
            <DebtorMetric label="Uzavreté" value={String(item.closedCaseCount)} />
          </div>

          <section>
            <SectionTitle title="Údaje dlžníka" icon={Users} />
            <div className="mt-3 grid border border-zincLine sm:grid-cols-2">
              <DebtorField label="Email" value={item.email} />
              <DebtorField label="IČO" value={item.ico} />
              <DebtorField label="DIČ" value={item.dic} />
              <DebtorField label="IČ DPH" value={item.icDph} />
              <div className="border-t border-zincLine p-3 sm:col-span-2">
                <div className="text-xs text-steel">Adresa</div>
                <div className="mt-1 text-sm font-medium">
                  {item.address ?? "Nezadaná"}
                </div>
              </div>
            </div>
          </section>

          <section>
            <SectionTitle title="Faktúry a prípady" icon={FileText} />
            <div className="mt-3 border border-zincLine">
              {loading ? (
                <div className="flex items-center gap-2 p-4 text-sm text-steel">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Načítavam históriu dlžníka…
                </div>
              ) : detail?.cases.length ? (
                detail.cases.map((caseItem) => (
                  <button
                    key={caseItem.id}
                    type="button"
                    onClick={() => onOpenCase(caseItem)}
                    className="flex w-full items-center justify-between gap-4 border-b border-zincLine p-4 text-left last:border-b-0 hover:bg-[#f8f8f5]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusDot
                          tone={(statusMeta[caseItem.status]?.tone ?? "neutral")}
                        />
                        <span className="truncate text-xs font-semibold uppercase text-steel">
                          {statusMeta[caseItem.status]?.label ?? caseItem.status}
                        </span>
                      </div>
                      <div className="mt-1.5 truncate text-sm font-semibold">
                        {caseItem.invoiceNumber ?? "Bez čísla faktúry"}
                      </div>
                      <div className="mt-0.5 text-xs text-steel">
                        {caseItem.dueDate
                          ? `Splatnosť ${formatDate(caseItem.dueDate)}`
                          : "Bez dátumu splatnosti"}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-semibold">
                      {formatMoney(caseItem.amountTotal, caseItem.currency)}
                    </div>
                  </button>
                ))
              ) : (
                <EmptyCompact text="K dlžníkovi nie sú priradené žiadne faktúry." />
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function DebtorMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-white p-3">
      <div className="text-xs text-steel">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold" title={value}>
        {value}
      </div>
    </div>
  );
}

function DebtorField({
  label,
  value
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="border-t border-zincLine p-3 first:border-t-0 sm:[&:nth-child(-n+2)]:border-t-0 sm:[&:nth-child(even)]:border-l">
      <div className="text-xs text-steel">{label}</div>
      <div className="mt-1 truncate text-sm font-medium" title={value ?? undefined}>
        {value ?? "Nezadané"}
      </div>
    </div>
  );
}

function CaseRow({
  item,
  selected,
  onSelect
}: {
  item: DashboardCase;
  selected: boolean;
  onSelect: () => void;
}) {
  const status = statusMeta[item.status] ?? {
    label: item.status,
    tone: "neutral" as const
  };
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative w-full border-b border-zincLine px-5 py-4 text-left transition ${
        selected ? "bg-white" : "bg-[#f8f8f5] hover:bg-white"
      }`}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-1 bg-[#08736e]" />
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot tone={status.tone} />
            <span className="truncate text-xs font-semibold uppercase text-steel">
              {status.label}
            </span>
            {item.automationPausedAt ? (
              <CirclePause className="h-3.5 w-3.5 text-warn" />
            ) : null}
          </div>
          <div className="mt-2 truncate text-[15px] font-semibold">
            {item.debtorName ?? "Neznámy dlžník"}
          </div>
          <div className="mt-0.5 truncate text-xs text-steel">
            {item.invoiceNumber ?? "Bez čísla faktúry"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold">
            {formatMoney(item.amountTotal, item.currency)}
          </div>
          <div className="mt-1 text-xs text-steel">
            {item.dueDate ? formatDate(item.dueDate) : "bez splatnosti"}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-steel">
        <span className="flex items-center gap-1.5">
          {item.sourceType === "EMAIL" ? (
            <Mail className="h-3.5 w-3.5" />
          ) : (
            <UploadCloud className="h-3.5 w-3.5" />
          )}
          {item.sourceType === "EMAIL" ? "Email" : "Upload"}
        </span>
        <span>{nextActionLabel(item)}</span>
      </div>
    </button>
  );
}

function CaseHeader({
  item,
  pending,
  onAction,
  onCancel,
  onBack
}: {
  item: DashboardCase;
  pending: boolean;
  onAction: (
    action:
      | "MARK_PAID"
      | "PAUSE_AUTOMATION"
      | "RESUME_AUTOMATION"
      | "CANCEL_CASE"
  ) => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const terminal = TERMINAL_STATUSES.has(item.status);
  const operational = Boolean(item.confirmedAt) && !terminal;
  const paused = Boolean(item.automationPausedAt);
  return (
    <header className="flex min-h-[88px] flex-wrap items-center justify-between gap-4 border-b border-zincLine px-6 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          title="Späť na zoznam"
          aria-label="Späť na zoznam prípadov"
          onClick={onBack}
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center border border-zincLine hover:border-ink xl:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-steel">
            <span>{item.invoiceNumber ?? "Bez čísla faktúry"}</span>
            <span>·</span>
            <span>{item.sourceType === "EMAIL" ? "Email" : "Upload"}</span>
          </div>
          <h2 className="mt-1 truncate text-2xl font-semibold">
            {item.debtorName ?? "Neznámy dlžník"}
          </h2>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {operational ? (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                onAction(paused ? "RESUME_AUTOMATION" : "PAUSE_AUTOMATION")
              }
              className="inline-flex h-9 items-center gap-2 border border-zincLine px-3 text-sm hover:border-ink disabled:opacity-50"
            >
              {paused ? (
                <CirclePlay className="h-4 w-4" />
              ) : (
                <CirclePause className="h-4 w-4" />
              )}
              {paused ? "Obnoviť" : "Pozastaviť"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => onAction("MARK_PAID")}
              className="inline-flex h-9 items-center gap-2 bg-[#08736e] px-3 text-sm text-white hover:bg-[#075e5a] disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              Uhradené
            </button>
            <button
              type="button"
              title="Zastaviť prípad"
              aria-label="Zastaviť prípad"
              disabled={pending}
              onClick={onCancel}
              className="flex h-9 w-9 items-center justify-center border border-zincLine hover:border-warn hover:text-warn disabled:opacity-50"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </>
        ) : terminal ? (
          <StatusBadge status={item.status} />
        ) : (
          <button
            type="button"
            title="Zastaviť prípad"
            aria-label="Zastaviť prípad"
            disabled={pending}
            onClick={onCancel}
            className="flex h-9 w-9 items-center justify-center border border-zincLine hover:border-warn hover:text-warn disabled:opacity-50"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
    </header>
  );
}

function DetailTabs({
  active,
  onChange,
  item
}: {
  active: DetailTab;
  onChange: (tab: DetailTab) => void;
  item: DashboardCase;
}) {
  const tabs: Array<{ id: DetailTab; label: string; count?: number }> = [
    { id: "OVERVIEW", label: "Prehľad" },
    { id: "TIMELINE", label: "Timeline", count: item.eventCount },
    {
      id: "COMMUNICATIONS",
      label: "Komunikácia",
      count: item.communicationCount
    },
    { id: "ASSISTANT", label: "Asistent" }
  ];
  return (
    <div className="flex h-12 items-end gap-6 border-b border-zincLine px-6">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`h-12 border-b-2 text-sm ${
            active === tab.id
              ? "border-ink font-semibold text-ink"
              : "border-transparent text-steel hover:text-ink"
          }`}
        >
          {tab.label}
          {tab.count ? (
            <span className="ml-1.5 text-xs text-steel">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function OverviewPanel({
  item,
  form,
  validationErrors,
  isSaving,
  isConfirming,
  onFieldChange,
  onSave,
  onConfirm,
  contactEmail,
  isContactSaving,
  onContactEmailChange,
  onSaveContact
}: {
  item: DashboardCase;
  form: ReviewFormState;
  validationErrors: string[];
  isSaving: boolean;
  isConfirming: boolean;
  onFieldChange: (field: keyof ReviewFormState, value: string) => void;
  onSave: () => void;
  onConfirm: () => void;
  contactEmail: string;
  isContactSaving: boolean;
  onContactEmailChange: (value: string) => void;
  onSaveContact: () => void;
}) {
  const reviewable = REVIEW_STATUSES.has(item.status);
  const contactEditable =
    Boolean(item.confirmedAt) &&
    item.automationPauseReason === "MISSING_DEBTOR_EMAIL" &&
    !TERMINAL_STATUSES.has(item.status);
  const activePlan = item.installmentPlans[0];
  const latestPromise = item.paymentPromises[0];
  const fieldErrors = reviewable
    ? getReviewFieldErrors(validationErrors, form)
    : {};
  const generalValidationErrors = validationErrors.filter(
    (error) => !validationErrorField(error)
  );

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      {item.automationPausedAt ? (
        <div className="mb-5 flex gap-3 border border-[#d29a62] bg-[#fff8ed] p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          <div>
            <div className="text-sm font-semibold">Automatizácia je pozastavená</div>
            <div className="mt-1 text-sm text-steel">
              {pauseReasonLabel(item.automationPauseReason)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid border border-zincLine md:grid-cols-4">
        <Metric label="Stav" value={<StatusBadge status={item.status} />} />
        <Metric
          label="Suma"
          value={formatMoney(item.amountTotal, item.currency)}
        />
        <Metric
          label="Splatnosť"
          value={item.dueDate ? formatDate(item.dueDate) : "Nezadaná"}
        />
        <Metric
          label="Ďalší krok"
          value={nextActionLabel(item, true)}
        />
      </div>

      <div className="mt-6 grid gap-6 2xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
        <div className="space-y-6">
          <section>
            <SectionTitle title="Údaje prípadu" icon={FileText} />
            <div className="mt-3 border border-zincLine">
              {reviewable ? (
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <ReviewField
                    label="Faktúra č."
                    value={form.invoiceNumber}
                    error={fieldErrors.invoiceNumber}
                    onChange={(value) => onFieldChange("invoiceNumber", value)}
                  />
                  <ReviewField
                    label="Dátum splatnosti"
                    type="date"
                    value={form.dueDate}
                    error={fieldErrors.dueDate}
                    onChange={(value) => onFieldChange("dueDate", value)}
                  />
                  <ReviewField
                    label="Dodávateľ"
                    value={form.supplierName}
                    onChange={(value) => onFieldChange("supplierName", value)}
                  />
                  <ReviewField
                    label="Odberateľ"
                    value={form.debtorName}
                    error={fieldErrors.debtorName}
                    onChange={(value) => onFieldChange("debtorName", value)}
                  />
                  <ReviewField
                    label="Email odberateľa"
                    value={form.debtorEmail}
                    onChange={(value) => onFieldChange("debtorEmail", value)}
                  />
                  <div className="grid grid-cols-[1fr_92px] gap-2">
                    <ReviewField
                      label="Suma na úhradu"
                      type="number"
                      value={form.amountTotal}
                      error={fieldErrors.amountTotal}
                      onChange={(value) => onFieldChange("amountTotal", value)}
                    />
                    <ReviewField
                      label="Mena"
                      value={form.currency}
                      maxLength={3}
                      pattern="[A-Z]{3}"
                      help="ISO kód meny, napr. EUR."
                      error={fieldErrors.currency}
                      onChange={(value) => onFieldChange("currency", value)}
                    />
                  </div>
                  <ReviewField
                    label="IBAN"
                    value={form.iban}
                    onChange={(value) => onFieldChange("iban", value)}
                  />
                  <ReviewField
                    label="Variabilný symbol"
                    value={form.variableSymbol}
                    onChange={(value) =>
                      onFieldChange("variableSymbol", value)
                    }
                  />
                </div>
              ) : (
                <>
                  <dl className="grid md:grid-cols-2">
                    <DataRow label="Dodávateľ" value={item.supplierName} />
                    <DataRow label="Odberateľ" value={item.debtorName} />
                    <DataRow label="Email" value={item.debtorEmail} />
                    <DataRow label="IBAN" value={item.iban} />
                    <DataRow
                      label="Variabilný symbol"
                      value={item.variableSymbol}
                    />
                    <DataRow label="Dokument" value={item.documentName} />
                  </dl>
                  {contactEditable ? (
                    <div className="border-t border-zincLine bg-[#fffaf1] p-4">
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                        <ReviewField
                          label="Email dlžníka"
                          type="email"
                          value={contactEmail}
                          onChange={onContactEmailChange}
                        />
                        <button
                          type="button"
                          disabled={isContactSaving || !contactEmail.trim()}
                          onClick={onSaveContact}
                          className="h-10 bg-ink px-4 text-sm text-white hover:bg-[#274039] disabled:opacity-50"
                        >
                          {isContactSaving ? "Ukladám…" : "Uložiť kontakt"}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>

            {item.warnings.length || generalValidationErrors.length ? (
              <div className="mt-3 border border-[#e2bd78] bg-[#fff9ed] p-3 text-sm text-[#845112]">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  Vyžaduje pozornosť
                </div>
                {[...item.warnings, ...generalValidationErrors].map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}

            {reviewable ? (
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={isSaving || isConfirming}
                  onClick={onSave}
                  className="h-10 border border-zincLine px-4 text-sm hover:border-ink disabled:opacity-50"
                >
                  {isSaving ? "Ukladám..." : "Uložiť zmeny"}
                </button>
                <button
                  type="button"
                  disabled={isSaving || isConfirming}
                  onClick={onConfirm}
                  className="h-10 bg-ink px-4 text-sm text-white hover:bg-[#274039] disabled:opacity-50"
                >
                  {isConfirming ? "Potvrdzujem..." : "Potvrdiť a spustiť"}
                </button>
              </div>
            ) : null}
          </section>

          {activePlan ? (
            <InstallmentPlanSection plan={activePlan} />
          ) : latestPromise ? (
            <PromiseSection promise={latestPromise} />
          ) : null}
        </div>

        <aside className="space-y-6">
          <section>
            <SectionTitle title="Workflow" icon={Clock3} />
            <div className="mt-3 border border-zincLine">
              <DataRow
                label="Workflow ID"
                value={item.workflowId ?? "Ešte nespustený"}
              />
              <DataRow
                label="Posledná zmena"
                value={formatDateTime(item.updatedAt)}
              />
              <DataRow
                label="Zdroj"
                value={item.sourceType === "EMAIL" ? "Email" : "Upload"}
              />
            </div>
          </section>

          <section>
            <SectionTitle title="Kontroly platieb" icon={CheckCircle2} />
            <div className="mt-3 border border-zincLine">
              {item.paymentChecks.length ? (
                item.paymentChecks.slice(0, 4).map((check) => (
                  <div
                    key={check.id}
                    className="border-b border-zincLine p-3 last:border-b-0"
                  >
                    <div className="flex justify-between gap-3 text-sm">
                      <span>{paymentCheckReason(check.reason)}</span>
                      <span className="font-medium">
                        {paymentCheckStatus(check.status)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-steel">
                      {formatMoney(check.expectedAmount, check.currency)}
                    </div>
                  </div>
                ))
              ) : (
                <EmptyCompact text="Zatiaľ bez kontroly platby." />
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TimelinePanel({ events }: { events: DashboardEvent[] }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <SectionTitle title="História prípadu" icon={Clock3} />
      <div className="mt-5">
        {events.length ? (
          events.map((event, index) => (
            <div key={event.id} className="grid grid-cols-[120px_24px_1fr] gap-3">
              <div className="pt-0.5 text-right text-xs text-steel">
                {formatDateTime(event.createdAt)}
              </div>
              <div className="relative flex justify-center">
                <span className="z-10 mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#08736e] ring-1 ring-[#08736e]" />
                {index < events.length - 1 ? (
                  <span className="absolute bottom-0 top-3 w-px bg-zincLine" />
                ) : null}
              </div>
              <div className="pb-6">
                <div className="text-sm font-semibold">
                  {eventTypeLabel(event.type)}
                </div>
                <div className="mt-1 text-sm leading-5 text-steel">
                  {event.note ?? event.actorType}
                </div>
              </div>
            </div>
          ))
        ) : (
          <EmptyPanel
            icon={Clock3}
            title="Bez udalostí"
            text="Timeline sa začne plniť po spracovaní prípadu."
          />
        )}
      </div>
    </div>
  );
}

function CommunicationsPanel({
  communications
}: {
  communications: DashboardCommunication[];
}) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <SectionTitle title="Komunikácia" icon={Mail} />
      <div className="mt-5 space-y-3">
        {communications.length ? (
          communications.map((communication) => (
            <article
              key={communication.id}
              className="border border-zincLine bg-white"
            >
              <div className="flex items-start gap-3 border-b border-zincLine bg-[#fafaf8] p-4">
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center ${
                    communication.direction === "INBOUND"
                      ? "bg-[#e7f3f0] text-[#08736e]"
                      : "bg-[#eef0e4] text-ink"
                  }`}
                >
                  {communication.direction === "INBOUND" ? (
                    <ArrowDownLeft className="h-4 w-4" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-3">
                    <div className="truncate text-sm font-semibold">
                      {communication.subject ?? "Bez predmetu"}
                    </div>
                    <div className="shrink-0 text-xs text-steel">
                      {formatDateTime(
                        communication.receivedAt ??
                          communication.sentAt ??
                          communication.createdAt
                      )}
                    </div>
                  </div>
                  <div className="mt-1 truncate text-xs text-steel">
                    {communication.direction === "INBOUND"
                      ? communication.fromAddress
                      : communication.toAddress}
                  </div>
                </div>
              </div>
              <div className="p-4">
                <p className="whitespace-pre-wrap text-sm leading-6 text-[#33413b]">
                  {communication.textBody ?? "Obsah správy nie je dostupný."}
                </p>
                {communication.attachmentCount ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-steel">
                    <Paperclip className="h-3.5 w-3.5" />
                    {communication.attachmentCount} príloh
                  </div>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <EmptyPanel
            icon={Mail}
            title="Bez komunikácie"
            text="Odoslané pripomienky a odpovede dlžníka sa zobrazia tu."
          />
        )}
      </div>
    </div>
  );
}

function AssistantPanel({
  item,
  draft,
  messages,
  pending,
  onDraftChange,
  onSubmit,
  onQuickCommand
}: {
  item: DashboardCase;
  draft: string;
  messages: AssistantChatMessage[];
  pending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onQuickCommand: (message: string) => void;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const quickActions = [
    {
      label: "História prípadu",
      icon: Clock3,
      message: "Aké kroky boli v tomto prípade urobené?"
    },
    {
      label: "Štandardné splátky",
      icon: CalendarClock,
      message: "Pošli dlžníkovi štandardný splátkový kalendár."
    },
    {
      label: "Správa dlžníkovi",
      icon: Mail,
      message:
        "Napíš dlžníkovi, že žiadame úhradu podľa pôvodných podmienok faktúry."
    },
    {
      label: "Spustiť prípad",
      icon: Check,
      message: "Spusti prípad podľa aktuálnych údajov."
    }
  ];
  const canUseDebtorActions = Boolean(item.debtorEmail);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth"
    });
  }, [messages]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <SectionTitle title="Asistent prípadu" icon={Mail} />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {quickActions.map((action) => {
          const Icon = action.icon;
          const disabled =
            pending ||
            (!canUseDebtorActions &&
              ["Štandardné splátky", "Správa dlžníkovi"].includes(action.label));
          return (
            <button
              key={action.label}
              type="button"
              disabled={disabled}
              onClick={() => onQuickCommand(action.message)}
              className="flex min-h-14 items-center gap-3 border border-zincLine bg-white px-4 py-3 text-left text-sm transition hover:border-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon className="h-4 w-4 shrink-0 text-[#08736e]" />
              <span className="font-medium">{action.label}</span>
            </button>
          );
        })}
      </div>

      {!canUseDebtorActions ? (
        <div className="mt-3 border border-[#e2bd78] bg-[#fff9ed] p-3 text-sm text-[#845112]">
          Pri dlžníkovi chýba email. Správy dlžníkovi a splátkové návrhy budú
          dostupné po doplnení kontaktu.
        </div>
      ) : null}

      <section className="mt-5 border border-zincLine bg-white">
        <div className="border-b border-zincLine bg-[#fafaf8] px-4 py-3">
          <div className="text-sm font-semibold">Dialóg s asistentom</div>
          <div className="mt-1 text-xs text-steel">
            Píšte pokyny prirodzene. Asistent odpovie, čo vykonal, čo nevykonal
            a čo potrebuje potvrdiť.
          </div>
        </div>
        <div
          ref={transcriptRef}
          className="max-h-[460px] min-h-[280px] space-y-4 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          {messages.length > 0 ? (
            messages.map((message) => (
              <AssistantChatBubble key={message.id} message={message} />
            ))
          ) : (
            <div className="flex min-h-[220px] items-center justify-center border border-dashed border-zincLine bg-[#fafaf8] p-6 text-center">
              <div>
                <Mail className="mx-auto h-6 w-6 text-steel" />
                <div className="mt-3 text-sm font-semibold">
                  Pripravený na dialóg
                </div>
                <p className="mt-2 max-w-md text-sm leading-6 text-steel">
                  Použite rýchlu akciu alebo napíšte vlastný pokyn. Odpoveď
                  asistenta sa zobrazí v tejto konverzácii.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="border-x border-b border-zincLine bg-white">
        <label className="block p-4">
          <span className="text-sm font-semibold">Pokyn pre asistenta</span>
          <textarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            rows={4}
            maxLength={4000}
            placeholder="Napríklad: Navrhni dlžníkovi prvú platbu 500 EUR a zvyšok v 3 rovnakých splátkach. Alebo: Čo sa v tomto prípade stalo?"
            className="mt-3 w-full resize-y border border-zincLine px-3 py-2 text-sm leading-6 outline-none focus:border-ink"
          />
        </label>
        <div className="flex items-center justify-between gap-3 border-t border-zincLine px-4 py-3">
          <div className="text-xs text-steel">
            Asistent pracuje s týmto prípadom a zapisuje komunikáciu do histórie.
          </div>
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={onSubmit}
            className="h-10 shrink-0 bg-ink px-4 text-sm text-white hover:bg-[#274039] disabled:opacity-50"
          >
            {pending ? "Spracúvam…" : "Odoslať"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantChatBubble({ message }: { message: AssistantChatMessage }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const intentLabel = assistantIntentLabel(message.intent);
  return (
    <article
      className={[
        "flex",
        isUser ? "justify-end" : "justify-start"
      ].join(" ")}
    >
      <div
        className={[
          "max-w-[82%] border px-4 py-3 text-sm shadow-sm",
          isUser
            ? "border-[#0c4f4a] bg-[#0b3f3b] text-white"
            : isSystem
              ? "border-[#e2bd78] bg-[#fff9ed] text-[#6f4b15]"
              : "border-zincLine bg-[#fafaf8] text-[#25332e]"
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            {isUser ? "Vy" : isSystem ? "Systém" : message.subject ?? "Asistent"}
          </span>
          {intentLabel && !isUser ? (
            <span className="border border-zincLine bg-white/70 px-2 py-0.5 text-[11px] text-steel">
              {intentLabel}
            </span>
          ) : null}
          {message.pending ? (
            <span className="text-xs text-steel">spracúva sa</span>
          ) : null}
        </div>
        <p className="mt-2 whitespace-pre-wrap leading-6">{message.textBody}</p>
        <time
          dateTime={message.createdAt}
          className={["mt-2 block text-[11px]", isUser ? "text-white/70" : "text-steel"].join(" ")}
        >
          {formatDateTime(message.createdAt)}
        </time>
      </div>
    </article>
  );
}

function assistantIntentLabel(intent: string | null): string | null {
  if (!intent || intent === "OTHER") {
    return null;
  }
  const labels: Record<string, string> = {
    PROVIDE_INVOICE_FIELDS: "doplnené údaje",
    ADD_CASE_NOTE: "poznámka",
    ASK_CASE_STATUS: "stav prípadu",
    ASK_MISSING_FIELDS: "chýbajúce údaje",
    UPDATE_DEBTOR_CONTACT: "kontakt dlžníka",
    REQUEST_PAUSE: "pauza",
    REQUEST_RESUME: "obnovenie",
    REQUEST_MARK_PAID: "úhrada",
    REQUEST_CANCEL: "zastavenie",
    REQUEST_CONFIRM_INVOICE: "spustenie",
    REQUEST_STANDARD_INSTALLMENT_PLAN: "štandardné splátky",
    REQUEST_CUSTOM_INSTALLMENT_PLAN: "splátky",
    REQUEST_SEND_DEBTOR_MESSAGE: "správa dlžníkovi",
    REQUEST_FINAL_NOTICE: "posledná výzva",
    ASK_CASE_HISTORY: "história prípadu",
    UNSAFE_OR_LEGAL: "vyžaduje kontrolu"
  };
  return labels[intent] ?? "pokyn";
}

function InstallmentPlanSection({
  plan
}: {
  plan: DashboardCase["installmentPlans"][number];
}) {
  return (
    <section>
      <SectionTitle title="Splátkový kalendár" icon={CalendarClock} />
      <div className="mt-3 border border-zincLine">
        <div className="flex items-center justify-between border-b border-zincLine bg-[#fafaf8] p-4">
          <div>
            <div className="text-sm font-semibold">
              {formatMoney(plan.totalAmount, plan.currency)}
            </div>
            <div className="mt-1 text-xs text-steel">
              {installmentPlanStatus(plan.status)}
            </div>
          </div>
          <StatusBadge
            status={
              plan.status === "BROKEN"
                ? "INSTALLMENT_BROKEN"
                : "INSTALLMENT_ACTIVE"
            }
          />
        </div>
        <div className="grid md:grid-cols-3">
          {plan.payments.map((payment) => (
            <div
              key={payment.id}
              className="border-b border-zincLine p-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0"
            >
              <div className="text-xs text-steel">{payment.sequence}. splátka</div>
              <div className="mt-1 text-sm font-semibold">
                {formatMoney(payment.amount, plan.currency)}
              </div>
              <div className="mt-2 text-xs">
                {formatDate(payment.dueDate)} · {installmentStatus(payment.status)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PromiseSection({
  promise
}: {
  promise: DashboardCase["paymentPromises"][number];
}) {
  return (
    <section>
      <SectionTitle title="Prísľub platby" icon={CalendarClock} />
      <div className="mt-3 border border-zincLine bg-[#f6faf8] p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-semibold">
              Platba prisľúbená do {formatDate(promise.promisedDate)}
            </div>
            <div className="mt-1 text-sm text-steel">
              {promise.note ?? "Bez doplňujúcej poznámky."}
            </div>
          </div>
          <div className="shrink-0 text-sm font-semibold">
            {formatMoney(promise.amount, promise.currency)}
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({
  title,
  icon: Icon
}: {
  title: string;
  icon: typeof FileText;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-steel" />
      <h3 className="text-sm font-semibold">{title}</h3>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-b border-zincLine p-4 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <div className="text-xs text-steel">{label}</div>
      <div className="mt-1.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

function DataRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0 border-b border-zincLine p-3 last:border-b-0 md:border-r md:even:border-r-0">
      <dt className="text-xs text-steel">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium">{value || "—"}</dd>
    </div>
  );
}

function ReviewField({
  label,
  value,
  onChange,
  type = "text",
  error,
  help,
  maxLength,
  pattern
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date" | "email";
  error?: string;
  help?: string;
  maxLength?: number;
  pattern?: string;
}) {
  const inputId = useMemo(
    () => `field-${label.toLocaleLowerCase("sk").replace(/[^a-z0-9]+/gi, "-")}`,
    [label]
  );
  const describedBy = [
    help ? `${inputId}-help` : null,
    error ? `${inputId}-error` : null
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <label className="block min-w-0">
      <span className="text-xs text-steel">{label}</span>
      <input
        id={inputId}
        className={`mt-1 h-10 w-full border bg-white px-3 text-sm font-medium outline-none transition focus:ring-0 ${
          error
            ? "border-[#b04f32] focus:border-[#b04f32]"
            : "border-zincLine focus:border-ink"
        }`}
        type={type}
        step={type === "number" ? "0.01" : undefined}
        inputMode={type === "number" ? "decimal" : undefined}
        maxLength={maxLength}
        pattern={pattern}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={describedBy || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {help ? (
        <span id={`${inputId}-help`} className="mt-1 block text-[11px] text-steel">
          {help}
        </span>
      ) : null}
      {error ? (
        <span
          id={`${inputId}-error`}
          className="mt-1 block text-[11px] font-medium text-[#9c3e25]"
        >
          {error}
        </span>
      ) : null}
    </label>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta[status] ?? { label: status, tone: "neutral" as const };
  return (
    <span
      className={`inline-flex items-center gap-2 text-xs font-semibold ${toneTextClass(meta.tone)}`}
    >
      <StatusDot tone={meta.tone} />
      {meta.label}
    </span>
  );
}

function StatusDot({
  tone
}: {
  tone: "neutral" | "active" | "warn" | "danger" | "done";
}) {
  const classes = {
    neutral: "bg-[#89928d]",
    active: "bg-[#08736e]",
    warn: "bg-[#c4812d]",
    danger: "bg-[#b04f32]",
    done: "bg-[#4b7c28]"
  };
  return <span className={`h-2 w-2 shrink-0 rounded-full ${classes[tone]}`} />;
}

function EmptyCompact({ text }: { text: string }) {
  return <div className="p-4 text-sm text-steel">{text}</div>;
}

function EmptyPanel({
  icon: Icon,
  title,
  text
}: {
  icon: typeof Mail;
  title: string;
  text: string;
}) {
  return (
    <div className="border border-dashed border-zincLine px-6 py-14 text-center">
      <Icon className="mx-auto h-7 w-7 text-steel/50" />
      <div className="mt-3 text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-steel">{text}</div>
    </div>
  );
}

export function summarizeCases(cases: DashboardCase[]) {
  return cases.reduce(
    (summary, item) => {
      const closed = TERMINAL_STATUSES.has(item.status);
      summary.closed += closed ? 1 : 0;
      summary.open += closed ? 0 : 1;
      summary.attention +=
        ATTENTION_STATUSES.has(item.status) || item.automationPausedAt ? 1 : 0;
      summary.promises += PROMISE_STATUSES.has(item.status) ? 1 : 0;
      summary.installments += INSTALLMENT_STATUSES.has(item.status) ? 1 : 0;
      summary.paused += item.automationPausedAt ? 1 : 0;
      summary.legal += LEGAL_STATUSES.has(item.status) ? 1 : 0;
      summary.communications += item.communicationCount;
      return summary;
    },
    {
      open: 0,
      attention: 0,
      promises: 0,
      installments: 0,
      paused: 0,
      legal: 0,
      closed: 0,
      communications: 0
    }
  );
}

export function summarizeDebtors(debtors: DashboardDebtor[]) {
  return debtors.reduce(
    (summary, item) => {
      summary.active += item.openCaseCount > 0 ? 1 : 0;
      summary.withoutEmail += item.email ? 0 : 1;
      summary.cases += item.caseCount;
      return summary;
    },
    { total: debtors.length, active: 0, withoutEmail: 0, cases: 0 }
  );
}

export function filterDebtors(
  debtors: DashboardDebtor[],
  filter: DebtorFilterId,
  query: string
): DashboardDebtor[] {
  const normalized = query.trim().toLocaleLowerCase("sk");
  return debtors.filter((item) => {
    const matchesFilter =
      filter === "ALL" ||
      (filter === "ACTIVE" && item.openCaseCount > 0) ||
      (filter === "WITHOUT_EMAIL" && !item.email);
    if (!matchesFilter || !normalized) {
      return matchesFilter;
    }
    return [item.name, item.email, item.ico, item.dic, item.icDph, item.address].some(
      (value) => value?.toLocaleLowerCase("sk").includes(normalized)
    );
  });
}

export function filterCases(
  cases: DashboardCase[],
  filter: FilterId,
  query: string
): DashboardCase[] {
  const normalized = query.trim().toLocaleLowerCase("sk");
  return cases.filter((item) => {
    const matchesFilter =
      filter === "ALL" ||
      (filter === "ATTENTION" &&
        (ATTENTION_STATUSES.has(item.status) || Boolean(item.automationPausedAt))) ||
      (filter === "ACTIVE" && !TERMINAL_STATUSES.has(item.status)) ||
      (filter === "PROMISES" && PROMISE_STATUSES.has(item.status)) ||
      (filter === "INSTALLMENTS" && INSTALLMENT_STATUSES.has(item.status)) ||
      (filter === "CLOSED" && TERMINAL_STATUSES.has(item.status)) ||
      (filter === "COMMUNICATIONS" && item.communicationCount > 0) ||
      (filter === "WORKFLOW" &&
        Boolean(item.confirmedAt) &&
        !TERMINAL_STATUSES.has(item.status)) ||
      (filter === "LEGAL" && LEGAL_STATUSES.has(item.status));
    if (!matchesFilter || !normalized) {
      return matchesFilter;
    }
    return [
      item.invoiceNumber,
      item.debtorName,
      item.supplierName,
      item.debtorEmail
    ].some((value) => value?.toLocaleLowerCase("sk").includes(normalized));
  });
}

function navViewTitle(view: NavView) {
  return {
    CASES: "Prípady",
    DEBTORS: "Dlžníci",
    COMMUNICATIONS: "Komunikácia",
    WORKFLOW: "Workflow",
    LEGAL: "Právne kroky",
    ARCHIVE: "Archív"
  }[view];
}

function debtorFilterOptions(counts: ReturnType<typeof summarizeDebtors>) {
  return [
    { id: "ALL" as const, label: "Všetci", count: counts.total },
    { id: "ACTIVE" as const, label: "Aktívni", count: counts.active },
    {
      id: "WITHOUT_EMAIL" as const,
      label: "Bez emailu",
      count: counts.withoutEmail
    }
  ];
}

function filterOptions(counts: ReturnType<typeof summarizeCases>) {
  return [
    { id: "ALL" as const, label: "Všetky", count: counts.open + counts.closed },
    { id: "ATTENTION" as const, label: "Pozornosť", count: counts.attention },
    { id: "ACTIVE" as const, label: "Aktívne", count: counts.open },
    { id: "PROMISES" as const, label: "Sľuby", count: counts.promises },
    {
      id: "INSTALLMENTS" as const,
      label: "Splátky",
      count: counts.installments
    },
    { id: "CLOSED" as const, label: "Uzavreté", count: counts.closed }
  ];
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

async function readApiPayload(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function getReviewFieldErrors(
  errors: string[],
  form: ReviewFormState
): ReviewFieldErrors {
  const fieldErrors: ReviewFieldErrors = {};
  for (const error of errors) {
    const field = validationErrorField(error);
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = error;
    }
  }

  if (form.currency.trim() && !/^[A-Z]{3}$/.test(form.currency.trim())) {
    fieldErrors.currency = "Mena musí byť trojpísmenový ISO kód, napr. EUR.";
  }

  return fieldErrors;
}

function validationErrorField(error: string): keyof ReviewFormState | null {
  const normalized = error.toLocaleLowerCase("sk");
  if (normalized.includes("číslo faktúry")) {
    return "invoiceNumber";
  }
  if (normalized.includes("dátum splatnosti")) {
    return "dueDate";
  }
  if (normalized.includes("suma")) {
    return "amountTotal";
  }
  if (normalized.includes("odberateľ") || normalized.includes("dlžník")) {
    return "debtorName";
  }
  if (normalized.includes("mena")) {
    return "currency";
  }
  return null;
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

function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null) {
    return "Suma nezadaná";
  }
  return new Intl.NumberFormat("sk-SK", {
    style: "currency",
    currency: currency ?? "EUR"
  }).format(amount);
}

function formatDebtorAmounts(amounts: DashboardDebtor["openAmounts"]) {
  if (!amounts.length) {
    return "Bez otvoreného dlhu";
  }
  return amounts
    .map(({ amount, currency }) => formatMoney(amount, currency))
    .join(" + ");
}

function slovakCaseLabel(count: number) {
  if (count === 1) {
    return "faktúra";
  }
  if (count >= 2 && count <= 4) {
    return "faktúry";
  }
  return "faktúr";
}

function slovakOpenCaseLabel(count: number) {
  if (count === 1) {
    return "otvorený";
  }
  if (count >= 2 && count <= 4) {
    return "otvorené";
  }
  return "otvorených";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function nextActionLabel(item: DashboardCase, long = false) {
  if (item.automationPausedAt) {
    return "Pozastavené";
  }
  if (TERMINAL_STATUSES.has(item.status)) {
    return item.closedAt ? `Uzavreté ${formatDate(item.closedAt)}` : "Uzavreté";
  }
  if (item.nextActionAt) {
    return `${long ? "Naplánované na " : ""}${formatDate(item.nextActionAt)}`;
  }
  if (item.status === "WAITING_FOR_DUE_DATE" && item.dueDate) {
    return `${long ? "Kontrola " : ""}${formatDate(item.dueDate)}`;
  }
  return "Čaká na udalosť";
}

function toneTextClass(
  tone: "neutral" | "active" | "warn" | "danger" | "done"
) {
  return {
    neutral: "text-steel",
    active: "text-[#08736e]",
    warn: "text-[#98621f]",
    danger: "text-warn",
    done: "text-[#4b7c28]"
  }[tone];
}

function pauseReasonLabel(reason: string | null) {
  const labels: Record<string, string> = {
    MANUAL_PAUSE: "Pozastavené používateľom.",
    MISSING_DEBTOR_EMAIL: "Chýba email dlžníka. Doplňte kontakt a obnovte workflow.",
    MISSING_CUSTOMER_EMAIL: "Chýba email zákazníka pre kontrolu platby.",
    DEBTOR_DISPUTE: "Dlžník namietal faktúru. Prípad vyžaduje rozhodnutie.",
    REPEATED_UNCLEAR_REPLY: "Odpoveď dlžníka zostala nejasná po upresnení.",
    MANUAL_REVIEW_REQUIRED: "Údaje alebo odpoveď vyžadujú manuálnu kontrolu."
  };
  return labels[reason ?? ""] ?? reason ?? "Dôvod nie je uvedený.";
}

function actionMessage(action: string) {
  return {
    MARK_PAID: "Prípad bol označený ako uhradený.",
    PAUSE_AUTOMATION: "Automatizácia bola pozastavená.",
    RESUME_AUTOMATION: "Automatizácia bola obnovená.",
    CANCEL_CASE: "Prípad bol zastavený."
  }[action];
}

function paymentCheckReason(reason: string) {
  return {
    DUE_DATE: "Kontrola po splatnosti",
    FOLLOW_UP: "Opakovaná kontrola",
    DEBTOR_CLAIMED_PAID: "Dlžník uviedol úhradu",
    PROMISE_DUE: "Kontrola prísľubu",
    INSTALLMENT_PAYMENT: "Kontrola splátky"
  }[reason] ?? reason;
}

function paymentCheckStatus(status: string) {
  return {
    PENDING: "Pripravuje sa",
    SENT: "Čaká na odpoveď",
    RESOLVED_PAID: "Potvrdené",
    RESOLVED_NOT_PAID: "Nezaplatené"
  }[status] ?? status;
}

function installmentPlanStatus(status: string) {
  return {
    PROPOSED: "Čaká na súhlas",
    ACTIVE: "Aktívny plán",
    COMPLETED: "Dokončený",
    BROKEN: "Porušený",
    REJECTED: "Odmietnutý"
  }[status] ?? status;
}

function installmentStatus(status: string) {
  return {
    PENDING: "čaká",
    PAID: "uhradená",
    MISSED: "nezaplatená",
    MANUAL_REVIEW_REQUIRED: "na kontrolu"
  }[status] ?? status;
}

function eventTypeLabel(type: string) {
  return type
    .toLocaleLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
