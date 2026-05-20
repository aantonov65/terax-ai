import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const AUTH_SERVICE = "wwx-auth";
const ACCESS_TOKEN = "access_token";
const REFRESH_TOKEN = "refresh_token";
const ID_TOKEN = "id_token";
const EXPIRES_AT = "expires_at";

export type WwxAuthSession = {
  accessToken: string;
  idToken?: string | null;
  expiresAt: number;
};

export type WwxMe = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    workspace_id: string;
    desktop_client_version: string | null;
  };
};

export function wwxApiUrl(): string | null {
  return stringEnv("VITE_WWX_API_URL")?.replace(/\/+$/, "") ?? null;
}

export function wwxWorkspaceId(): string {
  return stringEnv("VITE_WWX_WORKSPACE_ID") ?? "ws_default";
}

export function hostedRuntimeMode(): "auto" | "hosted" | "local" {
  const raw = stringEnv("VITE_WWX_RUNTIME_MODE");
  return raw === "hosted" || raw === "local" ? raw : "auto";
}

export function hostedRuntimeConfigured(): boolean {
  return Boolean(wwxApiUrl()) && hostedRuntimeMode() !== "local";
}

export async function getWwxAuthSession(): Promise<WwxAuthSession | null> {
  const [accessToken, idToken, expiresAtRaw] = await getSecrets([ACCESS_TOKEN, ID_TOKEN, EXPIRES_AT]);
  if (!accessToken) return null;
  const expiresAt = Number.parseInt(expiresAtRaw ?? "0", 10);
  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000) {
    return { accessToken, idToken, expiresAt };
  }
  return refreshWwxAuthSession();
}

export async function requireWwxAuthSession(): Promise<WwxAuthSession> {
  const session = await getWwxAuthSession();
  if (session) return session;
  return signInWithClerkPkce();
}

export async function signOutWwx(): Promise<void> {
  await Promise.all([ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN, EXPIRES_AT].map((account) =>
    invoke("secrets_delete", { service: AUTH_SERVICE, account }).catch(() => undefined)
  ));
}

