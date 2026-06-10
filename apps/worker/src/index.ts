import { NativeConnection, Worker } from "@temporalio/worker";
import { Client, Connection } from "@temporalio/client";
import { fileURLToPath } from "node:url";
import { CASE_TASK_QUEUE } from "@fakturio/workflows";
import { requirePaymentCheckTokenSecret } from "@fakturio/shared";
import { activities } from "./activities";
import { startPendingCaseWorkflows } from "./workflow-starter";
import { dispatchPendingWorkflowCommands } from "./workflow-command-dispatcher";

// Fail fast at boot rather than only when the first payment-check email is sent on a due date.
// In production this throws if PAYMENT_CHECK_TOKEN_SECRET is missing/too short.
requirePaymentCheckTokenSecret();

const temporalAddress = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || CASE_TASK_QUEUE;

const connection = await NativeConnection.connect({ address: temporalAddress });
const clientConnection = await Connection.connect({ address: temporalAddress });
const client = new Client({
  connection: clientConnection,
  namespace: process.env.TEMPORAL_NAMESPACE || "default"
});

const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE || "default",
  taskQueue,
  workflowsPath: fileURLToPath(new URL("../../../packages/workflows/src/workflows.ts", import.meta.url)),
  activities
});

console.log(`FAKTURIO worker listening on ${temporalAddress}, task queue ${taskQueue}`);
void runWorkflowDispatchCycle();
setInterval(() => {
  void runWorkflowDispatchCycle();
}, 15_000);
await worker.run();

async function runWorkflowDispatchCycle(): Promise<void> {
  try {
    await startPendingCaseWorkflows({ client, taskQueue });
    await dispatchPendingWorkflowCommands(client, taskQueue);
  } catch (error) {
    console.error("Workflow dispatch cycle failed.", error);
  }
}
