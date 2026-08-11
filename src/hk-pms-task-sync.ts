import type { SupabaseClient } from "@supabase/supabase-js";

export type PmsTaskSyncResult = {
  hotel_date: string;
  due_out_created: number;
  due_out_existing: number;
  stayover_created: number;
  stayover_existing: number;
  deep_clean_created: number;
  deep_clean_existing: number;
  vacant_dirty: number;
  skipped_ooo: number;
};

export function emptyPmsTaskSyncResult(hotelDate: string): PmsTaskSyncResult {
  return {
    hotel_date: hotelDate,
    due_out_created: 0,
    due_out_existing: 0,
    stayover_created: 0,
    stayover_existing: 0,
    deep_clean_created: 0,
    deep_clean_existing: 0,
    vacant_dirty: 0,
    skipped_ooo: 0,
  };
}

function parseSyncResult(data: unknown, fallbackDate: string): PmsTaskSyncResult {
  if (!data || typeof data !== "object") return emptyPmsTaskSyncResult(fallbackDate);
  const row = data as Record<string, unknown>;
  const num = (key: string) => (typeof row[key] === "number" ? row[key] : 0) as number;
  return {
    hotel_date: typeof row.hotel_date === "string" ? row.hotel_date.slice(0, 10) : fallbackDate,
    due_out_created: num("due_out_created"),
    due_out_existing: num("due_out_existing"),
    stayover_created: num("stayover_created"),
    stayover_existing: num("stayover_existing"),
    deep_clean_created: num("deep_clean_created"),
    deep_clean_existing: num("deep_clean_existing"),
    vacant_dirty: num("vacant_dirty"),
    skipped_ooo: num("skipped_ooo"),
  };
}

/** Auto-generate due out / stayover / deep clean tasks from DualPMS (idempotent). */
export async function syncHousekeepingTasksFromPms(
  client: SupabaseClient,
  hotelDate?: string | null,
): Promise<PmsTaskSyncResult> {
  const fallback = hotelDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const { data, error } = await client.rpc("hk_sync_tasks_from_pms", {
    p_hotel_date: hotelDate?.slice(0, 10) ?? null,
  });

  if (error) {
    if (/function.*does not exist|hk_sync_tasks_from_pms/i.test(error.message)) {
      console.warn("[hk-pms-task-sync] RPC not deployed yet:", error.message);
      return emptyPmsTaskSyncResult(fallback);
    }
    throw new Error(error.message);
  }

  return parseSyncResult(data, fallback);
}

export function formatPmsTaskSyncSummary(result: PmsTaskSyncResult): string {
  const created =
    result.due_out_created +
    result.stayover_created +
    result.deep_clean_created +
    result.vacant_dirty;
  const existing =
    result.due_out_existing + result.stayover_existing + result.deep_clean_existing;
  return `${created} created, ${existing} already open (${result.hotel_date})`;
}
