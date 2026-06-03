import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { CASE_TASK_QUEUE } from "@fakturio/workflows";
import { activities } from "./activities";
import { startPendingCaseWorkflows } from "./workflow-starter";

const temporalAddress = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE || CASE_TASK_QUEUE;

const connection = await NativeConnection.connect({ address: temporalAddress });

const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE || "default",
  taskQueue,
  workflowsPath: fileURLToPath(new URL("../../../packages/workflows/src/workflows.ts", import.meta.url)),
  activities
});

console.log(`FAKTURIO worker listening on ${temporalAddress}, task queue ${taskQueue}`);
void startPendingCaseWorkflows({
  temporalAddress,
  namespace: process.env.TEMPORAL_NAMESPACE || "default",
  taskQueue
});
setInterval(() => {
  void startPendingCaseWorkflows({
    temporalAddress,
    namespace: process.env.TEMPORAL_NAMESPACE || "default",
    taskQueue
  });
}, 15_000);
await worker.run();
