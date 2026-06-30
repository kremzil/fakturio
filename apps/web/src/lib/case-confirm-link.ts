import {
  createCaseConfirmToken,
  CASE_CONFIRM_TOKEN_DEFAULT_TTL_MS,
  requireCaseConfirmTokenSecret,
  verifyCaseConfirmToken
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { confirmCaseForWorkflow } from "./case-confirm";

const NO_STORE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer"
} as const;

export function createCaseConfirmUrl(input: {
  appBaseUrl: string;
  caseId: string;
  organizationId: string;
  now?: number;
}): string {
  const expiresAt =
    (input.now ?? Date.now()) + CASE_CONFIRM_TOKEN_DEFAULT_TTL_MS;
  const token = createCaseConfirmToken(
    {
      caseId: input.caseId,
      organizationId: input.organizationId,
      expiresAt
    },
    requireCaseConfirmTokenSecret()
  );
  return `${input.appBaseUrl.replace(/\/+$/u, "")}/api/cases/${encodeURIComponent(input.caseId)}/confirm-link?token=${encodeURIComponent(token)}`;
}

export async function handleCaseConfirmLinkGet(
  request: Request,
  caseId: string
): Promise<Response> {
  const verification = verifyToken(request, caseId);
  if (!verification.ok) {
    return invalidTokenPage(verification.reason);
  }

  const collectionCase = await prisma.case.findFirst({
    where: {
      id: caseId,
      organizationId: verification.claims.organizationId
    },
    include: { debtor: true }
  });
  if (!collectionCase) {
    return page("Prípad neexistuje", "Tento prípad sa nenašiel.", 404);
  }

  const token = new URL(request.url).searchParams.get("token")!;
  return page(
    "Potvrdenie prípadu",
    `
      <p>Potvrďte, že údaje faktúry sú správne a FAKTURIO môže spustiť kontrolu splatnosti.</p>
      ${summaryHtml(collectionCase)}
      <form method="post" action="${escapeHtml(`?token=${token}`)}">
        <button type="submit" style="display:inline-block;padding:10px 16px;background:#1d1d1b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px">Potvrdiť a spustiť kontrolu</button>
      </form>
    `,
    200
  );
}

export async function handleCaseConfirmLinkPost(
  request: Request,
  caseId: string
): Promise<Response> {
  const verification = verifyToken(request, caseId);
  if (!verification.ok) {
    return invalidTokenPage(verification.reason);
  }

  const result = await confirmCaseForWorkflow({
    caseId,
    organizationId: verification.claims.organizationId,
    actorType: "EMAIL_PROVIDER",
    note: "Case confirmed by customer through signed email link."
  });

  if (result.outcome === "NOT_FOUND") {
    return page("Prípad neexistuje", "Tento prípad sa nenašiel.", 404);
  }
  if (result.outcome === "CONFLICT") {
    return page("Prípad nemožno potvrdiť", escapeHtml(result.message), 409);
  }
  if (result.outcome === "VALIDATION_FAILED") {
    return page(
      "Chýbajú údaje",
      `<p>Prípad zatiaľ nemožno spustiť:</p><ul>${result.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`,
      422
    );
  }
  if (result.outcome === "NOOP") {
    return autoClosePage({
      title: "Prípad už bol potvrdený",
      message: "Kontrola splatnosti už bola spustená.",
      caseId,
      status: 200
    });
  }
  return autoClosePage({
    title: "Prípad bol potvrdený",
    message:
      "Kontrola splatnosti bola spustená. Táto karta sa môže automaticky zatvoriť.",
    caseId,
    status: 200
  });
}

function verifyToken(request: Request, caseId: string) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return verifyCaseConfirmToken(token, requireCaseConfirmTokenSecret(), {
    expectedCaseId: caseId
  });
}

function invalidTokenPage(reason: string): Response {
  return page(
    "Neplatný odkaz",
    `Tento odkaz nemožno použiť (${escapeHtml(reason)}).`,
    400
  );
}

function summaryHtml(collectionCase: {
  invoiceNumber: string | null;
  status: string;
  dueDate: Date | null;
  amountTotal: unknown;
  currency: string | null;
  debtor: { name: string } | null;
}) {
  const amount =
    collectionCase.amountTotal !== null && collectionCase.amountTotal !== undefined
      ? `${Number(collectionCase.amountTotal).toFixed(2)} ${collectionCase.currency ?? ""}`.trim()
      : "nezadaná";
  return `
    <dl style="display:grid;grid-template-columns:max-content 1fr;gap:8px 18px;margin:18px 0">
      <dt>Stav</dt><dd>${escapeHtml(collectionCase.status)}</dd>
      <dt>Faktúra</dt><dd>${escapeHtml(collectionCase.invoiceNumber ?? "nezadaná")}</dd>
      <dt>Dlžník</dt><dd>${escapeHtml(collectionCase.debtor?.name ?? "nezadaný")}</dd>
      <dt>Suma</dt><dd>${escapeHtml(amount)}</dd>
      <dt>Splatnosť</dt><dd>${escapeHtml(collectionCase.dueDate?.toISOString().slice(0, 10) ?? "nezadaná")}</dd>
    </dl>
  `;
}

function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title></head><body style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#1d1d1b;max-width:640px;margin:40px auto;padding:0 20px"><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: NO_STORE_HEADERS }
  );
}

function autoClosePage(input: {
  title: string;
  message: string;
  caseId: string;
  status: number;
}): Response {
  const dashboardUrl = `/?case=${encodeURIComponent(input.caseId)}`;
  return page(
    input.title,
    `
      <p>${escapeHtml(input.message)}</p>
      <p id="closing-note">Pokúšame sa zatvoriť túto kartu a vrátiť vás späť.</p>
      <p id="fallback-note" style="display:none">
        Ak prehliadač kartu nezatvoril automaticky,
        <a href="${escapeHtml(dashboardUrl)}">otvorte prípad v aplikácii</a>.
      </p>
      <script>
        (function () {
          var fallbackUrl = ${JSON.stringify(dashboardUrl)};
          function showFallback() {
            var note = document.getElementById("fallback-note");
            if (note) note.style.display = "block";
            window.setTimeout(function () {
              window.location.replace(fallbackUrl);
            }, 1200);
          }
          window.setTimeout(function () {
            try {
              if (window.opener && !window.opener.closed) {
                window.opener.focus();
              }
            } catch (_) {}
            window.close();
            window.setTimeout(showFallback, 700);
          }, 250);
        })();
      </script>
    `,
    input.status
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
