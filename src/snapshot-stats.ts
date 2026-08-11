import type { EzeeRoomSnapshot, SynxisRoomSnapshot } from "./types.js";

export type SystemApiStats = {
  status: "ok" | "partial" | "failed";
  rooms_from_api: number;
  rooms_with_occupancy: number;
  rooms_with_hk: number;
  inventory_rooms: number;
  stale_rooms_used: number;
  detail: string;
};

function countOccupancy<T extends { occupancy: string | null }>(rooms: Map<string, T>): number {
  let n = 0;
  for (const r of rooms.values()) {
    if (r.occupancy) n += 1;
  }
  return n;
}

function countHk<T extends { hkStatus: string | null }>(rooms: Map<string, T>): number {
  let n = 0;
  for (const r of rooms.values()) {
    if (r.hkStatus) n += 1;
  }
  return n;
}

export function summarizeSynxisSnapshots(
  apiRooms: Map<string, SynxisRoomSnapshot>,
  mergedRooms: Map<string, SynxisRoomSnapshot>,
  inventoryCount: number,
  viaPostgres = false,
): SystemApiStats {
  const roomsFromApi = apiRooms.size;
  const apiWithOcc = countOccupancy(apiRooms);
  const apiWithHk = countHk(apiRooms);

  let staleUsed = 0;
  for (const [room, snap] of mergedRooms) {
    if (apiRooms.has(room)) continue;
    if (snap.occupancy || snap.hkStatus) staleUsed += 1;
  }

  let status: SystemApiStats["status"] = "ok";
  let detail: string;

  if (viaPostgres) {
    detail = `DualPMS Postgres — ${roomsFromApi} rooms, ${apiWithOcc} with S.OCC`;
    if (roomsFromApi < inventoryCount) {
      status = "partial";
      detail += ` (${inventoryCount - roomsFromApi} inventory rooms missing in Postgres)`;
    }
  } else if (roomsFromApi === 0) {
    status = "failed";
    detail =
      "SynXis API returned 0 rooms — session test can pass but housekeeping API may be empty";
  } else if (roomsFromApi < inventoryCount) {
    status = "partial";
    detail = `SynXis API returned ${roomsFromApi}/${inventoryCount} rooms`;
    if (staleUsed > 0) {
      detail += `; ${staleUsed} rooms filled from stale DualPMS Postgres`;
    }
  } else if (apiWithOcc === 0) {
    status = "failed";
    detail = `SynXis API returned ${roomsFromApi} rooms but none have occupancy`;
  } else if (apiWithOcc < Math.min(roomsFromApi, inventoryCount) * 0.5) {
    status = "partial";
    detail = `SynXis API: only ${apiWithOcc}/${inventoryCount} rooms have S.OCC`;
  } else {
    detail = `SynXis API OK — ${roomsFromApi} rooms, ${apiWithOcc} with S.OCC`;
  }

  return {
    status,
    rooms_from_api: roomsFromApi,
    rooms_with_occupancy: apiWithOcc,
    rooms_with_hk: apiWithHk,
    inventory_rooms: inventoryCount,
    stale_rooms_used: staleUsed,
    detail,
  };
}

export function summarizeEzeeSnapshots(
  apiRooms: Map<string, EzeeRoomSnapshot>,
  mergedRooms: Map<string, EzeeRoomSnapshot>,
  inventoryCount: number,
  viaPostgres = false,
): SystemApiStats {
  const roomsFromApi = apiRooms.size;
  const apiWithOcc = countOccupancy(apiRooms);
  const apiWithHk = countHk(apiRooms);

  let staleUsed = 0;
  for (const [room, snap] of mergedRooms) {
    if (apiRooms.has(room)) continue;
    if (snap.occupancy || snap.hkStatus) staleUsed += 1;
  }

  let status: SystemApiStats["status"] = "ok";
  let detail: string;

  if (viaPostgres) {
    detail = `DualPMS Postgres — ${roomsFromApi} rooms, ${apiWithOcc} with E.OCC`;
    if (roomsFromApi < inventoryCount) {
      status = "partial";
      detail += ` (${inventoryCount - roomsFromApi} inventory rooms missing in Postgres)`;
    }
  } else if (roomsFromApi === 0) {
    status = "failed";
    detail = "eZee API returned 0 rooms";
  } else if (roomsFromApi < inventoryCount) {
    status = "partial";
    detail = `eZee API returned ${roomsFromApi}/${inventoryCount} rooms`;
    if (staleUsed > 0) {
      detail += `; ${staleUsed} rooms filled from stale DualPMS Postgres`;
    }
  } else if (apiWithOcc === 0) {
    status = "failed";
    detail = `eZee API returned ${roomsFromApi} rooms but none have occupancy`;
  } else {
    detail = `eZee API OK — ${roomsFromApi} rooms, ${apiWithOcc} with E.OCC`;
  }

  return {
    status,
    rooms_from_api: roomsFromApi,
    rooms_with_occupancy: apiWithOcc,
    rooms_with_hk: apiWithHk,
    inventory_rooms: inventoryCount,
    stale_rooms_used: staleUsed,
    detail,
  };
}
