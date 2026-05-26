/**
 * Integration smoke test — creates a real ServiceM8 jobactivity (diary event).
 *
 * Requires:
 *   SERVICEM8_DIARY_EVENT_SMOKE_TEST=1
 *   SERVICEM8_SMOKE_USER_ID=<user with valid OAuth>
 *   SERVICEM8_SMOKE_JOB_UUID=<existing job uuid>
 *   SERVICEM8_SMOKE_STAFF_UUID=<active staff uuid>
 */
import "../src/config/env.config.js";
import { ServiceM8Service } from "../src/modules/initgrations/serviceM8/service/serviceM8.service.js";
import { buildDiaryEventPayload } from "../src/modules/initgrations/serviceM8/utils/serviceM8DiaryEvent.util.js";

if (process.env.SERVICEM8_DIARY_EVENT_SMOKE_TEST !== "1") {
  console.log("Skipped — set SERVICEM8_DIARY_EVENT_SMOKE_TEST=1 to run.");
  process.exit(0);
}

const userId = process.env.SERVICEM8_SMOKE_USER_ID;
const jobUuid = process.env.SERVICEM8_SMOKE_JOB_UUID;
const staffUuid = process.env.SERVICEM8_SMOKE_STAFF_UUID;

if (!userId || !jobUuid || !staffUuid) {
  console.error(
    "Missing SERVICEM8_SMOKE_USER_ID, SERVICEM8_SMOKE_JOB_UUID, or SERVICEM8_SMOKE_STAFF_UUID"
  );
  process.exit(1);
}

const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
start.setUTCMinutes(0, 0, 0);
const end = new Date(start.getTime() + 60 * 60 * 1000);

const payload = buildDiaryEventPayload({
  job_uuid: jobUuid,
  staff_uuid: staffUuid,
  start_date: start.toISOString(),
  end_date: end.toISOString(),
  activity_was_scheduled: true,
});

console.log("[Smoke] POST jobactivity.json", payload);

const result = await ServiceM8Service.createDiaryEvent(userId, payload);
console.log("[Smoke] Success — jobactivity_uuid:", result.uuid ?? "(none in response)");
