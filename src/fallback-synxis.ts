import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SOURCE_COOKIE_BACKUP,
  SOURCE_SYNXIS_API_CREDENTIALS,
} from "./constants.js";
import { loadSynxisPropertyConfig } from "./secrets.js";
import type { SynxisRoomSnapshot } from "./types.js";
import { loginSynxisWithCredentials, normalizeSynxisCookieHeader } from "./synxis/session.js";
import {
  loadSynxisCookieHeader,
  syncSynxisRooms,
  validateSynxisCookieHeader,
  type RoomtypeCounts,
  type SynxisSyncResult,
} from "./synxis/room-sync.js";

export { normalizeSynxisCookieHeader };

export type SynxisFallbackOutcome = {
  result: SynxisSyncResult;
  source: string;
  authMethod: "browser_cookie" | "credentials";
  warning: string;
};

/**
 * SynXis API fallback when DualPMS upstream poll is stale.
 * 1. Extension browser cookie (client requirement)
 * 2. Script login with stored credentials + Gmail MFA
 */
export async function runSynxisFallback(
  client: SupabaseClient,
): Promise<SynxisFallbackOutcome> {
  const propertyConfig = await loadSynxisPropertyConfig(client);
  const pollNote = "DualPMS SynXis poll stale";

  const browserCookie = await loadSynxisCookieHeader(client);
  if (browserCookie) {
    const normalized = normalizeSynxisCookieHeader(browserCookie);
    if (await validateSynxisCookieHeader(normalized, propertyConfig)) {
      console.log("[fdn-bridge] SynXis fallback: browser cookie");
      const result = await syncSynxisRooms(normalized, propertyConfig);
      return {
        result,
        source: SOURCE_COOKIE_BACKUP,
        authMethod: "browser_cookie",
        warning: `${pollNote} — using extension browser cookie (API fallback)`,
      };
    }
    console.warn("[fdn-bridge] SynXis browser cookie invalid, trying credentials");
  }

  console.log("[fdn-bridge] SynXis fallback: credentials login");
  const cookieHeader = await loginSynxisWithCredentials(client);
  const result = await syncSynxisRooms(cookieHeader, propertyConfig);
  return {
    result,
    source: SOURCE_SYNXIS_API_CREDENTIALS,
    authMethod: "credentials",
    warning: `${pollNote} — using script login (API fallback)`,
  };
}
