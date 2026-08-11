import type { SupabaseClient } from "@supabase/supabase-js";
import { SYNXIS_SESSION_KEY } from "../constants.js";
import { loadSynxisPropertyConfig, resolveSynxisCredentials, type SynxisCredentials } from "../secrets.js";
import { updateAppSettingsJson } from "../supabase.js";
import { SynxisCookieJar, SYNXIS_USER_AGENT, type StoredCookie } from "./cookie-jar.js";
import { clearGmailInbox, waitForSynxisVerificationCode } from "./imap.js";
import { validateSynxisCookieHeader } from "./room-sync.js";

const TIMEOUT_MS = 30_000;
const LOGIN_URL = "https://controlcenter-p2.synxis.com/cc/login.aspx?remoteLogin=1";

export function normalizeSynxisCookieHeader(raw: string): string {
  let header = raw.trim();
  if (/^cookie:\s*/i.test(header)) {
    header = header.replace(/^cookie:\s*/i, "");
  }
  return header.trim();
}

async function loadStoredSession(client: SupabaseClient): Promise<{
  cookieHeader?: string;
  cookies?: StoredCookie[];
} | null> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", SYNXIS_SESSION_KEY)
    .maybeSingle();
  if (error) return null;
  const value = data?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as { cookieHeader?: string; cookies?: StoredCookie[] };
}

async function saveStoredSession(
  client: SupabaseClient,
  jar: SynxisCookieJar,
  source: "manual" | "auto" | "extension" = "auto",
): Promise<void> {
  await updateAppSettingsJson(client, SYNXIS_SESSION_KEY, {
    cookieHeader: jar.toHeaderString(),
    cookies: jar.toStored(),
    refreshedAt: new Date().toISOString(),
    source,
  });
}

function parseLoginInputs(html: string): Record<string, string> {
  const data: Record<string, string> = {};
  const inputRe = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRe.exec(html)) !== null) {
    const tag = match[0];
    const name = tag.match(/\bname=["']([^"']+)["']/i)?.[1];
    const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? "";
    if (name) data[name] = value;
  }
  return data;
}

class SynxisLoginClient {
  constructor(
    private jar: SynxisCookieJar,
    private creds: SynxisCredentials,
  ) {}

  private async fetchWithJar(
    url: string,
    init: RequestInit & { form?: Record<string, string> },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": SYNXIS_USER_AGENT,
      ...(init.headers as Record<string, string> | undefined),
    };

