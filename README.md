# FrontDesk Nexus — VPS Bridge

Copies DualPMS local Postgres (`hotel`) → Supabase. When DualPMS upstream poll is stale,
automatically falls back to live PMS APIs.

## Flow

```
DualPMS polls SynXis/eZee → Postgres sync_time + rooms
         ↓
bridge (PM2 on same VPS)
  • sync_time fresh → copy Postgres (fast)
  • sync_time stale → API fallback:
      SynXis: browser cookie → script login (credentials + Gmail MFA)
      eZee: direct API with stored credentials
         ↓
Supabase → Vercel portal + extension

On each sync, when a room goes **Occupied → Vacant** (guest checkout in PMS), the bridge
auto-calls `hk_mark_room_dirty` so the housekeeping board gets a turnover task.
```

## Setup on VPS

```bash
cd /opt/frontdesk-bridge
cp .env.example .env
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EZEE_SECRETS_KEY
npm install
npm run test
npm run sync
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Env

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key |
| `EZEE_SECRETS_KEY` | yes for fallback | Same as Supabase edge secret |
| `PGDATABASE` | no | Default `hotel` |
| `BRIDGE_INTERVAL_MS` | no | Full sync cycle (default `10000`) |
| `BRIDGE_FAST_POLL_MS` | no | Poll `sync_time` for instant copy (default `2000`) |

## Upstream detection

- DualPMS updates `sync_time` on each successful SynXis/eZee poll (~8–12s).
- If `sync_time` older than **45s**, bridge switches to API fallback automatically.
- Portal shows amber warnings in Settings and Dual PMS board.

## Troubleshooting `TypeError: fetch failed`

This means **Postgres is OK** but the VPS cannot reach Supabase over HTTPS.

1. **Use service role key** in `.env` — not `VITE_SUPABASE_ANON_KEY` from the web app.
2. **Test from VPS:**
   ```bash
   npm run test
   curl -I "https://YOUR_PROJECT_REF.supabase.co/rest/v1/"
   ```
3. **Firewall:** allow outbound TCP 443.
4. **Broken IPv6:** the bridge sets IPv4-first DNS automatically; pull latest code if you still see fetch errors.
5. **Wrong URL:** must be `https://xxxxx.supabase.co` (no trailing path).

## Logs

```bash
pm2 logs fdn-bridge
pm2 restart fdn-bridge
```
