import { RemoteApprovalSchema, RemoteApprovalContentSchema } from "./remote-approvals.js";
import { z } from "zod";

export const RemoteThreadSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  preview: z.string(),
  cwd: z.string(),
  updatedAt: z.number(),
  recencyAt: z.number().optional(),
  projectId: z.string().nullable().optional(),
  desktopOrder: z.number().int().optional(),
  status: z.string(),
});
export const RemoteThreadListSchema = z.object({
  threads: z.array(RemoteThreadSummarySchema),
  nextCursor: z.string().nullable(),
});
export const RemoteQuestionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  isSecret: z.boolean(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
});
export const RemoteRequestSchema = z.object({
  approval: RemoteApprovalSchema.optional(),
  id: z.union([z.string(), z.number()]),
  kind: z.enum(["command", "file", "permissions", "input", "elicitation", "unsupported"]),
  permissionReason: z.string().optional(),
  permissionDescription: z.string().optional(),
  permissionCwd: z.string().optional(),
  permissionToken: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  title: z.string(),
  detail: z.string(),
  questions: z.array(RemoteQuestionSchema),
  decisions: z.array(z.enum(["accept", "acceptForSession", "decline", "cancel"])),
});
export const RemoteAttachmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().positive(),
});
export type RemoteAttachment = z.infer<typeof RemoteAttachmentSchema>;

export const RemoteQueueSchema = z.object({
  available: z.boolean(),
  token: z.string().nullable(),
  messages: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      createdAt: z.number(),
      pausedReason: z.string().nullable(),
      canEdit: z.boolean(),
      canSteer: z.boolean(),
      attachments: z.array(RemoteAttachmentSchema).max(8).optional(),
    }),
  ),
});
export const RemoteThreadSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  cwd: z.string(),
  model: z.string(),
  effort: z.string(),
  status: z.string(),
  activeTurnId: z.string().nullable(),
  historyComplete: z.boolean(),
  turns: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      startedAtMs: z.number().nullable().optional(),
      durationMs: z.number().nonnegative().nullable().optional(),
      workDurationMs: z.number().nonnegative().nullable().optional(),
      diff: z.string(),
      error: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          text: z.string(),
          detail: z.string(),
          asyncQuestions: z
            .array(
              z.object({
                id: z.string(),
                title: z.string(),
                options: z.array(z.string()),
                answer: z.string().nullable(),
              }),
            )
            .optional(),
          phase: z.string().optional(),
          status: z.string().optional(),
          durationMs: z.number().nonnegative().nullable().optional(),
          exitCode: z.number().nullable().optional(),
          commandActions: z
            .array(
              z.object({
                type: z.enum(["read", "listFiles", "search", "unknown"]),
                command: z.string(),
                name: z.string(),
                path: z.string(),
                query: z.string(),
              }),
            )
            .optional(),
          images: z
            .array(z.object({ index: z.number().int().nonnegative(), name: z.string() }))
            .optional(),
          sections: z.array(z.object({ title: z.string(), text: z.string() })).optional(),
        }),
      ),
    }),
  ),
  editableMessage: z
    .object({ turnId: z.string(), itemId: z.string(), token: z.string() })
    .nullable()
    .optional(),
  requests: z.array(RemoteRequestSchema),
  queue: RemoteQueueSchema.optional(),
});
export const RemoteModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  efforts: z.array(z.string()),
  defaultEffort: z.string(),
  isDefault: z.boolean().optional(),
  defaultPresets: z
    .array(z.object({ effort: z.string(), order: z.number().int().nonnegative() }))
    .optional(),
  serviceTiers: z
    .array(z.object({ id: z.string(), name: z.string(), description: z.string().nullish() }))
    .default([]),
});
export const RemoteActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("send"),
    text: z.string().trim().max(100_000),
    attachments: z.array(z.uuid()).max(8).optional(),
    approvalMode: z.enum(["ask", "auto", "full"]).optional(),
    model: z.string().min(1).max(160).optional(),
    effort: z.string().min(1).max(30).optional(),
    serviceTier: z.string().min(1).max(80).nullable().optional(),
  }),
  z.strictObject({ type: z.literal("stop"), turnId: z.string().min(1).max(200) }),
  z.strictObject({
    type: z.literal("steer"),
    turnId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.strictObject({
    type: z.literal("queue"),
    operation: z.enum(["append", "edit", "take", "cancel", "steer"]),
    queueToken: z.string().regex(/^[a-f0-9]{64}$/),
    turnId: z.string().min(1).max(200).optional(),
    messageId: z.string().min(1).max(200).optional(),
    beforeMessageId: z.string().min(1).max(200).optional(),
    text: z.string().trim().max(100000).optional(),
    attachments: z.array(z.uuid()).max(8).optional(),
  }),
  z.strictObject({
    type: z.literal("edit"),
    turnId: z.string().min(1).max(200),
    editToken: z.string().regex(/^[a-f0-9]{64}$/),
    text: z.string().trim().min(1).max(100000),
  }),
  z.strictObject({
    type: z.literal("answer"),
    itemId: z.string().min(1).max(300),
    answers: z.record(z.string().max(500), z.string().trim().min(1).max(10000)),
  }),
  z.strictObject({ type: z.literal("compact") }),
  z.strictObject({
    type: z.literal("rename"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[^\r\n]+$/),
  }),
  z.strictObject({ type: z.literal("history") }),
  z.strictObject({
    type: z.literal("respond"),
    approvalToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    approvalChoice: z.string().max(100).optional(),
    content: RemoteApprovalContentSchema.optional(),
    requestId: z.union([z.string().max(200), z.number().int()]),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]).optional(),
    permissionToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    answers: z
      .record(z.string().max(200), z.array(z.string().max(10_000)).min(1).max(20))
      .optional(),
  }),
]);
export const RemoteCreateSchema = z.strictObject({ projectId: z.uuid().nullable() });
export const REMOTE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const REMOTE_UPLOAD_MAX_BASE64_LENGTH = Math.ceil(REMOTE_UPLOAD_MAX_BYTES / 3) * 4;

