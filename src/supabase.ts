import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { EzeeRoomSnapshot, SynxisRoomSnapshot } from "./types.js";
import {
  applyPassivePmsHkSync,
  autoMarkDirtyOnCheckout,
  detectCheckoutRooms,
  type RoomPmsHkSnapshot,
} from "./hk-pms-passive-sync.js";
import { syncHousekeepingTasksFromPms } from "./hk-pms-task-sync.js";
import { loadSupabaseEnv } from "./env.js";
import {
  PMS_BRIDGE_HEARTBEAT_KEY,
  PMS_ROOMTYPE_COUNTS_KEY,
  PMS_SYNC_STATE_KEY,
  PMS_SYNC_WARNINGS_KEY,
} from "./constants.js";
import type { BridgeHeartbeat } from "./types.js";

type PmsSoldBy = "synxis" | "ezee" | "neither";

function soldBy(synxisOccupancy: string | null, ezeeOccupancy: string | null): PmsSoldBy {
  if (synxisOccupancy === "Occupied" || synxisOccupancy === "Reserved") return "synxis";
  if (ezeeOccupancy === "Occupied") return "ezee";
  return "neither";
}

function mergeGuest(
  synxis: SynxisRoomSnapshot | undefined,
  ezee: EzeeRoomSnapshot | undefined,
): {
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
} {
  const mergedBalance = synxis?.balanceCents ?? ezee?.balanceCents ?? null;
  if (synxis?.guestName) {
    return {
      guestName: synxis.guestName,
      checkInDate: synxis.checkInDate,
      checkOutDate: synxis.checkOutDate,
      balanceCents: mergedBalance,
    };
  }
  if (ezee?.guestName) {
    return {
      guestName: ezee.guestName,
      checkInDate: ezee.checkInDate,
      checkOutDate: ezee.checkOutDate,
      balanceCents: mergedBalance,
    };
  }
  return { guestName: null, checkInDate: null, checkOutDate: null, balanceCents: null };
}

export function buildUpsertRow(
  roomNumber: string,
  synxis: SynxisRoomSnapshot | undefined,
  ezee: EzeeRoomSnapshot | undefined,
  synxisSyncedAt: string | null,
  ezeeSyncedAt: string | null,
): Record<string, unknown> {
  const merged = mergeGuest(synxis, ezee);
  const synxisOcc = synxis?.occupancy ?? null;
  const ezeeOcc = ezee?.occupancy ?? null;
  return {
    room_number: roomNumber,
    room_type: synxis?.roomType ?? ezee?.roomType ?? null,
    synxis_hk_status: synxis?.hkStatus ?? null,
    synxis_occupancy: synxisOcc,
    synxis_ooo_code: synxis?.oooCode ?? null,
    synxis_guest_name: synxis?.guestName ?? null,
    synxis_check_in_date: synxis?.checkInDate ?? null,
    synxis_check_out_date: synxis?.checkOutDate ?? null,
    synxis_balance_cents: synxis?.balanceCents ?? null,
    ezee_hk_status: ezee?.hkStatus ?? null,
    ezee_occupancy: ezeeOcc,
    ezee_guest_name: ezee?.guestName ?? null,
    ezee_check_in_date: ezee?.checkInDate ?? null,
    ezee_check_out_date: ezee?.checkOutDate ?? null,
    ezee_balance_cents: ezee?.balanceCents ?? null,
    ezee_booking_status: ezee?.bookingStatus ?? null,
    merged_guest_name: merged.guestName,
    merged_check_in_date: merged.checkInDate,
    merged_check_out_date: merged.checkOutDate,
    merged_balance_cents: merged.balanceCents,
    sold_by: soldBy(synxisOcc, ezeeOcc),
    synxis_synced_at: synxisSyncedAt,
    ezee_synced_at: ezeeSyncedAt,
    pms_updated_at: new Date().toISOString(),
  };
}

