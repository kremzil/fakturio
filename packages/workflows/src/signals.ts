import { defineSignal } from "@temporalio/workflow";
import type {
  CaseStatus,
  CaseWorkflowCommand
} from "@fakturio/shared";

export const CASE_STATE_CHANGED_COMMAND = "CASE_STATE_CHANGED" as const;

export type LegacyCaseStateChangedSignalPayload = {
  commandId: string;
  status: CaseStatus;
};

export const legacyCaseStateChangedSignal =
  defineSignal<[LegacyCaseStateChangedSignalPayload]>("caseStateChanged");

export const caseCommandSignal =
  defineSignal<[CaseWorkflowCommand]>("caseCommand");

export const caseStateChangedSignal = caseCommandSignal;