export const RemoteUploadSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(180)
    .refine(
      (name) =>
        ![...name].some(
          (char) =>
            char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === "/" || char === "\\",
        ),
    ),
  mimeType: z.string().max(120),
  base64: z.string().min(1).max(REMOTE_UPLOAD_MAX_BASE64_LENGTH),
});
export type RemoteThreadSummary = z.infer<typeof RemoteThreadSummarySchema>;
export type RemoteThread = z.infer<typeof RemoteThreadSchema>;
export type RemoteRequest = z.infer<typeof RemoteRequestSchema>;
export type RemoteAction = z.infer<typeof RemoteActionSchema>;
export type RemoteModel = z.infer<typeof RemoteModelSchema>;

export const RemoteReviewScopeSchema = z.enum(["unstaged", "staged", "branch", "turn"]);
export const RemoteReviewFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum([
    "added",
    "deleted",
    "modified",
    "renamed",
    "copied",
    "conflicted",
    "untracked",
    "unchanged",
  ]),
  added: z.number().nonnegative().nullable(),
  removed: z.number().nonnegative().nullable(),
  binary: z.boolean(),
});
export const RemoteReviewSchema = z.object({
  repository: z.boolean(),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  scope: RemoteReviewScopeSchema,
  changedCount: z.number().int().nonnegative(),
  countsComplete: z.boolean(),
  added: z.number().nonnegative(),
  removed: z.number().nonnegative(),
  message: z.string(),
  files: z.array(RemoteReviewFileSchema),
});
export const RemoteReviewContentSchema = z.object({
  file: RemoteReviewFileSchema,
  patch: z.string(),
  content: z.string(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  message: z.string(),
  contentLabel: z.string(),
});
export type RemoteReviewScope = z.infer<typeof RemoteReviewScopeSchema>;
export type RemoteReview = z.infer<typeof RemoteReviewSchema>;
export type RemoteReviewFile = z.infer<typeof RemoteReviewFileSchema>;

export const RemoteUsageSchema = z.object({
  windows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      remainingPercent: z.number().min(0).max(100),
      windowDurationMins: z.number().nullable(),
      resetsAt: z.number().nullable(),
    }),
  ),
});
