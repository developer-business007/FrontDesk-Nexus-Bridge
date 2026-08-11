export const PMS_SYNC_STATE_KEY = "pms_sync_state";
export const PMS_ROOMTYPE_COUNTS_KEY = "pms_roomtype_counts";
export const PMS_BRIDGE_HEARTBEAT_KEY = "dualpms_bridge_heartbeat";
export const PMS_SYNC_WARNINGS_KEY = "pms_sync_warnings";

export const SYNXIS_SESSION_KEY = "synxis_session";
export const SYNXIS_INTEGRATION_KEY = "synxis_integration";
export const EZEE_INTEGRATION_KEY = "ezee_integration";

export const BRIDGE_VERSION = "1.1.0";

/** Primary: copied from DualPMS Postgres on VPS */
export const SOURCE_DUALPMS_VPS = "dualpms_vps";
/** SynXis fallback: extension browser cookie */
export const SOURCE_COOKIE_BACKUP = "cookie_backup";
/** SynXis fallback: script login (credentials + Gmail MFA) */
export const SOURCE_SYNXIS_API_CREDENTIALS = "synxis_api_credentials";
/** eZee fallback: direct API */
export const SOURCE_EZEE_API_FALLBACK = "ezee_api_fallback";

/** DualPMS synxis.py polls ~every 8–12s; ezee.py ~every 8s */
export const DUALPMS_SYNXIS_POLL_STALE_SEC = 45;
export const DUALPMS_EZEE_POLL_STALE_SEC = 45;
