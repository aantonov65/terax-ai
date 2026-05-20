import * as Sentry from "@sentry/node";
import { sanitizeTelemetryPayload } from "../../../packages/observability/src/index.js";

let initialized = false;

export function initSentry(): void {
  if (initialized || !process.env.SENTRY_DSN) return;
  initialized = true;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.WWX_RELEASE,
    beforeSend(event) {
      const sanitized = sanitizeTelemetryPayload(event as unknown);
      return sanitized as unknown as typeof event;
    },
  });
}

export function captureRuntimeException(error: unknown, context: Record<string, unknown> = {}): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    const sanitized = sanitizeTelemetryPayload(context);
    for (const [key, value] of Object.entries(sanitized)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        scope.setTag(key, String(value));
      } else {
        scope.setContext(key, value as Record<string, unknown>);
      }
    }
    Sentry.captureException(error);
  });
}
