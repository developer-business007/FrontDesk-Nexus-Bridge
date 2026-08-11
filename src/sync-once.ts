import os from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BRIDGE_VERSION,
  PMS_ROOMTYPE_COUNTS_KEY,
  PMS_SYNC_STATE_KEY,
  PMS_SYNC_WARNINGS_KEY,
  SOURCE_DUALPMS_VPS,
} from "./constants.js";
import { runEzeeFallback } from "./fallback-ezee.js";
import { runSynxisFallback } from "./fallback-synxis.js";
import {
  mapDualPmsRoomToEzee,
  mapDualPmsRoomToSynxis,
  mergeRoomtypeTotals,
  postgresTimestampToIso,
} from "./map.js";
import { execLocalPsql, queryLocalJson, testLocalPostgres } from "./postgres.js";
import { probeSupabaseReachability } from "./network.js";
import {
  buildUpsertRow,
  createSupabaseClient,
  getSupabaseEnvForDiagnostics,
  loadActiveRoomNumbers,
  setAppSettingsValue,
  updateAppSettingsJson,
  upsertPmsRoomRows,
  writeBridgeHeartbeat,
} from "./supabase.js";
import type { DualPmsRoomRow, EzeeRoomSnapshot, SynxisRoomSnapshot, SyncWarning } from "./types.js";
import { summarizeEzeeSnapshots, summarizeSynxisSnapshots } from "./snapshot-stats.js";
import { evaluateUpstreamHealth } from "./upstream.js";

const ROOMS_SQL = `
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
FROM (
  SELECT
    room_no, room_type,
    synxis_housekeeping_status, synxis_ooo, synxis_occupancy,
    synxis_guest_name, synxis_check_in_date, synxis_check_out_date, synxis_folio_balance_in_cents,
    ezee_housekeeping_status, ezee_occupancy, ezee_guest_name,
    ezee_check_in_date, ezee_check_out_date, ezee_folio_balance_in_cents, ezee_booking_status
  FROM rooms ORDER BY room_no
) t
`.trim();

const SYNC_TIME_SQL = `
SELECT COALESCE(json_object_agg(name, synced_on), '{}'::json)::text FROM sync_time
`.trim();

const SYNXIS_HOTEL_DATE_SQL = `SELECT value::text FROM synxis_hotel_date LIMIT 1`;
const SYNXIS_COUNTS_SQL = `
SELECT COALESCE(json_object_agg(room_type, count), '{}'::json)::text
FROM synxis_reservation_by_roomtype
`.trim();
const EZEE_COUNTS_SQL = `
SELECT COALESCE(json_object_agg(room_type, count), '{}'::json)::text
FROM ezee_reservation_by_roomtype
`.trim();

const startedAt = new Date().toISOString();

async function fetchPostgresSnapshot() {
  const [rooms, syncTimes, hotelDateRaw, synxisCounts, ezeeCounts] = await Promise.all([
    queryLocalJson<DualPmsRoomRow[]>(ROOMS_SQL, []),
    queryLocalJson<Record<string, string>>(SYNC_TIME_SQL, {}),
    execLocalPsql(SYNXIS_HOTEL_DATE_SQL).catch(() => ""),
    queryLocalJson<Record<string, number>>(SYNXIS_COUNTS_SQL, {}),
    queryLocalJson<Record<string, number>>(EZEE_COUNTS_SQL, {}),
  ]);

  return {
    rooms,
    syncTimes,
    synxisSyncedAt: postgresTimestampToIso(syncTimes.synxis),
    ezeeSyncedAt: postgresTimestampToIso(syncTimes.ezee),
    hotelDate: hotelDateRaw.trim() || null,
    synxisCounts,
    ezeeCounts,
  };
}

export type SyncOnceResult = {
  roomsRead: number;
  roomsUpserted: number;
  synxisSource: string;
  ezeeSource: string;
  fallbackActive: boolean;
};

