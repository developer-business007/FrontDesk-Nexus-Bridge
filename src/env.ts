/** Prefer IPv4 — many VPS hosts have broken IPv6 and Node fetch fails silently. */
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

export type SupabaseEnv = {
  url: string;
  serviceRoleKey: string;
};

function pickEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeSupabaseUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, "");
}

export function loadSupabaseEnv(): SupabaseEnv {
  const urlRaw = pickEnv("SUPABASE_URL", "VITE_SUPABASE_URL");
  const serviceRoleKey = pickEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
    "SERVICE_ROLE_KEY",
  );

  if (!urlRaw) {
    throw new Error(
      "Missing SUPABASE_URL in bridge/.env (not VITE_SUPABASE_ANON_KEY — use the project URL + service role key)",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY in bridge/.env (Supabase Dashboard → Settings → API → service_role secret)",
    );
  }
  if (serviceRoleKey.startsWith("eyJ") === false && serviceRoleKey.length < 40) {
    console.warn(
      "[fdn-bridge] SUPABASE_SERVICE_ROLE_KEY looks short — ensure you use service_role, not anon/publishable key",
    );
  }

  const url = normalizeSupabaseUrl(urlRaw);
  if (!url.includes("supabase.co") && !url.includes("supabase.in")) {
    console.warn(`[fdn-bridge] Unusual SUPABASE_URL host: ${url}`);
  }

  return { url, serviceRoleKey };
}
