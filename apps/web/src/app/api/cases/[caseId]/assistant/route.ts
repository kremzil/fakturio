import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CustomerEmailAssistantService,
  type CustomerAssistantActionResult
} from "@fakturio/intake";
import { createAiProvider } from "@fakturio/ai";
import { prisma } from "@fakturio/db";
import {
  createCaseClarificationAddress,
  requireInboundReplyTokenSecret,
  type DashboardCaseAssistantInput
} from "@fakturio/shared";
import type { InboundEmail } from "@fakturio/email";
import { getCaseForOrg } from "@/lib/case-access";
import {
  dashboardCaseInclude,
  toDashboardCase,
  type DashboardCase,
  type DashboardEvent
} from "@/lib/case-data";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

const assistantMessageSchema = z.object({
  message: z.string().trim().min(2).max(4000)
});

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();
    const { message } = assistantMessageSchema.parse(await request.json());

    const collectionCase = await getCaseForOrg(caseId, organizationId);
    if (!collectionCase) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true }
    });
    const from = user?.email ?? "dashboard@fakturio.local";
    const providerId = `dashboard-${caseId}-${randomUUID()}`;
    const clarifyAddress = createCaseClarificationAddress(
      { caseId, domain: inboundReplyDomain() },
      requireInboundReplyTokenSecret()
    );
    const inbound: InboundEmail = {
      provider: "dashboard",
      providerId,
      messageId: `<${providerId}@dashboard.fakturio.local>`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from,
      to: [clarifyAddress],
      cc: [],
      subject: "Dashboard assistant",
      textBody: message,
      htmlBody: null,
      attachments: [],
      raw: {
        source: "dashboard",
        userId,
        organizationId
      }
    };

    const result = await new CustomerEmailAssistantService().process(
      inbound,
      undefined,
      { sendReply: false, directUserCommand: true, actorUserId: userId }
    );

    if (!result || result.caseId !== caseId || result.organizationId !== organizationId) {
      return NextResponse.json(
        { error: "Správu sa nepodarilo priradiť k prípadu." },
        { status: 409 }
      );
    }

    const updated = await getCaseForOrg(caseId, organizationId, dashboardCaseInclude);
    if (!updated) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const dashboardCase = toDashboardCase(updated);
    const chatReply = await buildDashboardChatReply(
      message,
      result,
      dashboardCase,
      organizationId
    );

    return NextResponse.json({
      case: dashboardCase,
      assistant: {
        intent: result.intent,
        reply: chatReply,
        emailReply: result.assistantReply,
        appliedFields: result.appliedFields,
        stillMissing: result.stillMissing
      }
    });
  } catch (error) {
    return httpErrorResponse(error);
  }
}

function inboundReplyDomain(): string {
  return (
    process.env.INBOUND_REPLY_DOMAIN ||
    process.env.SES_INBOUND_DOMAIN ||
    "fakturio.test"
  );
}

async function buildDashboardChatReply(
  message: string,
  result: {
    intent: string;
    appliedFields: string[];
    stillMissing: string[];
    action: CustomerAssistantActionResult;
    assistantReply: { subject: string; textBody: string } | null;
  },
  collectionCase: DashboardCase,
  organizationId: string
): Promise<{ subject: string; textBody: string }> {
  const language = detectMessageLanguage(message);
  if (asksCapabilities(message)) {
    return buildDeterministicDashboardChatReply(message, result, collectionCase);
  }
  if (shouldUseFreeDashboardAssistant(result)) {
    try {
      const reply = await createAiProvider().answerDashboardCaseMessage(
        buildDashboardAssistantInput(message, language, collectionCase, organizationId)
      );
      return {
        subject: reply.subject,
        textBody: reply.textBody
      };
    } catch {
      return buildDeterministicDashboardChatReply(message, result, collectionCase);
    }
  }
  return buildDeterministicDashboardChatReply(message, result, collectionCase);
}

function shouldUseFreeDashboardAssistant(result: {
  intent: string;
  appliedFields: string[];
  action: CustomerAssistantActionResult;
}): boolean {
  if (result.action.kind !== "NONE" || result.appliedFields.length > 0) {
    return false;
  }
  return [
    "ASK_CASE_STATUS",
    "ASK_CASE_HISTORY",
    "ASK_MISSING_FIELDS",
    "ADD_CASE_NOTE",
    "OTHER"
  ].includes(result.intent);
}