    let body = init.body;
    if (init.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let currentUrl = url;
      for (let hop = 0; hop < 10; hop++) {
        const hopHeaders = { ...headers };
        const cookieHeader = this.jar.cookieHeaderForUrl(currentUrl);
        if (cookieHeader) hopHeaders.Cookie = cookieHeader;

        const response = await fetch(currentUrl, {
          method: init.method ?? "GET",
          headers: hopHeaders,
          body: hop === 0 ? body : undefined,
          signal: controller.signal,
          redirect: "manual",
        });
        this.jar.ingestResponse(response, currentUrl);

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) return response;
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }
        return response;
      }
      throw new Error("SynXis login exceeded redirect limit");
    } finally {
      clearTimeout(timer);
    }
  }

  private async doEmailVerification(securityToken2: string): Promise<string> {
    await clearGmailInbox(this.creds.gmailAddress, this.creds.gmailAppPassword);

    const res1 = await fetch(
      "https://security-p2.synxis.com/shs-security-services/v1/auth/mfa/token",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${securityToken2}`,
        },
        body: JSON.stringify({ Factor: "email", Device: "Email", IPAddress: "192.168.1.1" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res1.ok) throw new Error(`SynXis MFA email request failed (HTTP ${res1.status})`);

    const json1 = (await res1.json()) as { token?: string };
    if (!json1.token) throw new Error("SynXis MFA email request missing token");

    const verificationCode = await waitForSynxisVerificationCode(
      this.creds.gmailAddress,
      this.creds.gmailAppPassword,
      { attempts: 6, delayMs: 5000, sleepBeforeEachAttempt: true },
    );

    const res2 = await fetch(
      "https://security-p2.synxis.com/shs-security-services/v1/auth/mfa/token",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Authorization: `Bearer ${json1.token}`,
        },
        body: JSON.stringify({
          Factor: "email_passcode",
          PassCode: verificationCode,
          IPAddress: "192.168.1.1",
          RememberMe: true,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res2.ok) throw new Error(`SynXis MFA passcode failed (HTTP ${res2.status})`);

    const json2 = (await res2.json()) as { access_token?: string };
    if (!json2.access_token) throw new Error("SynXis MFA passcode missing access_token");
    return json2.access_token;
  }

  async populateCookies(): Promise<void> {
    const loginGet = await this.fetchWithJar(LOGIN_URL, { method: "GET" });
    if (!loginGet.ok) throw new Error(`SynXis login page HTTP ${loginGet.status}`);

    const html = await loginGet.text();
    const form = parseLoginInputs(html);
    form["LoginCntrl$UsernameTextBox"] = this.creds.username;
    form["LoginCntrl$PasswordTextBox"] = this.creds.password;

    await this.fetchWithJar(LOGIN_URL, { method: "POST", form });

    let securityToken2 = this.jar.get("SecurityToken");
    if (!securityToken2) {
      const loginEmail = this.jar.get("LoginEmail");
      if (loginEmail?.startsWith("$shsenc")) securityToken2 = loginEmail;
    }
    if (!securityToken2) {
      throw new Error("SynXis password step failed — check credentials in Admin → Settings");
    }

    const securityToken4 = await this.doEmailVerification(securityToken2);

    await this.fetchWithJar(LOGIN_URL, {
      method: "POST",
      form: { SecurityToken: securityToken4 },
    });

    const iframeUrl =
      `https://sph.synxis.com/pms-web-ui/iframe-login?access_token=${
        encodeURIComponent(securityToken4)
      }&lang=&hotelId=${this.creds.propertyId}&chainId=${this.creds.chainId}&pageId=20082`;

    const iframeGet = await this.fetchWithJar(iframeUrl, {
      method: "GET",
      headers: { Referer: "https://controlcenter-p2.synxis.com" },
    });
    if (!iframeGet.ok) throw new Error(`SynXis iframe-login HTTP ${iframeGet.status}`);

    const contextSave = await fetch(
      "https://sph.synxis.com/pms-web-ui/service/v1/auth/context/save",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          Referer: iframeUrl,
          Cookie: this.jar.cookieHeaderForUrl(
            "https://sph.synxis.com/pms-web-ui/service/v1/auth/context/save",
          ),
        },
        body: JSON.stringify({
          payload: {
            token: securityToken4,
            chainId: this.creds.chainId,
            hotelId: this.creds.propertyId,
            pageId: "20082",
            isIframeLogin: true,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!contextSave.ok) throw new Error(`SynXis auth/context/save HTTP ${contextSave.status}`);
    this.jar.ingestResponse(contextSave, contextSave.url);

    const dashboardGet = await this.fetchWithJar(
      "https://sph.synxis.com/pms-web-ui/guest-mgt/dashboard?PropertyChanged",
      { method: "GET", headers: { referer: iframeUrl } },
    );
    if (!dashboardGet.ok) throw new Error(`SynXis dashboard HTTP ${dashboardGet.status}`);

    const contextPost = await fetch(
      "https://sph.synxis.com/pms-web-ui/service/v1/user/context",
      {
        method: "POST",
        headers: {
          "User-Agent": SYNXIS_USER_AGENT,
          "Content-Type": "application/json",
          referer: "https://sph.synxis.com/pms-web-ui/guest-mgt/dashboard?PropertyChanged",
          TIMESTAMP: String(Date.now()),
          Cookie: this.jar.cookieHeaderForUrl(
            "https://sph.synxis.com/pms-web-ui/service/v1/user/context",
          ),
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!contextPost.ok) throw new Error(`SynXis user/context HTTP ${contextPost.status}`);
    this.jar.ingestResponse(contextPost, contextPost.url);
  }
}

/** Script login fallback — credentials + Gmail MFA. */
export async function loginSynxisWithCredentials(client: SupabaseClient): Promise<string> {
  const propertyConfig = await loadSynxisPropertyConfig(client);
  const creds = await resolveSynxisCredentials(client);
  if (!creds) {
    throw new Error("SynXis credentials not configured in Admin → Settings");
  }

  const stored = await loadStoredSession(client);
  const jar = new SynxisCookieJar();
  if (stored?.cookies?.length) jar.loadStored(stored.cookies);

  const loginClient = new SynxisLoginClient(jar, creds);
  await loginClient.populateCookies();

  const cookieHeader = jar.toHeaderString();
  if (!cookieHeader) throw new Error("SynXis login completed but no cookies captured");

  if (!(await validateSynxisCookieHeader(cookieHeader, propertyConfig))) {
    throw new Error("SynXis login completed but session validation failed");
  }

  await saveStoredSession(client, jar, "auto");
  return cookieHeader;
}
