import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "CONFIG_INVALID",
  "CSRF_INVALID",
  "DATABASE_ERROR",
  "DUPLICATE_REQUEST",
  "REMOTE_UNAVAILABLE",
  "REMOTE_RESULT_UNKNOWN",
  "FORBIDDEN",
  "INTERNAL_ERROR",
  "INVALID_REQUEST",
  "MIGRATION_FAILED",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "UPSTREAM_ERROR",
  "VERSION_CONFLICT",
]);

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
