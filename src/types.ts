export type SynxisRoomSnapshot = {
  roomNumber: string;
  roomType: string | null;
  hkStatus: string | null;
  occupancy: string | null;
  oooCode: string | null;
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
};

export type EzeeRoomSnapshot = {
  roomNumber: string;
  roomType: string | null;
  hkStatus: string | null;
  occupancy: string | null;
  guestName: string | null;
  checkInDate: string | null;
  checkOutDate: string | null;
  balanceCents: number | null;
  bookingStatus: string | null;
};

export type DualPmsRoomRow = {
  room_no: number | string;
  room_type?: string | null;
  synxis_housekeeping_status?: string | null;
  synxis_ooo?: string | null;
  synxis_occupancy?: string | null;
  synxis_guest_name?: string | null;
  synxis_check_in_date?: string | null;
  synxis_check_out_date?: string | null;
  synxis_folio_balance_in_cents?: number | null;
  ezee_housekeeping_status?: string | null;
  ezee_occupancy?: string | null;
  ezee_guest_name?: string | null;
  ezee_check_in_date?: string | null;
  ezee_check_out_date?: string | null;
  ezee_folio_balance_in_cents?: number | null;
  ezee_booking_status?: string | null;
};

export type BridgeHeartbeat = {
  source: string;
  version: string;
  host: string;
  started_at: string;
  last_run_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  rooms_read: number | null;
  rooms_upserted: number | null;
  dualpms_synxis_healthy?: boolean;
  dualpms_ezee_healthy?: boolean;
  synxis_poll_age_sec?: number | null;
  ezee_poll_age_sec?: number | null;
  synxis_source?: string | null;
  ezee_source?: string | null;
  fallback_active?: boolean;
};

export type SyncWarning = {
  system: "SynXis" | "eZee";
  message: string;
  at: string;
};
