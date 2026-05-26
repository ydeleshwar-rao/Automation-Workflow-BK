/** ServiceM8 diary event (jobactivity) helpers — pure functions for workflow actions. */

const SM8_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function formatServiceM8DateTime(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    throw new Error("Date format must be YYYY-MM-DD HH:MM:SS");
  }
  if (SM8_DATETIME_RE.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Date format must be YYYY-MM-DD HH:MM:SS");
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())}`;
}

export function toActivityWasScheduledFlag(value: unknown): string {
  if (value === undefined || value === null || value === "") return "1";
  if (value === true || value === "true" || value === 1 || value === "1") return "1";
  return "0";
}

export type DiaryEventInput = {
  job_uuid?: unknown;
  staff_uuid?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  activity_was_scheduled?: unknown;
};

export function buildDiaryEventPayload(input: DiaryEventInput): Record<string, string | number> {
  const jobUuid = String(input.job_uuid ?? "").trim();
  const staffUuid = String(input.staff_uuid ?? "").trim();

  if (!jobUuid) {
    throw new Error("[Action:service_m8:create_diary_event] required field 'job_uuid' is empty");
  }
  if (!staffUuid) {
    throw new Error("[Action:service_m8:create_diary_event] required field 'staff_uuid' is empty");
  }
  if (!input.start_date || !String(input.start_date).trim()) {
    throw new Error("[Action:service_m8:create_diary_event] required field 'start_date' is empty");
  }
  if (!input.end_date || !String(input.end_date).trim()) {
    throw new Error("[Action:service_m8:create_diary_event] required field 'end_date' is empty");
  }

  return {
    job_uuid: jobUuid,
    staff_uuid: staffUuid,
    start_date: formatServiceM8DateTime(String(input.start_date)),
    end_date: formatServiceM8DateTime(String(input.end_date)),
    activity_was_scheduled: toActivityWasScheduledFlag(input.activity_was_scheduled),
    active: 1,
  };
}

export function mapServiceM8DiaryEventHttpError(
  status: number,
  body: unknown
): Error {
  const data = body as Record<string, unknown> | null | undefined;
  const description = String(
    data?.error_description ?? data?.message ?? data?.error ?? ""
  ).toLowerCase();

  if (status === 403 || description.includes("scope") || description.includes("permission")) {
    return new Error(
      "Reconnect ServiceM8 — missing manage_schedule permission"
    );
  }

  if (status === 400) {
    if (
      description.includes("date") ||
      description.includes("time") ||
      description.includes("format")
    ) {
      return new Error("Date format must be YYYY-MM-DD HH:MM:SS");
    }
    return new Error("Job or staff UUID is invalid");
  }

  if (status === 401) {
    return new Error("ServiceM8 authentication failed — please reconnect");
  }

  return new Error(
    String(data?.error_description ?? data?.message ?? `ServiceM8 request failed (${status})`)
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
