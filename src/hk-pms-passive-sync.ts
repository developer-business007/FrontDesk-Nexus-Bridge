import type { SupabaseClient } from "@supabase/supabase-js";
import { autoMarkDirtyOnCheckout, type RoomOccupancySnapshot } from "./hk-checkout-dirty.js";

export type RoomPmsHkSnapshot = RoomOccupancySnapshot & {
  synxis_hk_status: string | null;
  ezee_hk_status: string | null;
  lifecycle_status: string | null;
};

export type LifecycleStatus =
  | "occupied"
  | "dirty"
  | "in_service"
  | "clean_ready"
  | "available"
  | "out_of_order";

function norm(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function primaryHkStatus(synxis: string | null, ezee: string | null): string {
  return norm(synxis) || norm(ezee);
}

function isPmsHkDirty(hk: string): boolean {
  return hk === "Dirty";
}

function isPmsHkClean(hk: string): boolean {
  if (!hk) return false;
  const lower = hk.toLowerCase();
  return hk === "Clean" || lower.includes("verify") || lower.includes("clean");
}

function isVacant(synxis: string, ezee: string): boolean {
  if (synxis === "Vacant") return true;
  if (ezee === "Vacant" && synxis !== "Occupied" && synxis !== "Reserved") return true;
  return false;
}

function isOutOfOrder(ooo: string, synxis: string, ezee: string): boolean {
  if (ooo && ooo !== "~" && ooo !== "FD") return true;
  if (synxis === "Blocked" || ezee === "Blocked") return true;
  return false;
}

function wasOutOfOrder(ooo: string, synxis: string, ezee: string): boolean {
  return isOutOfOrder(ooo, synxis, ezee);
}

async function setRoomLifecycle(
  client: SupabaseClient,
  roomNumber: string,
  status: LifecycleStatus,
  reason: string,
): Promise<boolean> {
  const { error } = await client
    .from("room_operational_status")
    .update({
      status,
      status_reason: reason,
      status_changed_at: new Date().toISOString(),
    })
    .eq("room_number", roomNumber);

  if (error) {
    console.warn(`[fdn-bridge] Lifecycle update failed for ${roomNumber}:`, error.message);
    return false;
  }
  return true;
}

async function markDirtyPassive(
  client: SupabaseClient,
  roomNumber: string,
): Promise<"marked" | "skipped" | "error"> {
  const { error } = await client.rpc("hk_mark_room_dirty", {
    p_room_number: roomNumber,
    p_notes: "Passive sync: PMS HK status dirty",
  });
  if (error) {
    if (/already|dirty|open task|in service|duplicate/i.test(error.message)) return "skipped";
    console.warn(`[fdn-bridge] Passive dirty failed for ${roomNumber}:`, error.message);
    return "error";
  }
  return "marked";
}

async function markAvailablePassive(
  client: SupabaseClient,
  roomNumber: string,
): Promise<"marked" | "skipped" | "error"> {
  const { error } = await client.rpc("hk_mark_room_available", {
    p_room_number: roomNumber,
    p_reason: "Passive sync: PMS HK clean",
  });
  if (error) {
    if (/already|available|duplicate/i.test(error.message)) return "skipped";
    console.warn(`[fdn-bridge] Passive available failed for ${roomNumber}:`, error.message);
    return "error";
  }
  return "marked";
}

export type PassivePmsSyncResult = {
  lifecyclePatches: Map<string, LifecycleStatus>;
  passiveDirty: string[];
  passiveAvailable: string[];
};

/** Mirror external PMS HK / OOO changes onto the Nexus housekeeping lifecycle. */
export async function applyPassivePmsHkSync(
  client: SupabaseClient,
  previous: RoomPmsHkSnapshot[],
  incoming: Record<string, unknown>[],
  skipDirtyRooms: Set<string> = new Set(),
): Promise<PassivePmsSyncResult> {
  const prevByRoom = new Map(previous.map((row) => [row.room_number, row]));
  const lifecyclePatches = new Map<string, LifecycleStatus>();
  const passiveDirty: string[] = [];
  const passiveAvailable: string[] = [];

  for (const row of incoming) {
    const roomNumber = String(row.room_number ?? "").trim();
    if (!roomNumber) continue;

    const prev = prevByRoom.get(roomNumber);
    if (!prev) continue;

    const prevSynxis = norm(prev.synxis_occupancy);
    const prevEzee = norm(prev.ezee_occupancy);
    const prevOoo = norm(prev.synxis_ooo_code);
    const prevHk = primaryHkStatus(prev.synxis_hk_status, prev.ezee_hk_status);
    const prevLifecycle = norm(prev.lifecycle_status);

    const nextSynxis = norm(row.synxis_occupancy as string | null);
    const nextEzee = norm(row.ezee_occupancy as string | null);
    const nextOoo = norm(row.synxis_ooo_code as string | null);
    const nextHk = primaryHkStatus(
      row.synxis_hk_status as string | null,
      row.ezee_hk_status as string | null,
    );
    const vacant = isVacant(nextSynxis, nextEzee);
    const nextOooActive = isOutOfOrder(nextOoo, nextSynxis, nextEzee);
    const prevOooActive = wasOutOfOrder(prevOoo, prevSynxis, prevEzee);

    if (nextOooActive && !prevOooActive) {
      const ok = await setRoomLifecycle(client, roomNumber, "out_of_order", `PMS OOO ${nextOoo || "blocked"}`);
      if (ok) lifecyclePatches.set(roomNumber, "out_of_order");
      continue;
    }

    if (prevOooActive && !nextOooActive && vacant && prevLifecycle === "out_of_order") {
      const ok = await setRoomLifecycle(client, roomNumber, "available", "PMS OOO cleared");
      if (ok) lifecyclePatches.set(roomNumber, "available");
      continue;
    }

    if (nextOooActive) continue;

    if (
      vacant &&
      isPmsHkDirty(nextHk) &&
      !isPmsHkDirty(prevHk) &&
      !skipDirtyRooms.has(roomNumber) &&
      (prevLifecycle === "available" || prevLifecycle === "clean_ready" || !prevLifecycle)
    ) {
      const result = await markDirtyPassive(client, roomNumber);
      if (result === "marked" || result === "skipped") {
        lifecyclePatches.set(roomNumber, "dirty");
        passiveDirty.push(roomNumber);
      }
      continue;
    }

    if (
      vacant &&
      isPmsHkClean(nextHk) &&
      !isPmsHkClean(prevHk) &&
      prevLifecycle === "clean_ready"
    ) {
      const result = await markAvailablePassive(client, roomNumber);
      if (result === "marked" || result === "skipped") {
        lifecyclePatches.set(roomNumber, "available");
        passiveAvailable.push(roomNumber);
      }
    }
  }

  return { lifecyclePatches, passiveDirty, passiveAvailable };
}

export { autoMarkDirtyOnCheckout, detectCheckoutRooms } from "./hk-checkout-dirty.js";
export type { RoomOccupancySnapshot } from "./hk-checkout-dirty.js";