export async function upsertPmsRoomRows(
  client: SupabaseClient,
  rows: Record<string, unknown>[],
  hotelDate?: string | null,
): Promise<{
  checkoutsMarked: number;
  checkoutsSkipped: number;
  passiveDirty: number;
  tasksSynced: boolean;
}> {
  if (!rows.length) return { checkoutsMarked: 0, checkoutsSkipped: 0, passiveDirty: 0, tasksSynced: false };

  const roomNumbers = rows.map((r) => String(r.room_number));
  const { data: existing, error: existingError } = await client
    .from("room_operational_status")
    .select(
      "room_number, status, synxis_occupancy, ezee_occupancy, synxis_ooo_code, synxis_hk_status, ezee_hk_status",
    )
    .in("room_number", roomNumbers);

  if (existingError) throw new Error(existingError.message);

  const previousSnapshots: RoomPmsHkSnapshot[] = (existing ?? []).map((row) => {
    const r = row as {
      room_number: string;
      status: string | null;
      synxis_occupancy: string | null;
      ezee_occupancy: string | null;
      synxis_ooo_code: string | null;
      synxis_hk_status: string | null;
      ezee_hk_status: string | null;
    };
    return {
      room_number: String(r.room_number),
      synxis_occupancy: r.synxis_occupancy ?? null,
      ezee_occupancy: r.ezee_occupancy ?? null,
      synxis_ooo_code: r.synxis_ooo_code ?? null,
      synxis_hk_status: r.synxis_hk_status ?? null,
      ezee_hk_status: r.ezee_hk_status ?? null,
      lifecycle_status: r.status ?? null,
    };
  });

  const knownStatus = new Map<string, string>();
  for (const row of existing ?? []) {
    const rn = String((row as { room_number: string }).room_number);
    const st = (row as { status: string | null }).status;
    if (st) knownStatus.set(rn, st);
  }

  const checkoutRooms = detectCheckoutRooms(previousSnapshots, rows);
  let checkoutsMarked = 0;
  let checkoutsSkipped = 0;
  const checkoutProcessed = new Set<string>();

  if (checkoutRooms.length > 0) {
    const hk = await autoMarkDirtyOnCheckout(client, checkoutRooms);
    checkoutsMarked = hk.marked.length;
    checkoutsSkipped = hk.skipped.length;
    for (const room of [...hk.marked, ...hk.skipped]) {
      knownStatus.set(room, "dirty");
      checkoutProcessed.add(room);
    }
    if (hk.marked.length > 0) {
      console.log(`[fdn-bridge] Auto dirty on checkout: ${hk.marked.join(", ")}`);
    }
    for (const err of hk.errors) {
      console.warn(`[fdn-bridge] Checkout dirty failed: ${err}`);
    }
  }

  const passive = await applyPassivePmsHkSync(client, previousSnapshots, rows, checkoutProcessed);
  for (const [room, status] of passive.lifecyclePatches) {
    knownStatus.set(room, status);
  }
  if (passive.passiveDirty.length > 0) {
    console.log(`[fdn-bridge] Passive PMS dirty: ${passive.passiveDirty.join(", ")}`);
  }
  if (passive.passiveAvailable.length > 0) {
    console.log(`[fdn-bridge] Passive PMS available: ${passive.passiveAvailable.join(", ")}`);
  }

  const payload = rows.map((row) => {
    const roomNumber = String(row.room_number);
    return { ...row, status: knownStatus.get(roomNumber) ?? "available" };
  });

  const { error } = await client.from("room_operational_status").upsert(payload, {
    onConflict: "room_number",
  });
  if (error) throw new Error(error.message);

  let tasksSynced = false;
  try {
    const syncResult = await syncHousekeepingTasksFromPms(client, hotelDate);
    tasksSynced = true;
    const created =
      syncResult.due_out_created +
      syncResult.stayover_created +
      syncResult.deep_clean_created +
      syncResult.vacant_dirty;
    if (created > 0) {
      console.log(
        `[fdn-bridge] PMS task sync (${syncResult.hotel_date}): ${created} created`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[fdn-bridge] PMS task sync skipped: ${msg}`);
  }

  return {
    checkoutsMarked,
    checkoutsSkipped,
    passiveDirty: passive.passiveDirty.length,
    tasksSynced,
  };
}

export async function updateAppSettingsJson(
  client: SupabaseClient,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const current =
    data?.value && typeof data.value === "object" && !Array.isArray(data.value)
      ? (data.value as Record<string, unknown>)
      : {};

  const next = { ...current, ...patch };
  const { error: upsertError } = await client.from("app_settings").upsert(
    { key, value: next, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (upsertError) throw new Error(upsertError.message);
}

export async function setAppSettingsValue(
  client: SupabaseClient,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from("app_settings").upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) throw new Error(error.message);
}

export async function loadActiveRoomNumbers(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client
    .from("rooms")
    .select("room_number")
    .eq("is_active", true);
  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((r) => String((r as { room_number: string }).room_number).trim())
    .filter(Boolean)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

export function createSupabaseClient(): SupabaseClient {
  const { url, serviceRoleKey } = loadSupabaseEnv();
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function getSupabaseEnvForDiagnostics() {
  return loadSupabaseEnv();
}

export async function writeBridgeHeartbeat(
  client: SupabaseClient,
  heartbeat: BridgeHeartbeat,
): Promise<void> {
  await setAppSettingsValue(client, PMS_BRIDGE_HEARTBEAT_KEY, heartbeat);
}

export { PMS_SYNC_STATE_KEY, PMS_ROOMTYPE_COUNTS_KEY, PMS_BRIDGE_HEARTBEAT_KEY, PMS_SYNC_WARNINGS_KEY };
