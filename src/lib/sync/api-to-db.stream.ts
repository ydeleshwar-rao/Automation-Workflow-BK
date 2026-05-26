/**
 * Stream-based API → Supabase sync with checkpoint / auto-heal / dedup.
 *
 * Three-layer optimization to avoid unnecessary DB writes:
 *
 * Layer 1 — Sync cooldown (queue level)
 *   If a full sync completed < cooldown_minutes ago, new sync is blocked.
 *   Prevents button-mashing from hammering the API + DB.
 *
 * Layer 2 — Row hash dedup (stream level)
 *   Every incoming row is hashed (MD5 of JSON). Before upserting a chunk,
 *   existing hashes are fetched from DB in one batch SELECT.
 *   Only rows where the hash differs (or is new) are upserted.
 *   Unchanged rows are skipped entirely — zero DB writes for them.
 *
 * Layer 3 — Incremental date filter (caller level)
 *   Callers pass last_synced_at to the API so only new/modified records
 *   are fetched. Requires API support (Commusoft: jobCreatedStartDate).
 *
 * Backpressure
 *   Node.js object-mode streams pause the Readable automatically when the
 *   Writable is busy — memory stays flat regardless of total record count.
 *
 * Multiple users
 *   Each syncViaStream() call is independent — separate pipeline, separate
 *   checkpoint row (user_id + integration + entity).
 */

import { createHash } from "node:crypto";
import { Readable, Transform, Writable, pipeline } from "node:stream";
import { promisify } from "node:util";
import { supabase } from "../../config/db.config.js";

const pipelineAsync = promisify(pipeline);

// ─── Types ────────────────────────────────────────────────────────────────────

export type FetchPage<T> = (page: {
  startingRecord: number;
  pageSize: number;
  pageNumber: number;
}) => Promise<T[]>;

export type NormaliseRow<T> = (raw: T, userId: string) => Record<string, unknown>;

export interface SyncStreamOptions<T> {
  userId: string;
  integration: string;
  entity: string;
  table: string;
  onConflict: string;
  /** Column used as the record's primary key for hash lookup. Default: "id" */
  pkColumn?: string;
  pageSize?: number;
  delayBetweenPages?: number;
  chunkSize?: number;
  /** Skip hash dedup — use only for tables with no _sync_hash column yet */
  disableHashDedup?: boolean;
  fetchPage: FetchPage<T>;
  normalise?: NormaliseRow<T>;
  onProgress?: (info: { page: number; synced: number; skipped: number }) => void;
}

export interface SyncStreamResult {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  durationMs: number;
  resumed: boolean;
}

// ─── Row hash ─────────────────────────────────────────────────────────────────

/**
 * MD5 of the row JSON (excluding _sync_hash itself and user_id).
 * Fast enough for tens-of-thousands of rows; not used for security.
 */
function rowHash(row: Record<string, unknown>): string {
  const { _sync_hash: _h, user_id: _u, ...data } = row;
  return createHash("md5").update(JSON.stringify(data)).digest("hex");
}

/**
 * Fetch existing hashes from DB for a batch of pk values.
 * Returns Map<pkValue, hash>.
 */
async function fetchExistingHashes(
  table: string,
  pkColumn: string,
  userId: string,
  pkValues: string[]
): Promise<Map<string, string>> {
  if (!pkValues.length) return new Map();

  // Split into batches of 100 — 500 UUID PKs in a GET query string exceeds
  // PostgREST/nginx's ~8KB URL limit and results in "TypeError: fetch failed".
  const BATCH = 100;
  const map = new Map<string, string>();

  for (let i = 0; i < pkValues.length; i += BATCH) {
    const batch = pkValues.slice(i, i + BATCH);

    const { data, error } = await supabase
      .from(table)
      .select(`${pkColumn}, _sync_hash`)
      .eq("user_id", userId)
      .in(pkColumn, batch);

    if (error) {
      // Non-fatal: return whatever we collected so far; missing entries will be upserted
      console.warn(`[SYNC:stream] hash lookup failed for ${table}:`, error.message);
      return map;
    }

    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      const pk   = String(row[pkColumn]     ?? "");
      const hash = String(row["_sync_hash"] ?? "");
      if (pk && hash) map.set(pk, hash);
    }
  }

  return map;
}

// ─── Checkpoint helpers ───────────────────────────────────────────────────────

export interface CheckpointRow {
  lastPage: number;
  recordsSynced: number;
  lastSyncedAt: string | null;
  cooldownMinutes: number;
}