function buildDashboardAssistantInput(
  message: string,
  language: "sk" | "ru",
  collectionCase: DashboardCase,
  organizationId: string
): DashboardCaseAssistantInput {
  return {
    organizationId,
    caseId: collectionCase.id,
    userMessage: message,
    userLanguage: language,
    caseSnapshot: {
      invoiceNumber: collectionCase.invoiceNumber,
      status: collectionCase.status,
      debtorName: collectionCase.debtorName,
      debtorEmail: collectionCase.debtorEmail,
      supplierName: collectionCase.supplierName,
      amountTotal: collectionCase.amountTotal,
      currency: collectionCase.currency,
      dueDate: collectionCase.dueDate,
      automationPaused: Boolean(collectionCase.automationPausedAt),
      automationPauseReason: collectionCase.automationPauseReason,
      nextActionAt: collectionCase.nextActionAt
    },
    recentEvents: collectionCase.events
      .filter((event) => !isAssistantSelfEvent(event))
      .slice(0, 12)
      .map((event) => ({
        type: event.type,
        actorType: event.actorType,
        note: event.note,
        createdAt: event.createdAt,
        payload: event.payload ?? null
      })),
    recentCommunications: collectionCase.communications
      .filter((communication) => communication.kind !== "customer-email-assistant-message")
      .slice(0, 10)
      .map((communication) => ({
        direction: (communication.direction === "INBOUND" ? "INBOUND" : "OUTBOUND") as
          | "INBOUND"
          | "OUTBOUND",
        fromAddress: communication.fromAddress,
        toAddress: communication.toAddress,
        subject: communication.subject,
        textBody: trimCommunicationText(communication.textBody),
        createdAt: communication.createdAt,
        kind: communication.kind ?? null,
        aiSummary: communication.aiSummary ?? null,
        aiIntent: communication.aiIntent ?? null
      })),
    allowedActions: allowedDashboardAssistantActions(collectionCase)
  };
}

function trimCommunicationText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.replace(/\s+/gu, " ").trim().slice(0, 1200);
}

function allowedDashboardAssistantActions(collectionCase: DashboardCase): string[] {
  const actions: string[] = [];
  const terminal = ["CLOSED_PAID", "CLOSED_CANCELLED", "CLOSED_UNRESOLVED"].includes(
    collectionCase.status
  );
  if (!terminal) {
    if (collectionCase.automationPausedAt) {
      actions.push("resume automation");
    } else if (collectionCase.confirmedAt) {
      actions.push("pause automation");
    }
    if (collectionCase.confirmedAt) {
      actions.push("mark as paid");
    }
    actions.push("cancel case");
  }
  if (collectionCase.debtorEmail && !terminal) {
    actions.push("send neutral debtor message");
    actions.push("send approved final notice");
    actions.push("offer standard three-payment installment plan");
  }
  if (!collectionCase.confirmedAt) {
    actions.push("confirm and start case when required fields are ready");
  }
  return actions;
}

