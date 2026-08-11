function errorCauseChain(err: unknown): string[] {
  const lines: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i++) {
    if (current instanceof Error) {
      lines.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "object" && current && "code" in current) {
      const o = current as { code?: string; message?: string };
      lines.push([o.code, o.message].filter(Boolean).join(": "));
      break;
    } else {
      lines.push(String(current));
      break;
    }
  }
  return lines.filter(Boolean);
}

export function formatNetworkError(label: string, target: string, err: unknown): string {
  const chain = errorCauseChain(err);
  const detail = chain.length ? chain.join(" → ") : String(err);
  return `${label} network error (${target}): ${detail}. Check bridge/.env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, VPS outbound HTTPS (port 443), and DNS.`;
}

/** Any HTTP response (even 401) means TCP/TLS to Supabase works. */
export async function probeSupabaseReachability(url: string, apiKey: string): Promise<void> {
  const base = url.replace(/\/+$/, "");
  const probeUrl = `${base}/rest/v1/rooms?select=room_number&limit=1`;

  try {
    const res = await fetch(probeUrl, {
      method: "GET",
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Supabase rejected the service role key (HTTP ${res.status}). Copy service_role from Supabase Dashboard → Settings → API.`,
      );
    }

    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => "");
      throw new Error(`Supabase HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("service role key")) throw e;
    if (e instanceof Error && e.message.startsWith("Supabase HTTP")) throw e;
    throw new Error(formatNetworkError("Supabase", base, e));
  }
}
