import { defineSignal } from "@temporalio/workflow";
import type { CaseStatus } from "@fakturio/shared";

export const CASE_STATE_CHANGED_COMMAND = "CASE_STATE_CHANGED" as const;

export type CaseStateChangedSignalPayload = {
  commandId: string;
  status: CaseStatus;
};

export const caseStateChangedSignal =
  defineSignal<[CaseStateChangedSignalPayload]>("caseStateChanged");
