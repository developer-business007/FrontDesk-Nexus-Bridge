import type { DualPmsRoomRow, EzeeRoomSnapshot, SynxisRoomSnapshot } from "./types.js";

function asString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function asDateString(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function asCents(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function normalizeOoo(code: string | null): string | null {
  if (!code || code === "~") return null;
  return code;
}

export function mapDualPmsRoomToSynxis(row: DualPmsRoomRow): SynxisRoomSnapshot {
  const roomNumber = String(row.room_no).trim();
  return {
    roomNumber,
    roomType: asString(row.room_type),
    hkStatus: asString(row.synxis_housekeeping_status),
    occupancy: asString(row.synxis_occupancy),
    oooCode: normalizeOoo(asString(row.synxis_ooo)),
    guestName: asString(row.synxis_guest_name),
    checkInDate: asDateString(row.synxis_check_in_date),
    checkOutDate: asDateString(row.synxis_check_out_date),
    balanceCents: asCents(row.synxis_folio_balance_in_cents),
  };
}

export function mapDualPmsRoomToEzee(row: DualPmsRoomRow): EzeeRoomSnapshot {
  const roomNumber = String(row.room_no).trim();
  return {
    roomNumber,
    roomType: asString(row.room_type),
    hkStatus: asString(row.ezee_housekeeping_status),
    occupancy: asString(row.ezee_occupancy),
    guestName: asString(row.ezee_guest_name),
    checkInDate: asDateString(row.ezee_check_in_date),
    checkOutDate: asDateString(row.ezee_check_out_date),
    balanceCents: asCents(row.ezee_folio_balance_in_cents),
    bookingStatus: asString(row.ezee_booking_status),
  };
}

export function postgresTimestampToIso(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : s;
}

export function mergeRoomtypeTotals(
  synxis: Record<string, number>,
  ezee: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(synxis), ...Object.keys(ezee)]);
  const totals: Record<string, number> = {};
  for (const k of keys) {
    totals[k] = (synxis[k] ?? 0) + (ezee[k] ?? 0);
  }
  return totals;
}
