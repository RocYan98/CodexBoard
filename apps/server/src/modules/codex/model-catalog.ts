import { z } from "zod";

export const ModelsSchema = z.object({
  nextCursor: z.string().nullish(),
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      defaultReasoningEffort: z.string(),
      serviceTiers: z
        .array(z.object({ id: z.string(), name: z.string(), description: z.string().nullish() }))
        .default([]),
    }),
  ),
});

// Consume every page for both the picker and draft validation.
export async function readModelCatalog(
  request: (method: string, params: unknown) => Promise<unknown>,
) {
  const data: z.infer<typeof ModelsSchema>["data"] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = ModelsSchema.parse(
      await request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    data.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("模型目录分页游标重复");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { data: [...new Map(data.map((model) => [model.model, model])).values()] };
}