export async function signInWithClerkPkce(): Promise<WwxAuthSession> {
  const issuer = stringEnv("VITE_WWX_AUTH_ISSUER") ?? stringEnv("VITE_CLERK_ISSUER");
  const clientId = stringEnv("VITE_WWX_AUTH_CLIENT_ID") ?? stringEnv("VITE_CLERK_CLIENT_ID");
  if (!issuer || !clientId) {
    throw new Error("Hosted auth is not configured. Set VITE_WWX_AUTH_ISSUER and VITE_WWX_AUTH_CLIENT_ID.");
  }
  const redirectPort = Number.parseInt(stringEnv("VITE_WWX_AUTH_REDIRECT_PORT") ?? "17891", 10);
  const redirectUri = stringEnv("VITE_WWX_AUTH_REDIRECT_URI") ?? `http://127.0.0.1:${redirectPort}/auth/callback`;
  const discovery = await discoverOidc(issuer);
  const verifier = randomUrlSafe(64);
  const challenge = await pkceChallenge(verifier);
  const state = randomUrlSafe(32);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: wwxAuthScope(),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const callback = invoke<string>("wwx_auth_listen_once", {
    port: redirectPort,
    timeoutMs: 120_000,
  });
  await openUrl(`${discovery.authorization_endpoint}?${params.toString()}`);
  const query = await callback;
  const result = new URLSearchParams(query);
  const error = result.get("error");
  if (error) throw new Error(result.get("error_description") ?? error);
  if (result.get("state") !== state) throw new Error("Auth state mismatch.");
  const code = result.get("code");
  if (!code) throw new Error("Auth code was not returned.");
  return exchangeToken(discovery.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
}

export async function wwxAuthHeaders(): Promise<Record<string, string>> {
  const session = await requireWwxAuthSession();
  return {
    authorization: `Bearer ${session.accessToken}`,
    "x-workspace-id": wwxWorkspaceId(),
    "x-client-version": stringEnv("VITE_WWX_CLIENT_VERSION") ?? "0.1.0",
  };
}

export async function getWwxMe(): Promise<WwxMe> {
  const session = await getWwxAuthSession();
  if (!session) throw new Error("Not signed in.");
  const baseUrl = wwxApiUrl();
  if (!baseUrl) throw new Error("Hosted WWX API is not configured.");
  const response = await httpRequest(`${baseUrl}/me`, "GET", {
    authorization: `Bearer ${session.accessToken}`,
    "x-workspace-id": wwxWorkspaceId(),
    "x-client-version": stringEnv("VITE_WWX_CLIENT_VERSION") ?? "0.1.0",
  });
  if (response.status === 401 || response.status === 403) {
    await signOutWwx();
    throw new Error("Sign-in is required for this WWX workspace.");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Hosted session check failed with ${response.status}.`);
  }
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(response.body))) as WwxMe;
}

async function refreshWwxAuthSession(): Promise<WwxAuthSession | null> {
  const refreshToken = (await getSecrets([REFRESH_TOKEN]))[0];
  const issuer = stringEnv("VITE_WWX_AUTH_ISSUER") ?? stringEnv("VITE_CLERK_ISSUER");
  const clientId = stringEnv("VITE_WWX_AUTH_CLIENT_ID") ?? stringEnv("VITE_CLERK_CLIENT_ID");
  if (!refreshToken || !issuer || !clientId) return null;
  try {
    const discovery = await discoverOidc(issuer);
    return await exchangeToken(discovery.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });
  } catch {
    await signOutWwx();
    return null;
  }
}

function wwxAuthScope(): string {
  const raw = stringEnv("VITE_WWX_AUTH_SCOPE") ?? "profile email";
  const scopes = raw
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .filter((scope) => scope !== "openid" && scope !== "offline_access");
  return [...new Set(scopes.length ? scopes : ["profile", "email"])].join(" ");
}

async function exchangeToken(tokenEndpoint: string, body: Record<string, string>): Promise<WwxAuthSession> {
  const response = await httpRequest(tokenEndpoint, "POST", {
    "content-type": "application/x-www-form-urlencoded",
  }, new TextEncoder().encode(new URLSearchParams(body).toString()));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Token exchange failed with ${response.status}.`);
  }
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(response.body))) as Record<string, unknown>;
  const accessToken = stringValue(json.access_token) ?? stringValue(json.id_token);
  if (!accessToken) throw new Error("Token exchange did not return a bearer token.");
  const idToken = stringValue(json.id_token);
  const refreshToken = stringValue(json.refresh_token);
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const expiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  await invoke("secrets_set", { service: AUTH_SERVICE, account: ACCESS_TOKEN, password: accessToken });
  await invoke("secrets_set", { service: AUTH_SERVICE, account: EXPIRES_AT, password: String(expiresAt) });
  if (idToken) await invoke("secrets_set", { service: AUTH_SERVICE, account: ID_TOKEN, password: idToken });
  if (refreshToken) await invoke("secrets_set", { service: AUTH_SERVICE, account: REFRESH_TOKEN, password: refreshToken });
  return { accessToken, idToken, expiresAt };
}

async function discoverOidc(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const base = issuer.replace(/\/+$/, "");
  const response = await httpRequest(`${base}/.well-known/openid-configuration`, "GET");
  if (response.status < 200 || response.status >= 300) throw new Error(`OIDC discovery failed with ${response.status}.`);
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(response.body))) as Record<string, unknown>;
  const authorizationEndpoint = stringValue(json.authorization_endpoint);
  const tokenEndpoint = stringValue(json.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("OIDC discovery is missing authorization or token endpoints.");
  return { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint };
}

async function httpRequest(
  url: string,
  method: string,
  headers?: Record<string, string>,
  body?: Uint8Array,
): Promise<{ status: number; headers: Record<string, string>; body: number[] }> {
  return invoke("ai_http_request", {
    url,
    method,
    headers,
    body: body ? Array.from(body) : undefined,
  });
}

async function getSecrets(accounts: string[]): Promise<Array<string | null>> {
  return invoke("secrets_get_all", { service: AUTH_SERVICE, accounts });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function randomUrlSafe(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringEnv(name: string): string | null {
  const value = import.meta.env[name] as string | undefined;
  return value?.trim() || null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
