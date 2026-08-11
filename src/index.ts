import "dotenv/config";
import "./env.js";
import { runConnectionTest, runSyncOnce, readSyncTimeFingerprint } from "./sync-once.js";

const args = new Set(process.argv.slice(2));
const testOnly = args.has("--test");
const once = args.has("--once");
const intervalMs = Number(process.env.BRIDGE_INTERVAL_MS) || 10_000;
const fastPollMs = Number(process.env.BRIDGE_FAST_POLL_MS) || 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (testOnly) {
    await runConnectionTest();
    return;
  }

  if (once) {
    await runSyncOnce();
    return;
  }

  console.log(
    `[fdn-bridge] loop every ${intervalMs}ms (fast poll ${fastPollMs}ms when DualPMS sync_time changes)`,
  );

  let lastFingerprint = "";
  let lastFullRunAt = 0;

  for (;;) {
    try {
      const fingerprint = await readSyncTimeFingerprint();
      const syncTimeChanged = fingerprint !== lastFingerprint && lastFingerprint !== "";
      const intervalElapsed = Date.now() - lastFullRunAt >= intervalMs;

      if (syncTimeChanged || intervalElapsed || lastFullRunAt === 0) {
        if (syncTimeChanged) {
          console.log("[fdn-bridge] DualPMS sync_time changed — immediate copy");
        }
        await runSyncOnce();
        lastFingerprint = fingerprint;
        lastFullRunAt = Date.now();
        await sleep(fastPollMs);
      } else {
        await sleep(fastPollMs);
      }
    } catch (e) {
      console.error("[fdn-bridge]", e instanceof Error ? e.message : e);
      await sleep(intervalMs);
    }
  }
}

main().catch((e) => {
  console.error("[fdn-bridge] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
