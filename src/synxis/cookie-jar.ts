export type StoredCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

function domainMatches(cookieDomain: string | undefined, host: string): boolean {
  if (!cookieDomain) return true;
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith("." + d);
}

function parseSetCookieHeader(raw: string, requestUrl: string): StoredCookie | null {
  const parts = raw.split(";").map((p) => p.trim());
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf("=");
  if (eq <= 0) return null;

  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name) return null;

  let domain: string | undefined;
  let path = "/";
  for (const attr of attrs) {
    const lower = attr.toLowerCase();
    if (lower.startsWith("domain=")) {
      domain = attr.slice(7).trim();
    } else if (lower.startsWith("path=")) {
      path = attr.slice(5).trim() || "/";
    } else if (lower === "max-age=0" || lower.startsWith("expires=")) {
      return null;
    }
  }

  if (!domain) {
    try {
      domain = new URL(requestUrl).hostname;
    } catch {
      domain = undefined;
    }
  }

  return { name, value, domain, path };
}

export class SynxisCookieJar {
  private cookies = new Map<string, StoredCookie>();

  private key(c: StoredCookie): string {
    return `${c.domain ?? ""}|${c.path ?? "/"}|${c.name}`;
  }

  loadStored(stored: StoredCookie[]): void {
    this.cookies.clear();
    for (const c of stored) {
      if (c.name && c.value != null) {
        this.cookies.set(this.key(c), c);
      }
    }
  }

  ingestResponse(response: Response, requestUrl: string): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : (() => {
            const single = response.headers.get("set-cookie");
            return single ? [single] : [];
          })();

    for (const raw of setCookies) {
      const parsed = parseSetCookieHeader(raw, requestUrl);
      if (parsed) this.cookies.set(this.key(parsed), parsed);
    }
  }

  get(name: string): string | undefined {
    for (const c of this.cookies.values()) {
      if (c.name === name) return c.value;
    }
    return undefined;
  }

  cookieHeaderForUrl(url: string): string {
    let host = "";
    let path = "/";
    try {
      const u = new URL(url);
      host = u.hostname;
      path = u.pathname || "/";
    } catch {
      return "";
    }

    const pairs: string[] = [];
    for (const c of this.cookies.values()) {
      if (!domainMatches(c.domain, host)) continue;
      const cookiePath = c.path ?? "/";
      if (!path.startsWith(cookiePath)) continue;
      pairs.push(`${c.name}=${c.value}`);
    }
    return pairs.join("; ");
  }

  toHeaderString(): string {
    const seen = new Set<string>();
    const pairs: string[] = [];
    for (const c of this.cookies.values()) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      pairs.push(`${c.name}=${c.value}`);
    }
    return pairs.join("; ");
  }

  toStored(): StoredCookie[] {
    return [...this.cookies.values()];
  }
}

export const SYNXIS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
