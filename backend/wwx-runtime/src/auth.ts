import type { FastifyRequest } from "fastify";
import type { ObservabilityClient, UserRecord, UserRole } from "../../../packages/observability/src/index.js";

export type AuthContext = {
  workspaceId: string;
  user: UserRecord;
  role: UserRole;
  correlationId: string | null;
  clientVersion: string | null;
};

export async function authenticateRequest(
  request: FastifyRequest,
  observability: ObservabilityClient,
): Promise<AuthContext> {
  const authHeader = request.headers.authorization?.toString() ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const clientVersion = headerValue(request, "x-client-version");
  const correlationId = headerValue(request, "x-correlation-id");
  const workspaceId = headerValue(request, "x-workspace-id")
    ?? process.env.WWX_DEFAULT_WORKSPACE_ID
    ?? "ws_default";

  if (bearer && process.env.CLERK_SECRET_KEY) {
    const token = await verifyClerkOAuthAccessToken(bearer, process.env.CLERK_SECRET_KEY);
    const profile = await getClerkUserProfile(token.subject, process.env.CLERK_SECRET_KEY);
    const role = coerceRole(profile.role);
    const user = await observability.upsertUser({
      workspaceId,
      authProvider: "clerk",
      authSubject: token.subject,
      email: profile.email ?? `${token.subject}@clerk.local`,
      name: profile.name,
      role,
      desktopClientVersion: clientVersion,
    });
    return {
      workspaceId: user.workspaceId,
      user,
      role: user.role,
      correlationId,
      clientVersion,
    };
  }

  if (process.env.CLERK_SECRET_KEY && !bearer) {
    throw publicError("AUTH_REQUIRED", 401);
  }

  const authSubject = headerValue(request, "x-user-id") ?? "dev-user";
  const role = coerceRole(headerValue(request, "x-user-role") ?? "operator");
  const user = await observability.upsertUser({
    workspaceId,
    authProvider: "dev",
    authSubject,
    email: headerValue(request, "x-user-email") ?? `${authSubject}@wwx.local`,
    name: headerValue(request, "x-user-name"),
    role,
    desktopClientVersion: clientVersion,
  });
  return {
    workspaceId,
    user,
    role: user.role,
    correlationId,
    clientVersion,
  };
}

export function requireAdmin(auth: AuthContext): void {
  if (auth.role !== "owner" && auth.role !== "admin") {
    throw publicError("ADMIN_REQUIRED", 403);
  }
}

export function publicError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.toString().trim() || null;
}

function coerceRole(value: string | null | undefined): UserRole {
  return value === "owner" || value === "admin" || value === "viewer" || value === "operator" ? value : "operator";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNestedString(value: Record<string, unknown>, path: string[]): string | null {
  let cursor: unknown = value;
  for (const part of path) {
    if (!cursor || typeof cursor !== "object" || !(part in cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return readString(cursor);
}

type ClerkOAuthTokenVerification = {
  subject: string;
  scopes: string[];
  expired: boolean;
  revoked: boolean;
};

async function verifyClerkOAuthAccessToken(accessToken: string, secretKey: string): Promise<ClerkOAuthTokenVerification> {
  let response: Response;
  try {
    response = await fetch("https://api.clerk.com/oauth_applications/access_tokens/verify", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secretKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch {
    throw publicError("AUTH_PROVIDER_UNAVAILABLE", 503);
  }

  if (!response.ok) {
    throw publicError("AUTH_INVALID_TOKEN", 401);
  }

  const payload = await safeJson(response);
  if (!payload || typeof payload !== "object") {
    throw publicError("AUTH_INVALID_TOKEN", 401);
  }

  const record = payload as Record<string, unknown>;
  if (record.active === false || record.expired === true || record.revoked === true) {
    throw publicError("AUTH_INVALID_TOKEN", 401);
  }

  const subject = readString(record.subject);
  if (!subject) {
    throw publicError("AUTH_INVALID_TOKEN", 401);
  }

  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];

  return {
    subject,
    scopes,
    expired: record.expired === true,
    revoked: record.revoked === true,
  };
}

type ClerkUserProfile = {
  email: string | null;
  name: string | null;
  role: string | null;
};

async function getClerkUserProfile(userId: string, secretKey: string): Promise<ClerkUserProfile> {
  let response: Response;
  try {
    response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: {
        authorization: `Bearer ${secretKey}`,
        accept: "application/json",
      },
    });
  } catch {
    return { email: null, name: null, role: null };
  }

  if (!response.ok) {
    return { email: null, name: null, role: null };
  }

  const payload = await safeJson(response);
  if (!payload || typeof payload !== "object") {
    return { email: null, name: null, role: null };
  }

  const record = payload as Record<string, unknown>;
  const primaryEmailId = readString(record.primary_email_address_id);
  const emails = Array.isArray(record.email_addresses) ? record.email_addresses : [];
  const primaryEmail = emails
    .filter((email): email is Record<string, unknown> => Boolean(email) && typeof email === "object")
    .find((email) => readString(email.id) === primaryEmailId);
  const firstEmail = emails.find((email): email is Record<string, unknown> => Boolean(email) && typeof email === "object");
  const email = readString(primaryEmail?.email_address) ?? readString(firstEmail?.email_address);
  const firstName = readString(record.first_name);
  const lastName = readString(record.last_name);
  const joinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = readString(record.full_name) ?? (joinedName || null);
  const role = readNestedString(record, ["public_metadata", "role"]) ?? readNestedString(record, ["private_metadata", "role"]);

  return { email, name, role };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