function buildDeterministicDashboardChatReply(
  message: string,
  result: {
    intent: string;
    appliedFields: string[];
    stillMissing: string[];
    action: CustomerAssistantActionResult;
    assistantReply: { subject: string; textBody: string } | null;
  },
  collectionCase: DashboardCase
): { subject: string; textBody: string } {
  const language = detectMessageLanguage(message);
  if (asksCapabilities(message)) {
    return {
      subject: language === "ru" ? "Что я могу сделать" : "Čo môžem urobiť",
      textBody:
        language === "ru"
          ? [
              "Я могу работать с этим конкретным делом, а не просто отвечать общими фразами.",
              "",
              "Что можно попросить:",
              "- объяснить, что уже произошло по делу;",
              "- показать текущий статус, сумму, должника и ближайший шаг;",
              "- дополнить недостающие данные по фактуре;",
              "- запустить дело, если данные готовы;",
              "- отправить должнику стандартный план рассрочки;",
              "- отправить должнику нейтральное сообщение от вашего имени;",
              "- отправить утверждённое финальное уведомление перед legal-review;",
              "- поставить автоматизацию на паузу или возобновить её;",
              "- отметить дело оплаченным или остановить его, если статус это позволяет;",
              "- зафиксировать комментарий в истории дела.",
              "",
              "Базовые ограничения: я не меняю сумму долга из свободного текста, не утверждаю скидки и нестандартные юридические условия, не подаю иски и не пишу произвольные юридические угрозы. Вместо этого могу отправить только утверждённый final-notice шаблон. Если упрусь в ограничение, объясню, что именно заблокировано и где это можно изменить вручную."
            ].join("\n")
          : [
              "Môžem pracovať s týmto konkrétnym prípadom, nie iba odpovedať všeobecne.",
              "",
              "Môžete ma požiadať napríklad o:",
              "- zhrnutie toho, čo sa už v prípade stalo;",
              "- vysvetlenie aktuálneho stavu, sumy, dlžníka a ďalšieho kroku;",
              "- doplnenie chýbajúcich údajov z faktúry;",
              "- spustenie prípadu, ak sú údaje pripravené;",
              "- odoslanie štandardného splátkového kalendára dlžníkovi;",
              "- odoslanie neutrálnej správy dlžníkovi podľa vášho pokynu;",
              "- odoslanie schválenej poslednej výzvy pred legal-review;",
              "- pozastavenie alebo obnovenie automatizácie;",
              "- označenie prípadu ako uhradeného alebo jeho zastavenie, ak to stav dovoľuje;",
              "- uloženie poznámky do histórie prípadu.",
              "",
              "Základné obmedzenia: nemením výšku dlhu z voľného textu, neschvaľujem zľavy ani neštandardné právne podmienky, nepodávam žaloby a nepíšem voľné právne hrozby. Namiesto toho môžem poslať iba schválenú šablónu poslednej výzvy. Ak narazím na obmedzenie, poviem, čo je blokované a kde to môžete upraviť manuálne."
            ].join("\n")
    };
  }

  if (result.intent === "ASK_CASE_STATUS" || result.intent === "ASK_CASE_HISTORY") {
    return {
      subject:
        language === "ru"
          ? `Кратко по делу ${collectionCase.invoiceNumber ?? collectionCase.id}`
          : `Zhrnutie prípadu ${collectionCase.invoiceNumber ?? collectionCase.id}`,
      textBody: buildCaseSummaryForChat(collectionCase, language)
    };
  }

  if (result.appliedFields.length > 0) {
    const applied = result.appliedFields.map((field) => readableField(field, language)).join(", ");
    const missing =
      result.stillMissing.length > 0
        ? result.stillMissing.join("\n- ")
        : null;
    return {
      subject: language === "ru" ? "Данные обновлены" : "Údaje som doplnil",
      textBody:
        language === "ru"
          ? [
              `Я дополнил: ${applied}.`,
              missing ? `Ещё не хватает:\n- ${missing}` : "Обязательные данные выглядят заполненными.",
              "Проверьте карточку дела справа/сверху. Если всё верно, можно попросить меня запустить дело."
            ].filter(Boolean).join("\n\n")
          : [
              `Doplnil som: ${applied}.`,
              missing ? `Stále chýba:\n- ${missing}` : "Povinné údaje vyzerajú byť vyplnené.",
              "Skontrolujte kartu prípadu. Ak je všetko správne, môžete ma požiadať o spustenie prípadu."
            ].filter(Boolean).join("\n\n")
    };
  }

  if (result.intent === "REQUEST_CONFIRM_INVOICE") {
    if (result.action.kind === "CASE_CONFIRMED") {
      return {
        subject: language === "ru" ? "Дело запущено" : "Prípad je spustený",
        textBody:
          language === "ru"
            ? "Готово, я запустил дело. Теперь система будет контролировать срок оплаты и продолжит автоматизацию по текущему сценарию."
            : "Hotovo, prípad som spustil. Systém bude sledovať splatnosť a pokračovať podľa nastaveného scenára."
      };
    }
    if (result.action.kind === "CASE_ALREADY_CONFIRMED") {
      return {
        subject: language === "ru" ? "Дело уже запущено" : "Prípad už je spustený",
        textBody:
          language === "ru"
            ? "Это дело уже было запущено раньше. Я ничего не менял, автоматизация продолжает работать по текущему статусу."
            : "Tento prípad už bol spustený skôr. Nič som nemenil, automatizácia pokračuje podľa aktuálneho stavu."
      };
    }
    return {
      subject: language === "ru" ? "Запуск дела" : "Spustenie prípadu",
      textBody:
        language === "ru"
          ? `Я обработал команду запуска. Текущий статус дела: ${readableStatus(collectionCase.status, "ru")}.`
          : `Pokyn na spustenie som spracoval. Aktuálny stav prípadu: ${readableStatus(collectionCase.status, "sk")}.`
    };
  }

  if (result.intent === "REQUEST_PAUSE") {
    return {
      subject: language === "ru" ? "Пауза автоматизации" : "Pozastavenie automatizácie",
      textBody: actionReply(result.action, collectionCase, language)
    };
  }

  if (result.intent === "REQUEST_RESUME") {
    return {
      subject: language === "ru" ? "Возобновление автоматизации" : "Obnovenie automatizácie",
      textBody: actionReply(result.action, collectionCase, language)
    };
  }

  if (result.intent === "REQUEST_MARK_PAID") {
    return {
      subject: language === "ru" ? "Оплата отмечена" : "Úhrada označená",
      textBody: actionReply(result.action, collectionCase, language)
    };
  }

  if (result.intent === "REQUEST_CANCEL") {
    return {
      subject: language === "ru" ? "Дело остановлено" : "Prípad zastavený",
      textBody: actionReply(result.action, collectionCase, language)
    };
  }

  if (result.intent === "REQUEST_STANDARD_INSTALLMENT_PLAN") {
    if (
      result.action.kind === "INSTALLMENT_PROPOSAL_SENT" ||
      result.action.kind === "INSTALLMENT_PROPOSAL_ALREADY_EXISTS" ||
      result.action.kind === "ACTION_BLOCKED"
    ) {
      return {
        subject: language === "ru" ? "План рассрочки" : "Splátkový kalendár",
        textBody: actionReply(result.action, collectionCase, language)
      };
    }
    return {
      subject: language === "ru" ? "План рассрочки" : "Splátkový kalendár",
      textBody:
        language === "ru"
          ? "Я обработал запрос на стандартную рассрочку. Если план можно отправить в текущем статусе дела, должник получит предложение из трёх платежей. Если статус дела это блокирует, я оставлю запись в истории и попрошу действие через подходящий сценарий."
          : "Spracoval som požiadavku na štandardný splátkový kalendár. Ak to aktuálny stav prípadu dovoľuje, dlžník dostane návrh troch platieb. Ak to stav blokuje, zapíšem pokyn do histórie a požiadam o ďalší bezpečný krok."
    };
  }

  if (result.intent === "REQUEST_SEND_DEBTOR_MESSAGE") {
    if (
      result.action.kind === "DEBTOR_MESSAGE_SENT" ||
      result.action.kind === "ACTION_BLOCKED"
    ) {
      return {
        subject: language === "ru" ? "Сообщение должнику" : "Správa dlžníkovi",
        textBody: actionReply(result.action, collectionCase, language)
      };
    }
    const fallback = result.assistantReply?.textBody;
    return {
      subject: language === "ru" ? "Сообщение должнику" : "Správa dlžníkovi",
      textBody:
        language === "ru"
          ? normalizeEmailTemplateForChat(
              fallback,
              "Я обработал просьбу отправить сообщение должнику. Если текст нейтральный и разрешён правилами, сообщение отправлено. Если в тексте есть юридическая угроза или небезопасная формулировка, я не отправляю его автоматически и объясняю причину."
            )
          : normalizeEmailTemplateForChat(
              fallback,
              "Spracoval som požiadavku na správu dlžníkovi. Ak je text neutrálny a povolený pravidlami, správa bola odoslaná. Ak obsahuje právnu hrozbu alebo nebezpečnú formuláciu, automaticky ju neodošlem a vysvetlím dôvod."
            )
    };
  }

  if (result.intent === "REQUEST_FINAL_NOTICE") {
    return {
      subject: language === "ru" ? "Финальное уведомление" : "Posledná výzva",
      textBody: actionReply(result.action, collectionCase, language)
    };
  }

  return {
    subject: language === "ru" ? "Ответ ассистента" : "Odpoveď asistenta",
    textBody:
      language === "ru"
        ? normalizeEmailTemplateForChat(
            result.assistantReply?.textBody,
            "Я обработал сообщение и записал его в историю дела. Если вы хотите, можете спросить: “что произошло по делу?”, “что можно сделать дальше?” или дать конкретную команду."
          )
        : normalizeEmailTemplateForChat(
            result.assistantReply?.textBody,
            "Správu som spracoval a zapísal do histórie prípadu. Môžete sa opýtať „čo sa stalo v tomto prípade?“ alebo mi dať konkrétny pokyn."
          )
  };
}

