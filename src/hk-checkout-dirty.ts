import type { SupabaseClient } from "@supabase/supabase-js";

export type RoomOccupancySnapshot = {
  room_number: string;
  synxis_occupancy: string | null;
  ezee_occupancy: string | null;
  synxis_ooo_code: string | null;
};

function norm(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** Guest was physically in the room (not merely reserved for arrival). */
function wasPhysicallyOccupied(synxis: string, ezee: string): boolean {
  return synxis === "Occupied" || ezee === "Occupied";
}

function hadOccupancySignal(synxis: string, ezee: string): boolean {
  return !!(synxis || ezee);
}

/** Room reads vacant after a departure (SynXis primary; eZee fallback). */
function isVacantAfterCheckout(synxis: string, ezee: string): boolean {
  if (synxis === "Vacant") return true;
  if (ezee === "Vacant" && synxis !== "Occupied" && synxis !== "Reserved") return true;
  return false;
}

function isOutOfOrder(ooo: string, synxis: string, ezee: string): boolean {
  if (ooo && ooo !== "~" && ooo !== "FD") return true;
  if (synxis === "Blocked" || ezee === "Blocked") return true;
  return false;
}

/**
 * Detect rooms that transitioned from occupied → vacant between PMS sync cycles.
 * Skips first-seen rooms and OOO/blocked rooms.
 */
export function detectCheckoutRooms(
  previous: RoomOccupancySnapshot[],
  incoming: Record<string, unknown>[],
): string[] {
  const prevByRoom = new Map(previous.map((row) => [row.room_number, row]));
  const checkouts: string[] = [];

  for (const row of incoming) {
    const roomNumber = String(row.room_number ?? "").trim();
    if (!roomNumber) continue;

    const prev = prevByRoom.get(roomNumber);
    if (!prev) continue;

    const prevSynxis = norm(prev.synxis_occupancy);
    const prevEzee = norm(prev.ezee_occupancy);
    const nextSynxis = norm(row.synxis_occupancy as string | null);
    const nextEzee = norm(row.ezee_occupancy as string | null);
    const nextOoo = norm(row.synxis_ooo_code as string | null);

    if (!hadOccupancySignal(prevSynxis, prevEzee)) continue;
    if (!wasPhysicallyOccupied(prevSynxis, prevEzee)) continue;
    if (!isVacantAfterCheckout(nextSynxis, nextEzee)) continue;
    if (isOutOfOrder(nextOoo, nextSynxis, nextEzee)) continue;

    checkouts.push(roomNumber);
  }

  return checkouts;
}

function isBenignDirtyError(message: string): boolean {
  return /already|dirty|open task|in service|duplicate/i.test(message);
}

/** Call Nexus `hk_mark_room_dirty` for checkout turnovers (idempotent on repeats). */
export async function autoMarkDirtyOnCheckout(
  client: SupabaseClient,
  roomNumbers: string[],
  note = "Auto: guest checkout (PMS sync)",
): Promise<{ marked: string[]; skipped: string[]; errors: string[] }> {
  const marked: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const roomNumber of roomNumbers) {
    const { error } = await client.rpc("hk_mark_room_dirty", {
      p_room_number: roomNumber,
      p_notes: note,
    });

    if (error) {
      if (isBenignDirtyError(error.message)) {
        skipped.push(roomNumber);
      } else {
        errors.push(`${roomNumber}: ${error.message}`);
      }
    } else {
      marked.push(roomNumber);
    }
  }

  return { marked, skipped, errors };
}
