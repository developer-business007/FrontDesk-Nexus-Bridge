import {
  DUALPMS_EZEE_POLL_STALE_SEC,
  DUALPMS_SYNXIS_POLL_STALE_SEC,
} from "./constants.js";
import { postgresTimestampToIso } from "./map.js";

export type UpstreamHealth = {
  synxisPolledAt: string | null;
  ezeePolledAt: string | null;
  synxisPollAgeSec: number | null;
  ezeePollAgeSec: number | null;
  synxisHealthy: boolean;
  ezeeHealthy: boolean;
};

export function pollAgeSeconds(iso: string | null, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}

export function evaluateUpstreamHealth(
  syncTimes: Record<string, string>,
  nowMs = Date.now(),
): UpstreamHealth {
  const synxisPolledAt = postgresTimestampToIso(syncTimes.synxis);
  const ezeePolledAt = postgresTimestampToIso(syncTimes.ezee);
  const synxisPollAgeSec = pollAgeSeconds(synxisPolledAt, nowMs);
  const ezeePollAgeSec = pollAgeSeconds(ezeePolledAt, nowMs);

  const synxisHealthy =
    synxisPollAgeSec != null && synxisPollAgeSec <= DUALPMS_SYNXIS_POLL_STALE_SEC;
  const ezeeHealthy =
    ezeePollAgeSec != null && ezeePollAgeSec <= DUALPMS_EZEE_POLL_STALE_SEC;

  return {
    synxisPolledAt,
    ezeePolledAt,
    synxisPollAgeSec,
    ezeePollAgeSec,
    synxisHealthy,
    ezeeHealthy,
  };
}