function actionReply(
  action: CustomerAssistantActionResult,
  collectionCase: DashboardCase,
  language: "sk" | "ru"
): string {
  if (action.kind === "CASE_PAUSED") {
    return language === "ru"
      ? "Готово, я поставил автоматизацию по этому делу на паузу. В истории дела это записано. Когда нужно будет продолжить, напишите здесь “возобнови автоматизацию” или нажмите действие в dashboard."
      : "Hotovo, automatizáciu pri tomto prípade som pozastavil. Zapísal som to do histórie. Keď budete chcieť pokračovať, napíšte sem „obnov automatizáciu“ alebo použite akciu v dashboarde.";
  }
  if (action.kind === "CASE_ALREADY_PAUSED") {
    return language === "ru"
      ? "Автоматизация уже была на паузе, поэтому я ничего не менял."
      : "Automatizácia už bola pozastavená, preto som nič nemenil.";
  }
  if (action.kind === "CASE_RESUMED") {
    return language === "ru"
      ? "Готово, я возобновил автоматизацию. Если есть ближайший шаг, workflow продолжит с него."
      : "Hotovo, automatizáciu som obnovil. Ak existuje najbližší krok, workflow bude pokračovať od neho.";
  }
  if (action.kind === "CASE_ALREADY_ACTIVE") {
    return language === "ru"
      ? "Автоматизация уже активна. Я ничего не менял."
      : "Automatizácia už je aktívna. Nič som nemenil.";
  }
  if (action.kind === "CASE_MARKED_PAID") {
    return language === "ru"
      ? "Готово, я отметил дело как оплаченное и закрыл автоматизацию по этому кейсу."
      : "Hotovo, prípad som označil ako uhradený a uzavrel som jeho automatizáciu.";
  }
  if (action.kind === "CASE_CANCELLED") {
    return language === "ru"
      ? "Готово, я остановил дело. Дальнейшие автоматические письма и проверки по нему не будут запускаться."
      : "Hotovo, prípad som zastavil. Ďalšie automatické emaily a kontroly sa preň nebudú spúšťať.";
  }
  if (action.kind === "CASE_ALREADY_CANCELLED") {
    return language === "ru"
      ? "Дело уже было остановлено раньше. Я ничего не менял."
      : "Prípad už bol zastavený skôr. Nič som nemenil.";
  }
  if (action.kind === "INSTALLMENT_PROPOSAL_SENT") {
    return language === "ru"
      ? "Готово, я отправил должнику стандартный план рассрочки из трёх платежей. Ответ должника будет привязан к этому делу."
      : "Hotovo, dlžníkovi som odoslal štandardný splátkový kalendár s tromi platbami. Jeho odpoveď sa priradí k tomuto prípadu.";
  }
  if (action.kind === "INSTALLMENT_PROPOSAL_ALREADY_EXISTS") {
    return language === "ru"
      ? "По этому делу уже есть подготовленный или активный план рассрочки. Я не создавал второй план."
      : "Pri tomto prípade už existuje pripravený alebo aktívny splátkový kalendár. Druhý plán som nevytváral.";
  }
  if (action.kind === "DEBTOR_MESSAGE_SENT") {
    return language === "ru"
      ? "Готово, я отправил должнику сообщение и записал его в коммуникацию по делу. Если должник ответит на адрес из письма, ответ попадёт в этот case."
      : "Hotovo, správu som odoslal dlžníkovi a zapísal ju do komunikácie prípadu. Ak dlžník odpovie na adresu z emailu, odpoveď sa priradí k tomuto prípadu.";
  }
  if (action.kind === "FINAL_NOTICE_SENT") {
    return language === "ru"
      ? "Готово, я отправил должнику утверждённое финальное уведомление. В нём нет произвольной угрозы: должнику сообщается, что кредитор оставляет за собой право рассмотреть дальнейшее взыскание, включая судебное, и предлагается подтвердить, является ли отказ от оплаты окончательным. Дело переведено в статус финального уведомления."
      : "Hotovo, dlžníkovi som odoslal schválenú poslednú výzvu. Nie je to voľná právna hrozba: dlžníkovi oznamuje, že veriteľ si vyhradzuje právo zvážiť ďalšie vymáhanie vrátane súdneho uplatnenia, a žiada potvrdiť, či je odmietnutie úhrady konečné. Prípad je v stave poslednej výzvy.";
  }
  if (action.kind === "FINAL_NOTICE_ALREADY_SENT") {
    return language === "ru"
      ? "Финальное уведомление по этому делу уже было отправлено. Я не отправлял его повторно."
      : "Posledná výzva už bola pri tomto prípade odoslaná. Neposielal som ju znova.";
  }
  if (action.kind === "ACTION_BLOCKED") {
    return blockedActionReply(action.reason, collectionCase, language);
  }
  return language === "ru"
    ? "Я обработал команду, но отдельное действие выполнять не потребовалось."
    : "Pokyn som spracoval, ale nebolo potrebné vykonať samostatnú akciu.";
}