export async function readCheckpoint(
  userId: string,
  integration: string,
  entity: string
): Promise<CheckpointRow | null> {
  const { data } = await supabase
    .from("sync_checkpoints")
    .select("last_page, records_synced, status, last_synced_at, cooldown_minutes")
    .eq("user_id", userId)
    .eq("integration", integration)
    .eq("entity", entity)
    .maybeSingle();

  if (!data) return null;
  if (data.status === "completed") {
    // Return completed row so caller can check cooldown
    return {
      lastPage: 0,
      recordsSynced: data.records_synced,
      lastSyncedAt: data.last_synced_at,
      cooldownMinutes: data.cooldown_minutes ?? 15,
    };
  }
  return {
    lastPage: data.last_page,
    recordsSynced: data.records_synced,
    lastSyncedAt: data.last_synced_at,
    cooldownMinutes: data.cooldown_minutes ?? 15,
  };
}

/**
 * True if the last completed sync finished within cooldown_minutes.
 * Returns { blocked: true, remainingMs } when inside cooldown window.
 */
export async function isSyncOnCooldown(
  userId: string,
  integration: string,
  entity: string
): Promise<{ blocked: false } | { blocked: true; remainingMs: number; lastSyncedAt: string }> {
  const { data } = await supabase
    .from("sync_checkpoints")
    .select("status, last_synced_at, cooldown_minutes")
    .eq("user_id", userId)
    .eq("integration", integration)
    .eq("entity", entity)
    .maybeSingle();

  if (!data || data.status !== "completed" || !data.last_synced_at) {
    return { blocked: false };
  }

  const cooldownMs = (data.cooldown_minutes ?? 15) * 60 * 1000;
  const elapsedMs = Date.now() - new Date(data.last_synced_at).getTime();

  if (elapsedMs < cooldownMs) {
    return {
      blocked: true,
      remainingMs: cooldownMs - elapsedMs,
      lastSyncedAt: data.last_synced_at,
    };
  }

  return { blocked: false };
}

async function upsertCheckpoint(
  userId: string,
  integration: string,
  entity: string,
  lastPage: number,
  recordsSynced: number,
  status: "running" | "completed" | "failed",
  errorMessage?: string
) {
  const now = new Date().toISOString();
  await supabase.from("sync_checkpoints").upsert(
    {
      user_id: userId,
      integration,
      entity,
      status,
      last_page: lastPage,
      records_synced: recordsSynced,
      error_message: errorMessage ?? null,
      finished_at: status !== "running" ? now : null,
      last_synced_at: status === "completed" ? now : undefined,
    },
    { onConflict: "user_id,integration,entity" }
  );
}

// ─── Readable: paginated API fetcher ─────────────────────────────────────────

