import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EZEE_INTEGRATION_KEY,
  SYNXIS_INTEGRATION_KEY,
} from "./constants.js";

export type EncryptedPayload = {
  v: 1;
  alg: "AES-256-GCM";
  iv: string;
  ciphertext: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.v === 1 &&
    o.alg === "AES-256-GCM" &&
    typeof o.iv === "string" &&
    typeof o.ciphertext === "string"
  );
}

async function getSecretsKey(): Promise<CryptoKey> {
  const b64 = process.env.EZEE_SECRETS_KEY?.trim();
  if (!b64) throw new Error("EZEE_SECRETS_KEY is not configured in bridge/.env");
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error("EZEE_SECRETS_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
}

export async function decryptSecret(payload: EncryptedPayload): Promise<string> {
  const key = await getSecretsKey();
  const iv = Buffer.from(payload.iv, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { authCode?: string };
  const value = parsed.authCode?.trim();
  if (!value) throw new Error("Decrypted secret is empty");
  return value;
}

export type SynxisPropertyConfig = {
  propertyId: string;
  chainId: string;
};

export async function loadSynxisPropertyConfig(
  client: SupabaseClient,
): Promise<SynxisPropertyConfig> {
  const integration = await loadSynxisIntegration(client);
  return {
    propertyId: integration?.propertyId ?? process.env.SYNXIS_PROPERTY_ID?.trim() ?? "93302",
    chainId: integration?.chainId ?? process.env.SYNXIS_CHAIN_ID?.trim() ?? "5136",
  };
}

type SynxisIntegrationValue = {
  username: string;
  passwordEncrypted: EncryptedPayload | null;
  gmailAddress: string;
  gmailAppPasswordEncrypted: EncryptedPayload | null;
  propertyId: string;
  chainId: string;
  shsTag: string;
};

async function loadSynxisIntegration(client: SupabaseClient): Promise<SynxisIntegrationValue | null> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", SYNXIS_INTEGRATION_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const raw = data?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const username = typeof o.username === "string" ? o.username.trim() : "";
  const gmailAddress = typeof o.gmailAddress === "string" ? o.gmailAddress.trim() : "";
  if (!username || !gmailAddress) return null;

  return {
    username,
    passwordEncrypted: isEncryptedPayload(o.passwordEncrypted) ? o.passwordEncrypted : null,
    gmailAddress,
    gmailAppPasswordEncrypted: isEncryptedPayload(o.gmailAppPasswordEncrypted)
      ? o.gmailAppPasswordEncrypted
      : null,
    propertyId: typeof o.propertyId === "string" && o.propertyId.trim() ? o.propertyId.trim() : "93302",
    chainId: typeof o.chainId === "string" && o.chainId.trim() ? o.chainId.trim() : "5136",
    shsTag:
      typeof o.shsTag === "string" && o.shsTag.trim()
        ? o.shsTag.trim()
        : "3d41862e94058d16432e263a354fe8c1",
  };
}

export type SynxisCredentials = {
  username: string;
  password: string;
  gmailAddress: string;
  gmailAppPassword: string;
  propertyId: string;
  chainId: string;
  shsTag: string;
};

export async function resolveSynxisCredentials(
  client: SupabaseClient,
): Promise<SynxisCredentials | null> {
  const integration = await loadSynxisIntegration(client);
  if (integration?.passwordEncrypted && integration.gmailAppPasswordEncrypted) {
    const password = await decryptSecret(integration.passwordEncrypted);
    const gmailAppPassword = await decryptSecret(integration.gmailAppPasswordEncrypted);
    return {
      username: integration.username,
      password,
      gmailAddress: integration.gmailAddress,
      gmailAppPassword,
      propertyId: integration.propertyId,
      chainId: integration.chainId,
      shsTag: integration.shsTag,
    };
  }

  const username = process.env.SYNXIS_USERNAME?.trim();
  const password = process.env.SYNXIS_PASSWORD?.trim();
  const gmailAddress = process.env.SYNXIS_GMAIL_ADDRESS?.trim();
  const gmailAppPassword = process.env.SYNXIS_GMAIL_APP_PASSWORD?.trim();
  if (!username || !password || !gmailAddress || !gmailAppPassword) return null;

  return {
    username,
    password,
    gmailAddress,
    gmailAppPassword,
    propertyId: process.env.SYNXIS_PROPERTY_ID?.trim() || "93302",
    chainId: process.env.SYNXIS_CHAIN_ID?.trim() || "5136",
    shsTag: process.env.SYNXIS_SHS_TAG?.trim() || "3d41862e94058d16432e263a354fe8c1",
  };
}

export async function resolveEzeeCredentials(
  client: SupabaseClient,
): Promise<{ hotelCode: number; authCode: string } | null> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", EZEE_INTEGRATION_KEY)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const raw = data?.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const hotelCode = Number(o.hotelCode);
  if (!Number.isFinite(hotelCode) || hotelCode <= 0) return null;
  if (!isEncryptedPayload(o.authCodeEncrypted)) return null;

  const authCode = await decryptSecret(o.authCodeEncrypted);
  return { hotelCode, authCode };
}
