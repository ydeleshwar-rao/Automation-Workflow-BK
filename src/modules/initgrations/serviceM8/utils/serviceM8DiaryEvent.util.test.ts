import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiaryEventPayload,
  formatServiceM8DateTime,
  mapServiceM8DiaryEventHttpError,
  toActivityWasScheduledFlag,
} from "./serviceM8DiaryEvent.util.js";

describe("formatServiceM8DateTime", () => {
  it("passes through YYYY-MM-DD HH:MM:SS", () => {
    assert.equal(formatServiceM8DateTime("2026-05-25 09:00:00"), "2026-05-25 09:00:00");
  });

  it("converts ISO 8601 to ServiceM8 format", () => {
    assert.equal(
      formatServiceM8DateTime("2026-05-25T09:00:00Z"),
      "2026-05-25 09:00:00"
    );
  });

  it("throws on invalid date", () => {
    assert.throws(
      () => formatServiceM8DateTime("not-a-date"),
      /Date format must be YYYY-MM-DD HH:MM:SS/
    );
  });
});

describe("buildDiaryEventPayload", () => {
  it("happy path builds payload with defaults", () => {
    const payload = buildDiaryEventPayload({
      job_uuid: "job-uuid-1",
      staff_uuid: "staff-uuid-1",
      start_date: "2026-05-25T09:00:00Z",
      end_date: "2026-05-25T10:00:00Z",
    });

    assert.equal(payload.job_uuid, "job-uuid-1");
    assert.equal(payload.staff_uuid, "staff-uuid-1");
    assert.equal(payload.start_date, "2026-05-25 09:00:00");
    assert.equal(payload.end_date, "2026-05-25 10:00:00");
    assert.equal(payload.activity_was_scheduled, "1");
    assert.equal(payload.active, 1);
  });

  it("throws when job_uuid is missing", () => {
    assert.throws(
      () =>
        buildDiaryEventPayload({
          staff_uuid: "staff-1",
          start_date: "2026-05-25 09:00:00",
          end_date: "2026-05-25 10:00:00",
        }),
      /job_uuid/
    );
  });

  it("respects activity_was_scheduled false", () => {
    const payload = buildDiaryEventPayload({
      job_uuid: "j",
      staff_uuid: "s",
      start_date: "2026-05-25 09:00:00",
      end_date: "2026-05-25 10:00:00",
      activity_was_scheduled: false,
    });
    assert.equal(payload.activity_was_scheduled, "0");
  });
});

describe("toActivityWasScheduledFlag", () => {
  it("defaults to scheduled", () => {
    assert.equal(toActivityWasScheduledFlag(undefined), "1");
    assert.equal(toActivityWasScheduledFlag(true), "1");
    assert.equal(toActivityWasScheduledFlag(false), "0");
  });
});

describe("mapServiceM8DiaryEventHttpError", () => {
  it("maps 403 to reconnect message", () => {
    const err = mapServiceM8DiaryEventHttpError(403, {
      error: "insufficient_scope",
    });
    assert.match(err.message, /manage_schedule/);
  });

  it("maps 400 date errors", () => {
    const err = mapServiceM8DiaryEventHttpError(400, {
      error_description: "Invalid date format",
    });
    assert.match(err.message, /Date format/);
  });

  it("maps 400 uuid errors", () => {
    const err = mapServiceM8DiaryEventHttpError(400, {
      error_description: "Invalid uuid",
    });
    assert.match(err.message, /UUID is invalid/);
  });
});