function blockedActionReply(
  reason: string,
  collectionCase: DashboardCase,
  language: "sk" | "ru"
): string {
  const status = readableStatus(collectionCase.status, language);
  const missing = missingRequiredFields(collectionCase, language);
  if (language === "ru") {
    return [
      `Я не выполнил это действие автоматически: ${reason}`,
      "",
      missing.length > 0
        ? `Что нужно исправить: заполните ${missing.join(", ")} в блоке данных фактуры, затем снова попросите меня запустить дело.`
        : `Текущий статус дела: ${status}. Если действие недоступно из-за статуса, измените его через кнопки в dashboard или выберите другой сценарий в чате.`,
      "Я могу подсказать следующий безопасный шаг, если напишете: “что можно сделать дальше?”"
    ].join("\n");
  }
  return [
    `Túto akciu som automaticky nevykonal: ${reason}`,
    "",
    missing.length > 0
      ? `Čo treba opraviť: doplňte ${missing.join(", ")} v údajoch faktúry a potom ma znova požiadajte o spustenie prípadu.`
      : `Aktuálny stav prípadu: ${status}. Ak je akcia blokovaná stavom, použite tlačidlá v dashboarde alebo zvoľte iný scenár v chate.`,
    "Ak chcete, napíšte „čo môžeme urobiť ďalej?“ a navrhnem bezpečný ďalší krok."
  ].join("\n");
}