function createApiReadable<T>(
  fetchPage: FetchPage<T>,
  pageSize: number,
  delayMs: number,
  startPage: number
): Readable {
  let pageNumber = startPage;
  let done = false;

  return new Readable({
    objectMode: true,
    async read() {
      if (done) { this.push(null); return; }

      const startingRecord = (pageNumber - 1) * pageSize + 1;
      try {
        const batch = await fetchPage({ startingRecord, pageSize, pageNumber });

        if (batch.length === 0) { done = true; this.push(null); return; }

        for (const record of batch) this.push(record);

        if (batch.length < pageSize) { done = true; this.push(null); return; }

        pageNumber++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });
}

// ─── Transform: normalise + hash ─────────────────────────────────────────────

function createNormaliseTransform<T>(
  userId: string,
  normalise?: NormaliseRow<T>
): Transform {
  return new Transform({
    objectMode: true,
    transform(raw: T, _enc, cb) {
      try {
        const row = normalise
          ? normalise(raw, userId)
          : { ...(raw as any), user_id: userId };

        // Attach hash — this is what dedup compares against stored value
        row._sync_hash = rowHash(row);

        cb(null, row);
      } catch (err) { cb(err as Error); }
    },
  });
}

// ─── Writable: hash dedup → selective upsert → checkpoint ────────────────────

function createSupabaseWritable(
  table: string,
  onConflict: string,
  pkColumn: string,
  chunkSize: number,
  disableHashDedup: boolean,
  userId: string,
  integration: string,
  entity: string,
  startRecordsSynced: number,
  startPage: number,
  pageSize: number,
  onProgress?: (info: { page: number; synced: number; skipped: number }) => void
): Writable & { getStats: () => { synced: number; skipped: number; failed: number } } {
  let buffer: Record<string, unknown>[] = [];
  let synced   = startRecordsSynced;
  let skipped  = 0;
  let failed   = 0;
  let rowsInCurrentPage = 0;
  let currentPage = startPage;

  const flush = async (rows: Record<string, unknown>[]) => {
    if (!rows.length) return;

    let toUpsert = rows;

    // ── Layer 2: Hash dedup ────────────────────────────────────────────────────
    if (!disableHashDedup) {
      const pkValues = rows
        .map((r) => String(r[pkColumn] ?? ""))
        .filter(Boolean);

      const existingHashes = await fetchExistingHashes(table, pkColumn, userId, pkValues);

      toUpsert = rows.filter((row) => {
        const pk   = String(row[pkColumn] ?? "");
        const hash = String(row._sync_hash ?? "");
        const stored = existingHashes.get(pk);

        if (!stored) return true;         // new record — include
        if (stored !== hash) return true; // changed record — include
        skipped++;                        // unchanged — skip DB write
        return false;
      });
    }

    if (!toUpsert.length) {
      // Entire chunk unchanged — still advance checkpoint counter
      rowsInCurrentPage += rows.length;
      if (rowsInCurrentPage >= pageSize) {
        rowsInCurrentPage = 0;
        currentPage++;
        await upsertCheckpoint(userId, integration, entity, currentPage, synced, "running");
      }
      onProgress?.({ page: currentPage, synced, skipped });
      return;
    }

    const { data, error } = await supabase
      .from(table)
      .upsert(toUpsert, { onConflict })
      .select("id");

    if (error) {
      console.error(`[SYNC:stream:${table}] upsert error:`, error.message);
      failed += toUpsert.length;
    } else {
      synced += data?.length ?? toUpsert.length;

      rowsInCurrentPage += rows.length;
      if (rowsInCurrentPage >= pageSize) {
        rowsInCurrentPage = 0;
        currentPage++;
        await upsertCheckpoint(userId, integration, entity, currentPage, synced, "running");
      }
      onProgress?.({ page: currentPage, synced, skipped });
    }
  };

  const writable = new Writable({
    objectMode: true,
    async write(row: Record<string, unknown>, _enc, cb) {
      buffer.push(row);
      if (buffer.length >= chunkSize) {
        const chunk = buffer.splice(0, chunkSize);
        try { await flush(chunk); cb(); }
        catch (err) { cb(err as Error); }
      } else { cb(); }
    },
    async final(cb) {
      try {
        if (buffer.length) { await flush(buffer); buffer = []; }
        cb();
      } catch (err) { cb(err as Error); }
    },
  });

  (writable as any).getStats = () => ({ synced, skipped, failed });
  return writable as Writable & { getStats: () => { synced: number; skipped: number; failed: number } };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function syncViaStream<T>(
  options: SyncStreamOptions<T>
): Promise<SyncStreamResult> {
  const {
    userId,
    integration,
    entity,
    table,
    onConflict,
    pkColumn        = "id",
    pageSize        = 300,
    delayBetweenPages = 100,
    chunkSize       = 500,
    disableHashDedup = false,
    fetchPage,
    normalise,
    onProgress,
  } = options;

  const startMs = Date.now();

  // ── Resume check ─────────────────────────────────────────────────────────────
  const existing = await readCheckpoint(userId, integration, entity);
  // If previous run was "running" or "failed" → resume from last_page
  // If "completed" or null → fresh start (page 1)
  const isIncomplete = existing && existing.lastPage > 0;
  const startPage           = isIncomplete ? Math.max(1, existing!.lastPage) : 1;
  const startRecordsSynced  = isIncomplete ? existing!.recordsSynced : 0;
  const resumed             = startPage > 1;

  if (resumed) {
    console.log(
      `[SYNC:stream:${entity}] ♻ resuming from page=${startPage} already_synced=${startRecordsSynced}`
    );
  }

  await upsertCheckpoint(userId, integration, entity, startPage, startRecordsSynced, "running");

  let total = 0;

  const readable  = createApiReadable(fetchPage, pageSize, delayBetweenPages, startPage);
  const transform = createNormaliseTransform(userId, normalise);
  const writable  = createSupabaseWritable(
    table, onConflict, pkColumn, chunkSize, disableHashDedup,
    userId, integration, entity,
    startRecordsSynced, startPage, pageSize,
    onProgress
  );

  const counter = new Transform({
    objectMode: true,
    transform(row, _enc, cb) { total++; cb(null, row); },
  });

  console.log(
    `[SYNC:stream:${entity}] ▶ start user=${userId} page=${startPage} hashDedup=${!disableHashDedup}`
  );

  try {
    await pipelineAsync(readable, transform, counter, writable);

    const { synced, skipped, failed } = (writable as any).getStats();
    const durationMs = Date.now() - startMs;

    await upsertCheckpoint(userId, integration, entity, 0, synced, "completed");

    console.log(
      `[SYNC:stream:${entity}] ✅ done total=${total} synced=${synced} skipped=${skipped} failed=${failed} duration=${durationMs}ms`
    );

    return { total, synced, skipped, failed, durationMs, resumed };
  } catch (err: any) {
    const { synced } = (writable as any).getStats?.() ?? { synced: 0 };
    await upsertCheckpoint(userId, integration, entity, startPage, synced, "failed", err?.message ?? String(err));
    console.error(`[SYNC:stream:${entity}] ❌ failed:`, err?.message ?? err);
    throw err;
  }
}