export async function runSyncOnce(): Promise<SyncOnceResult> {
  const client = createSupabaseClient();
  const now = new Date().toISOString();
  let roomsRead = 0;
  let roomsUpserted = 0;
  const warnings: SyncWarning[] = [];

  let synxisSource = SOURCE_DUALPMS_VPS;
  let ezeeSource = SOURCE_DUALPMS_VPS;
  let synxisByRoom = new Map<string, SynxisRoomSnapshot>();
  let ezeeByRoom = new Map<string, EzeeRoomSnapshot>();
  let hotelDate: string | null = null;
  let synxisCounts: Record<string, number> = {};
  let ezeeCounts: Record<string, number> = {};
  let synxisSyncedAt: string | null = null;
  let ezeeSyncedAt: string | null = null;
  let upstream = evaluateUpstreamHealth({});

  try {
    const snapshot = await fetchPostgresSnapshot();
    roomsRead = snapshot.rooms.length;
    upstream = evaluateUpstreamHealth(snapshot.syncTimes);
    synxisSyncedAt = snapshot.synxisSyncedAt;
    ezeeSyncedAt = snapshot.ezeeSyncedAt;
    hotelDate = snapshot.hotelDate;
    synxisCounts = snapshot.synxisCounts;
    ezeeCounts = snapshot.ezeeCounts;

    synxisByRoom = new Map(
      snapshot.rooms.map((row) => [String(row.room_no).trim(), mapDualPmsRoomToSynxis(row)]),
    );
    ezeeByRoom = new Map(
      snapshot.rooms.map((row) => [String(row.room_no).trim(), mapDualPmsRoomToEzee(row)]),
    );

    const inventory = await loadActiveRoomNumbers(client);
    let synxisApiStats = summarizeSynxisSnapshots(
      synxisByRoom,
      synxisByRoom,
      inventory.length,
      true,
    );
    let ezeeApiStats = summarizeEzeeSnapshots(ezeeByRoom, ezeeByRoom, inventory.length, true);

    if (upstream.synxisHealthy) {
      console.log("[fdn-bridge] SynXis: DualPMS healthy");
    } else {
      console.warn(
        `[fdn-bridge] SynXis upstream stale (${upstream.synxisPollAgeSec ?? "never"}s) — API fallback`,
      );
      const postgresSynxis = new Map(synxisByRoom);
      const fallback = await runSynxisFallback(client);
      const apiRooms = fallback.result.rooms;
      synxisByRoom = new Map(postgresSynxis);
      for (const [room, snap] of apiRooms) synxisByRoom.set(room, snap);
      synxisSource = fallback.source;
      synxisCounts = fallback.result.roomtypeCounts;
      if (fallback.result.hotelDate) hotelDate = fallback.result.hotelDate;
      synxisSyncedAt = now;
      synxisApiStats = summarizeSynxisSnapshots(apiRooms, synxisByRoom, inventory.length);
      console.log(`[fdn-bridge] SynXis API: ${synxisApiStats.detail}`);
      warnings.push({ system: "SynXis", message: fallback.warning, at: now });
      if (synxisApiStats.status !== "ok") {
        warnings.push({ system: "SynXis", message: synxisApiStats.detail, at: now });
      }
    }

    if (upstream.ezeeHealthy) {
      console.log("[fdn-bridge] eZee: DualPMS healthy");
    } else {
      console.warn(
        `[fdn-bridge] eZee upstream stale (${upstream.ezeePollAgeSec ?? "never"}s) — API fallback`,
      );
      const postgresEzee = new Map(ezeeByRoom);
      const fallback = await runEzeeFallback(client);
      const apiRooms = fallback.result.rooms;
      ezeeByRoom = new Map(postgresEzee);
      for (const [room, snap] of apiRooms) ezeeByRoom.set(room, snap);
      ezeeSource = fallback.source;
      ezeeCounts = fallback.result.roomtypeCounts;
      ezeeSyncedAt = now;
      ezeeApiStats = summarizeEzeeSnapshots(apiRooms, ezeeByRoom, inventory.length);
      console.log(`[fdn-bridge] eZee API: ${ezeeApiStats.detail}`);
      warnings.push({ system: "eZee", message: fallback.warning, at: now });
      if (ezeeApiStats.status !== "ok") {
        warnings.push({ system: "eZee", message: ezeeApiStats.detail, at: now });
      }
    }
    const upsertRows = inventory.map((roomNumber) =>
      buildUpsertRow(
        roomNumber,
        synxisByRoom.get(roomNumber),
        ezeeByRoom.get(roomNumber),
        synxisSyncedAt ?? now,
        ezeeSyncedAt ?? now,
      ),
    );

    const upsertResult = await upsertPmsRoomRows(client, upsertRows, hotelDate);
    roomsUpserted = upsertRows.length;
    if (upsertResult.checkoutsMarked > 0) {
      console.log(
        `[fdn-bridge] Housekeeping: ${upsertResult.checkoutsMarked} room(s) auto-marked dirty after checkout`,
      );
    }
    if (upsertResult.passiveDirty > 0) {
      console.log(
        `[fdn-bridge] Housekeeping: ${upsertResult.passiveDirty} room(s) passive-synced dirty from PMS`,
      );
    }

    await updateAppSettingsJson(client, PMS_SYNC_STATE_KEY, {
      synxis: {
        synced_at: now,
        dualpms_polled_at: upstream.synxisPolledAt,
        dualpms_healthy: upstream.synxisHealthy,
        hotel_date: hotelDate,
        source: synxisSource,
        api: synxisApiStats,
      },
      ezee: {
        synced_at: now,
        dualpms_polled_at: upstream.ezeePolledAt,
        dualpms_healthy: upstream.ezeeHealthy,
        source: ezeeSource,
        api: ezeeApiStats,
      },
    });

    const totals = mergeRoomtypeTotals(synxisCounts, ezeeCounts);
    await updateAppSettingsJson(client, PMS_ROOMTYPE_COUNTS_KEY, {
      synxis: synxisCounts,
      ezee: ezeeCounts,
      totals,
    });

    const fallbackActive = synxisSource !== SOURCE_DUALPMS_VPS || ezeeSource !== SOURCE_DUALPMS_VPS;
    await setAppSettingsValue(client, PMS_SYNC_WARNINGS_KEY, {
      warnings,
      fallback_active: fallbackActive,
      updated_at: now,
    });

    await writeBridgeHeartbeat(client, {
      source: "dualpms_vps_bridge",
      version: BRIDGE_VERSION,
      host: os.hostname(),
      started_at: startedAt,
      last_run_at: now,
      last_ok_at: now,
      last_error: null,
      rooms_read: roomsRead,
      rooms_upserted: roomsUpserted,
      dualpms_synxis_healthy: upstream.synxisHealthy,
      dualpms_ezee_healthy: upstream.ezeeHealthy,
      synxis_poll_age_sec: upstream.synxisPollAgeSec,
      ezee_poll_age_sec: upstream.ezeePollAgeSec,
      synxis_source: synxisSource,
      ezee_source: ezeeSource,
      fallback_active: fallbackActive,
    });

    const mode = fallbackActive ? " (fallback active)" : "";
    console.log(
      `[fdn-bridge] OK — read ${roomsRead} rooms, upserted ${roomsUpserted}${mode} at ${now}`,
    );

    return {
      roomsRead,
      roomsUpserted,
      synxisSource,
      ezeeSource,
      fallbackActive,
    };
  } catch (e) {
    const lastError = e instanceof Error ? e.message : String(e);
    await writeBridgeHeartbeat(client, {
      source: "dualpms_vps_bridge",
      version: BRIDGE_VERSION,
      host: os.hostname(),
      started_at: startedAt,
      last_run_at: now,
      last_ok_at: null,
      last_error: lastError,
      rooms_read: roomsRead,
      rooms_upserted: roomsUpserted,
      dualpms_synxis_healthy: upstream.synxisHealthy,
      dualpms_ezee_healthy: upstream.ezeeHealthy,
      synxis_poll_age_sec: upstream.synxisPollAgeSec,
      ezee_poll_age_sec: upstream.ezeePollAgeSec,
      synxis_source: synxisSource,
      ezee_source: ezeeSource,
      fallback_active: synxisSource !== SOURCE_DUALPMS_VPS || ezeeSource !== SOURCE_DUALPMS_VPS,
    }).catch(() => undefined);
    throw e;
  }
}

export async function runConnectionTest(): Promise<void> {
  console.log("[fdn-bridge] testing local Postgres…");
  await testLocalPostgres();
  console.log("[fdn-bridge] local Postgres OK");

  const { url, serviceRoleKey } = getSupabaseEnvForDiagnostics();
  console.log(`[fdn-bridge] testing Supabase reachability (${url})…`);
  await probeSupabaseReachability(url, serviceRoleKey);

  const client = createSupabaseClient();
  const { error } = await client.from("rooms").select("room_number", { head: true, count: "exact" });
  if (error) throw new Error(`Supabase query failed: ${error.message}`);

  if (!process.env.EZEE_SECRETS_KEY?.trim()) {
    console.warn("[fdn-bridge] EZEE_SECRETS_KEY not set — API fallback will not decrypt credentials");
  }

  console.log("[fdn-bridge] connection test passed (local Postgres + Supabase)");
}

/** Read sync_time fingerprint for fast re-sync when DualPMS updates. */
export async function readSyncTimeFingerprint(): Promise<string> {
  const raw = await execLocalPsql(SYNC_TIME_SQL).catch(() => "{}");
  return raw.trim() || "{}";
}