function missingRequiredFields(
  collectionCase: DashboardCase,
  language: "sk" | "ru"
): string[] {
  const fields: string[] = [];
  if (!collectionCase.invoiceNumber) fields.push(readableField("invoiceNumber", language));
  if (!collectionCase.dueDate) fields.push(readableField("dueDate", language));
  if (collectionCase.amountTotal === null) fields.push(readableField("amountTotal", language));
  if (!collectionCase.debtorName) fields.push(readableField("debtorName", language));
  return fields;
}

function buildCaseSummaryForChat(
  collectionCase: DashboardCase,
  language: "sk" | "ru"
): string {
  const amount =
    collectionCase.amountTotal !== null
      ? formatMoney(collectionCase.amountTotal, collectionCase.currency, language)
      : language === "ru"
        ? "не указана"
        : "nezadaná";
  const dueDate = collectionCase.dueDate
    ? formatDate(collectionCase.dueDate, language)
    : language === "ru"
      ? "не указана"
      : "nezadaná";
  const recent = summarizeEventsForChat(collectionCase.events, language);

  if (language === "ru") {
    return [
      `Сейчас дело ${readableStatus(collectionCase.status, "ru").toLowerCase()}.`,
      "",
      `Фактура: ${collectionCase.invoiceNumber ?? "не указана"}`,
      `Должник: ${collectionCase.debtorName ?? "не указан"}`,
      `Сумма: ${amount}`,
      `Срок оплаты: ${dueDate}`,
      "",
      recent.length > 0
        ? ["Что происходило недавно:", ...recent.map((item) => `- ${item}`)].join("\n")
        : "В истории пока нет значимых действий.",
      "",
      nextStepText(collectionCase, "ru")
    ].join("\n");
  }

  return [
    `Prípad je teraz v stave: ${readableStatus(collectionCase.status, "sk").toLowerCase()}.`,
    "",
    `Faktúra: ${collectionCase.invoiceNumber ?? "nezadaná"}`,
    `Dlžník: ${collectionCase.debtorName ?? "nezadaný"}`,
    `Suma: ${amount}`,
    `Splatnosť: ${dueDate}`,
    "",
    recent.length > 0
      ? ["Čo sa stalo naposledy:", ...recent.map((item) => `- ${item}`)].join("\n")
      : "V histórii zatiaľ nie sú významné kroky.",
    "",
    nextStepText(collectionCase, "sk")
  ].join("\n");
}

