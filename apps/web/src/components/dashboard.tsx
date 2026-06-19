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
  X
} from "lucide-react";
import type {
  DashboardCase,
  DashboardCommunication,
  DashboardEvent
} from "@/lib/case-data";

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
type NavView = "CASES" | "COMMUNICATIONS" | "WORKFLOW" | "LEGAL" | "ARCHIVE";
type DetailTab = "OVERVIEW" | "TIMELINE" | "COMMUNICATIONS";
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
  const [filter, setFilter] = useState<FilterId>("ALL");
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
  const [message, setMessage] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const filteredCases = useMemo(
    () => filterCases(cases, filter, deferredQuery),
    [cases, filter, deferredQuery]
  );
  const selected = useMemo(
    () => cases.find((item) => item.id === selectedId) ?? cases[0] ?? null,
    [cases, selectedId]
  );
  const counts = useMemo(() => summarizeCases(cases), [cases]);
  const [reviewForm, setReviewForm] = useState<ReviewFormState>(() =>
    toReviewForm(initialCases[0] ?? null)
  );

  useEffect(() => {
    setReviewForm(toReviewForm(selected));
    setContactEmail(selected?.debtorEmail ?? "");
    setReviewDirty(false);
    setValidationErrors([]);
    setDetailTab("OVERVIEW");
  }, [selected]);

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

  async function uploadInvoice(formData: FormData) {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setMessage("Vyberte PDF alebo obrázok faktúry.");
      return;
    }
    setUploading(true);
    setMessage(null);
    try {
      const response = await fetch("/api/cases/upload", {
        method: "POST",
        body: formData
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Nahratie zlyhalo.");
        return;
      }
      replaceCase(payload.case, true);
      setMessage("Faktúra bola načítaná do nového prípadu.");
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
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Uloženie zlyhalo.");
        return false;
      }
      replaceCase(payload.case);
      setReviewDirty(false);
      if (showMessage) {
        setMessage("Zmeny boli uložené.");
      }
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function confirmCase() {
    if (!selected || !(await saveDraft(false))) {
      return;
    }
    setConfirming(true);
    setMessage(null);
    setValidationErrors([]);
    try {
      const response = await fetch(`/api/cases/${selected.id}/confirm`, {
        method: "POST"
      });
      const payload = await response.json();
      if (response.ok) {
        replaceCase(payload.case);
        setMessage("Faktúra bola potvrdená a workflow je aktívny.");
      } else {
        setValidationErrors(
          payload.errors ?? [payload.error ?? "Potvrdenie zlyhalo."]
        );
      }
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
      setMessage(null);
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
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Akciu sa nepodarilo vykonať.");
        return;
      }
      replaceCase(payload.case);
      setMessage(actionMessage(action) ?? "Akcia bola vykonaná.");
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
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Detail prípadu sa nepodarilo načítať.");
        return;
      }
      replaceCase(payload.case);
    } finally {
      setDetailLoadingId(null);
    }
  }

  function updateReviewField(field: keyof ReviewFormState, value: string) {
    setReviewForm((current) => ({ ...current, [field]: value }));
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
    setMessage(null);
    try {
      const response = await fetch(`/api/cases/${selected.id}/contact`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtorEmail: contactEmail })
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error ?? "Kontakt sa nepodarilo uložiť.");
        return;
      }
      replaceCase(payload.case);
      setMessage("Email dlžníka bol uložený. Teraz môžete obnoviť workflow.");
    } finally {
      setContactSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#edf0ed] text-ink">
      <div className="min-h-screen xl:grid xl:grid-cols-[196px_430px_minmax(0,1fr)]">
        <Sidebar
          counts={counts}
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
                  {counts.open} otvorených · {counts.attention} vyžaduje zásah
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
                placeholder="Hľadať faktúru alebo dlžníka"
              />
            </label>

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
          </div>

          {message ? (
            <div className="border-b border-zincLine bg-ledger/45 px-5 py-3 text-sm">
              {message}
            </div>
          ) : null}

          <div className="max-h-[640px] overflow-y-auto xl:max-h-[calc(100vh-230px)]">
            {filteredCases.length ? (
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
                <p className="mt-3 text-sm font-medium">Žiadne prípady</p>
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
          {selected ? (
            <>
              <CaseHeader
                item={selected}
                pending={isActionPending}
                onAction={runCaseAction}
                onBack={closeMobileDetail}
              />
              <DetailTabs
                active={detailTab}
                onChange={setDetailTab}
                item={selected}
              />
              {message ? (
                <div className="border-b border-zincLine bg-ledger/45 px-5 py-3 text-sm xl:hidden">
                  {message}
                </div>
              ) : null}
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
                ) : (
                  <CommunicationsPanel
                    communications={selected.communications}
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
  activeView,
  onNavigate
}: {
  counts: ReturnType<typeof summarizeCases>;
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
              activeView={activeView}
              onSelect={(view) => {
                onNavigate(view);
                setMobileMenuOpen(false);
              }}
            />
            <AccountSummary />
          </aside>
        </div>
      ) : null}

      <aside className="hidden bg-[#073f3f] text-white xl:flex xl:min-h-screen xl:flex-col">
        <div className="flex min-h-20 items-center border-b border-white/10 px-5">
          <div className="text-xl font-bold tracking-[0.12em]">FAKTURIO</div>
        </div>
        <Navigation
          counts={counts}
          activeView={activeView}
          onSelect={onNavigate}
        />
        <AccountSummary />
      </aside>
    </>
  );
}

function Navigation({
  counts,
  activeView,
  onSelect
}: {
  counts: ReturnType<typeof summarizeCases>;
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

function AccountSummary() {
  return (
    <div className="border-t border-white/15 p-4">
      <div className="text-xs text-white/55">Aktívny účet</div>
      <div className="mt-1 text-sm font-medium">Lokálna organizácia</div>
      <div className="mt-4 flex items-center gap-2 text-xs text-white/65">
        <CheckCircle2 className="h-4 w-4 text-ledger" />
        Systémy pripravené
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
              onClick={() => {
                if (window.confirm("Naozaj chcete zastaviť tento prípad?")) {
                  onAction("CANCEL_CASE");
                }
              }}
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
            onClick={() => {
              if (window.confirm("Naozaj chcete zastaviť tento prípad?")) {
                onAction("CANCEL_CASE");
              }
            }}
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
    }
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
                    onChange={(value) => onFieldChange("invoiceNumber", value)}
                  />
                  <ReviewField
                    label="Dátum splatnosti"
                    type="date"
                    value={form.dueDate}
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
                      onChange={(value) => onFieldChange("amountTotal", value)}
                    />
                    <ReviewField
                      label="Mena"
                      value={form.currency}
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

            {item.warnings.length || validationErrors.length ? (
              <div className="mt-3 border border-[#e2bd78] bg-[#fff9ed] p-3 text-sm text-[#845112]">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  Vyžaduje pozornosť
                </div>
                {[...item.warnings, ...validationErrors].map((warning) => (
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
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date" | "email";
}) {
  return (
    <label className="block min-w-0">
      <span className="text-xs text-steel">{label}</span>
      <input
        className="mt-1 h-10 w-full border border-zincLine bg-white px-3 text-sm font-medium outline-none transition focus:border-ink focus:ring-0"
        type={type}
        step={type === "number" ? "0.01" : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
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
    COMMUNICATIONS: "Komunikácia",
    WORKFLOW: "Workflow",
    LEGAL: "Právne kroky",
    ARCHIVE: "Archív"
  }[view];
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
