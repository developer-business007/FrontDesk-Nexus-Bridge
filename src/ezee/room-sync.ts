import type { EzeeRoomSnapshot } from "../types.js";
import type { RoomtypeCounts } from "../synxis/room-sync.js";

const EZEE_ROOMLIST_URL =
  process.env.EZEE_ROOMLIST_URL?.trim() ||
  "https://live.ipms247.com/index.php/page/service.hkinfoforkaterina";

const ROOM_TYPE_ID_TO_CODE: Record<string, string> = {
  "5183600000000000001": "NDD1",
  "5183600000000000005": "SNK4",
  "5183600000000000003": "NK1",
  "5183600000000000004": "PND2",
  "5183600000000000006": "PNK1",
};

function processName(input: string): string {
  let name = input.trim();
  name = name.replace(/^(?:Mr|Ms|Mrs)\./i, "");
  name = name.replace(/\(.+\)/, "");
  return name.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapOccupancy(roomStatus: string): string {
  if (roomStatus === "Available") return "Vacant";
  if (roomStatus === "Maintenance Block") return "Blocked";
  return "Occupied";
}

function mapHk(hk: string): string {
  if (hk === "Dirty") return "Dirty";
  if (hk === "Verify (Clean)") return "Clean";
  return "Clean";
}

type EzeeHkResponse = {
  roomlist?: Array<{
    roomname: string | number;
    roomtypeid: string;
    roomstatus: string;
    hkstatus: string;
  }>;
  checkinguestlist?: Array<{
    room?: string | number;
    guestname?: string;
    reservationno?: string;
    checkindate?: string;
    checkoutdate?: string;
    bookingstatus?: string;
  }>;
};

export type EzeeSyncResult = {
  rooms: Map<string, EzeeRoomSnapshot>;
  roomtypeCounts: RoomtypeCounts;
};

export async function syncEzeeRooms(
  hotelCode: number,
  authCode: string,
): Promise<EzeeSyncResult> {
  const res = await fetch(EZEE_ROOMLIST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hotel_code: String(hotelCode), authcode: authCode }),
  });

  if (!res.ok) throw new Error(`eZee room list HTTP ${res.status}`);

  const json = (await res.json()) as EzeeHkResponse & {
    Errors?: { ErrorCode?: string; ErrorMessage?: string };
  };

  if (json.Errors?.ErrorMessage) {
    throw new Error(`eZee API: ${json.Errors.ErrorMessage}`);
  }

  if (!Array.isArray(json.roomlist)) {
    throw new Error("eZee API returned no room list");
  }

  const rooms = new Map<string, EzeeRoomSnapshot>();
  const roomtypeCounts: RoomtypeCounts = {};

  for (const room of json.roomlist) {
    const roomNumber = String(room.roomname).trim();
    const roomType = ROOM_TYPE_ID_TO_CODE[room.roomtypeid] ?? null;
    const occupancy = mapOccupancy(room.roomstatus);
    const hkStatus = mapHk(room.hkstatus);

    rooms.set(roomNumber, {
      roomNumber,
      roomType,
      hkStatus,
      occupancy,
      guestName: null,
      checkInDate: null,
      checkOutDate: null,
      balanceCents: null,
      bookingStatus: null,
    });

    if (occupancy === "Occupied" && roomType) {
      roomtypeCounts[roomType] = (roomtypeCounts[roomType] ?? 0) + 1;
    }
  }

  for (const guest of json.checkinguestlist ?? []) {
    const roomNumber = guest.room != null ? String(guest.room).trim() : "";
    if (!roomNumber) continue;
    const row = rooms.get(roomNumber);
    if (!row) continue;
    if (guest.bookingstatus === "Checked Out") continue;

    rooms.set(roomNumber, {
      ...row,
      occupancy: "Occupied",
      guestName: guest.guestname ? processName(guest.guestname) : null,
      checkInDate: guest.checkindate?.slice(0, 10) ?? null,
      checkOutDate: guest.checkoutdate?.slice(0, 10) ?? null,
      bookingStatus: guest.bookingstatus ?? null,
    });
  }

  return { rooms, roomtypeCounts };
}