function summarizeEventsForChat(
  events: DashboardEvent[],
  language: "sk" | "ru"
): string[] {
  return events
    .filter((event) => !isAssistantSelfEvent(event))
    .slice(0, 6)
    .map((event) => humanEvent(event, language));
}

function isAssistantSelfEvent(event: DashboardEvent): boolean {
  const note = event.note?.toLowerCase() ?? "";
  return note.startsWith("customer asks") || note.includes("dashboard assistant");
}

function humanEvent(event: DashboardEvent, language: "sk" | "ru"): string {
  const date = formatDateTime(event.createdAt, language);
  const note = event.note ?? event.type;
  const lower = note.toLowerCase();
  let text: string;

  if (lower.includes("collection workflow completed")) {
    text = language === "ru" ? "автоматизация была завершена" : "automatizácia bola ukončená";
  } else if (lower.includes("manuálne zastavené") || lower.includes("manually stopped")) {
    text = language === "ru" ? "дело было вручную остановлено" : "prípad bol manuálne zastavený";
  } else if (lower.includes("debtor requests payment") || lower.includes("installment")) {
    text =
      language === "ru"
        ? "должник просил рассрочку или другие условия оплаты"
        : "dlžník žiadal splátky alebo iné platobné podmienky";
  } else if (event.type === "EMAIL_SENT") {
    text = language === "ru" ? "система отправила письмо" : "systém odoslal email";
  } else if (event.type === "EMAIL_RECEIVED") {
    text = language === "ru" ? "получено входящее письмо" : "prišiel email";
  } else if (event.type === "DEBTOR_REPLY_CLASSIFIED") {
    text = language === "ru" ? "ответ должника был проанализирован" : "odpoveď dlžníka bola vyhodnotená";
  } else if (event.type === "AUTOMATION_PAUSED") {
    text = language === "ru" ? "автоматизация была приостановлена" : "automatizácia bola pozastavená";
  } else if (event.type === "STATUS_CHANGED") {
    text = language === "ru" ? "статус дела был изменён" : "stav prípadu bol zmenený";
  } else {
    text = cleanupEventNote(note);
  }

  return `${date}: ${text}.`;
}

function cleanupEventNote(value: string): string {
  return value
    .replace(/\bCLOSED_CANCELLED\b/gu, "zastavené")
    .replace(/\bCLOSED_PAID\b/gu, "uhradené")
    .replace(/\bINSTALLMENT_REQUEST\b/gu, "žiadosť o splátky")
    .replace(/\bINSTALLMENT_ACCEPTED\b/gu, "splátky prijaté");
}

function nextStepText(collectionCase: DashboardCase, language: "sk" | "ru"): string {
  if (collectionCase.status === "CLOSED_CANCELLED") {
    return language === "ru"
      ? "Следующий автоматический шаг не запланирован, потому что дело остановлено."
      : "Ďalší automatický krok nie je naplánovaný, pretože prípad je zastavený.";
  }
  if (collectionCase.status === "CLOSED_PAID") {
    return language === "ru"
      ? "Дело закрыто как оплаченное."
      : "Prípad je uzavretý ako uhradený.";
  }
  if (collectionCase.automationPausedAt) {
    return language === "ru"
      ? "Автоматизация сейчас приостановлена. Можно спросить меня, что нужно решить дальше."
      : "Automatizácia je teraz pozastavená. Môžete sa ma opýtať, čo treba rozhodnúť ďalej.";
  }
  if (collectionCase.nextActionAt) {
    return language === "ru"
      ? `Следующий автоматический шаг запланирован на ${formatDate(collectionCase.nextActionAt, "ru")}.`
      : `Ďalší automatický krok je naplánovaný na ${formatDate(collectionCase.nextActionAt, "sk")}.`;
  }
  return language === "ru"
    ? "Сейчас нет запланированного автоматического шага. Можно попросить меня объяснить варианты действий."
    : "Momentálne nie je naplánovaný automatický krok. Môžete ma požiadať o návrh ďalšieho postupu.";
}

