// Worker process: queues and schedules for collection, processing, events, reports and ops, and the site's
// modules (site/modules/server.ts).
import { assertProductionSecrets } from "@tongxing/backend/config";
import { closeDb } from "@tongxing/backend/db";
import { getBoss, stopBoss, workModuleQueues } from "@tongxing/backend/jobs/queue";
import { installModules } from "@tongxing/backend/modules";
import { SERVER_MODULES } from "@tongxing/site/modules/server";
import { registerContentJobs } from "@tongxing/backend/jobs/content";
import { registerSourceJobs } from "@tongxing/backend/jobs/sources";
import { registerEventJobs } from "@tongxing/backend/jobs/events";
import { registerNotifyJobs } from "@tongxing/backend/jobs/notify";
import { registerPublicationJobs } from "@tongxing/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@tongxing/backend/notify/deliver";
import { startHeartbeat } from "@tongxing/backend/operations/heartbeat";

installModules(SERVER_MODULES);
assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

await ensureContentTargets();
const boss = await getBoss();
await registerContentJobs(boss);
if (process.env.COLLECT_ENABLED === "true") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerNotifyJobs(boss);
await registerPublicationJobs(boss);
await workModuleQueues(boss);
await registerSchedules(boss);
const heartbeat = startHeartbeat("worker");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
