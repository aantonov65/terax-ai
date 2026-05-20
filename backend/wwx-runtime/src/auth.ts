import { verifyToken } from "@clerk/backend";
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
    const claims = await verifyToken(bearer, {
      secretKey: process.env.CLERK_SECRET_KEY,
      audience: process.env.CLERK_JWT_AUDIENCE || undefined,
    });
    const claimRecord = claims as Record<string, unknown>;
    const role = coerceRole(readNestedString(claimRecord, ["public_metadata", "role"]) ?? readNestedString(claimRecord, ["metadata", "role"]));
    const user = await observability.upsertUser({
      workspaceId: readString(claimRecord.org_id) ?? workspaceId,
      authProvider: "clerk",
      authSubject: String(claimRecord.sub),
      email: readString(claimRecord.email) ?? readString(claimRecord.email_address) ?? `${String(claimRecord.sub)}@clerk.local`,
      name: readString(claimRecord.name) ?? null,
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