function asksCapabilities(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "что ты можешь",
    "что ты умеешь",
    "что умеешь",
    "что можешь",
    "что ты умеешь делать",
    "что ты можешь делать",
    "как ты можешь",
    "what can you do",
    "čo vieš",
    "co vies",
    "čo môžeš",
    "co mozes",
    "ako mi vieš pomôcť",
    "ako mi vies pomoct"
  ].some((phrase) => normalized.includes(phrase));
}

function detectMessageLanguage(message: string): "sk" | "ru" {
  return /[а-яё]/iu.test(message) ? "ru" : "sk";
}

function readableStatus(status: string, language: "sk" | "ru"): string {
  const labels: Record<string, { sk: string; ru: string }> = {
    RECEIVED: { sk: "prijaté", ru: "получено" },
    PARSED: { sk: "načítané", ru: "распознано" },
    MANUAL_REVIEW_REQUIRED: { sk: "vyžaduje kontrolu", ru: "требует проверки" },
    WAITING_FOR_DUE_DATE: { sk: "čaká na splatnosť", ru: "ожидает срока оплаты" },
    OVERDUE: { sk: "po splatnosti", ru: "просрочено" },
    EMAIL_REMINDER_1_SENT: { sk: "odoslaná prvá pripomienka", ru: "первая напоминалка отправлена" },
    EMAIL_REMINDER_2_SENT: { sk: "odoslaná druhá pripomienka", ru: "вторая напоминалка отправлена" },
    PAYMENT_PROMISED: { sk: "dlžník prisľúbil platbu", ru: "должник обещал оплату" },
    INSTALLMENT_PLAN_SENT: { sk: "splátkový kalendár bol odoslaný", ru: "план рассрочки отправлен" },
    INSTALLMENT_ACTIVE: { sk: "splátkový kalendár je aktívny", ru: "рассрочка активна" },
    INSTALLMENT_BROKEN: { sk: "splátkový kalendár je porušený", ru: "рассрочка нарушена" },
    CLOSED_PAID: { sk: "uzavreté ako uhradené", ru: "закрыто как оплаченное" },
    CLOSED_CANCELLED: { sk: "zastavené", ru: "остановлено" },
    CLOSED_UNRESOLVED: { sk: "uzavreté bez vyriešenia", ru: "закрыто без решения" }
  };
  return labels[status]?.[language] ?? status.toLowerCase().replace(/_/gu, " ");
}

function readableField(field: string, language: "sk" | "ru"): string {
  const labels: Record<string, { sk: string; ru: string }> = {
    invoiceNumber: { sk: "číslo faktúry", ru: "номер фактуры" },
    dueDate: { sk: "dátum splatnosti", ru: "срок оплаты" },
    amountTotal: { sk: "suma", ru: "сумма" },
    debtorName: { sk: "odberateľ", ru: "должник" },
    debtorEmail: { sk: "email dlžníka", ru: "email должника" },
    iban: { sk: "IBAN", ru: "IBAN" },
    variableSymbol: { sk: "variabilný symbol", ru: "вариабельный символ" }
  };
  return labels[field]?.[language] ?? field;
}

function normalizeEmailTemplateForChat(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return value
    .replace(/^Dobrý deň,\s*/u, "")
    .replace(/^ďakujeme za odpoveď\. Informácie sme zaevidovali k prípadu\.\s*/iu, "")
    .replace(/\n?Aktualizované údaje sú pripravené na kontrolu v aplikácii\.\s*/iu, "")
    .replace(/\n?Ďakujeme\.\s*$/u, "")
    .replace(/Prípad v dashboarde: .+/gu, "")
    .trim() || fallback;
}

function formatMoney(amount: number, currency: string | null, language: "sk" | "ru"): string {
  const formatted = new Intl.NumberFormat(language === "ru" ? "ru-RU" : "sk-SK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
  return `${formatted} ${currency === "EUR" || !currency ? "€" : currency}`;
}

function formatDate(value: string, language: "sk" | "ru"): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "sk-SK", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(value));
}

function formatDateTime(value: string, language: "sk" | "ru"): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "sk-SK", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Bratislava"
  }).format(new Date(value));
}
