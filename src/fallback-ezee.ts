import type { SupabaseClient } from "@supabase/supabase-js";
import { SOURCE_EZEE_API_FALLBACK } from "./constants.js";
import { resolveEzeeCredentials } from "./secrets.js";
import { syncEzeeRooms, type EzeeSyncResult } from "./ezee/room-sync.js";

export type EzeeFallbackOutcome = {
  result: EzeeSyncResult;
  source: string;
  warning: string;
};

export async function runEzeeFallback(client: SupabaseClient): Promise<EzeeFallbackOutcome> {
  const creds = await resolveEzeeCredentials(client);
  if (!creds) {
    throw new Error("eZee credentials not configured in Admin → Settings");
  }

  console.log("[fdn-bridge] eZee fallback: direct API");
  const result = await syncEzeeRooms(creds.hotelCode, creds.authCode);
  return {
    result,
    source: SOURCE_EZEE_API_FALLBACK,
    warning: "DualPMS eZee poll stale — using direct eZee API (fallback)",
  };
}
