import { useRef, useState, type SetStateAction } from "react";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { listRemoteModels } from "./remote-api";
import { RemoteAttachmentSchema, type RemoteModel } from "@codexboard/contracts";
const OptionsSchema = z.object({
  approvalMode: z.enum(["ask", "auto", "full"]).default("auto"),
  model: z.string().optional(),
  effort: z.string().optional(),
  selectionMode: z.enum(["default", "model"]).default("default"),
  serviceTier: z.string().nullable().default(null),
  attachments: z.array(RemoteAttachmentSchema).max(8).default([]),
});
export type ComposerOptions = z.infer<typeof OptionsSchema>;
export function readComposerOptions(saved: string | null): ComposerOptions {
  try {
    const raw = JSON.parse(saved ?? "{}");
    const parsed = OptionsSchema.parse(raw);
    if (
      raw.selectionMode === undefined &&
      (parsed.model !== undefined || parsed.effort !== undefined)
    )
      parsed.selectionMode = "model";
    return parsed;
  } catch {
    return OptionsSchema.parse({});
  }
}
// Drafts must outlive the mobile webview. Migrate existing session values once.
export function readRemoteComposerValue(key: string): string | null {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) return saved;
    const legacy = sessionStorage.getItem(key);
    if (legacy !== null) localStorage.setItem(key, legacy);
    return legacy;
  } catch {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }
}
export function writeRemoteComposerValue(key: string, value: string | null) {
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      if (value === null) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch {
      /* Storage restrictions must not freeze the editor. */
    }
  }
}
export function useRemoteDraft(key: string) {
  const [draft, update] = useState(
    () =>
      readRemoteComposerValue(`remote-draft:${key}`) ||
      readRemoteComposerValue(`remote-queue-recovery:${key}`) ||
      "",
  );
  const setDraft = (value: string) => {
    writeRemoteComposerValue(`remote-draft:${key}`, value);
    update(value);
  };
  return [draft, setDraft] as const;
}
export function useRemoteComposerOptions(key: string) {
  const [options, update] = useState<ComposerOptions>(() => {
    const saved = readComposerOptions(readRemoteComposerValue(`remote-options:${key}`));
    if (
      !saved.attachments.length &&
      !readRemoteComposerValue(`remote-draft:${key}`)?.trim() &&
      readRemoteComposerValue(`remote-queue-recovery:${key}`) !== null
    )
      return readComposerOptions(readRemoteComposerValue(`remote-queue-recovery-options:${key}`));
    return saved;
  });
  const current = useRef(options);
  const setOptions = (action: SetStateAction<ComposerOptions>) => {
    const next = typeof action === "function" ? action(current.current) : action;
    current.current = next;
    writeRemoteComposerValue(`remote-options:${key}`, JSON.stringify(next));
    update(next);
  };
  const catalog = useQuery({
    queryKey: ["remote-models"],
    queryFn: listRemoteModels,
    enabled: options.selectionMode === "default" && options.model !== undefined,
    staleTime: 0,
    retry: false,
  });
  // A saved Default selection must still be in Desktop's current curated set.
  // While it cannot be confirmed, omit overrides and let Desktop choose.
  const resolved =
    options.selectionMode === "default" &&
    options.model &&
    !defaultRemotePresets(catalog.data ?? []).some(
      (p) => p.model === options.model && p.effort === options.effort,
    )
      ? { ...options, model: undefined, effort: undefined, serviceTier: null }
      : options;
  return [resolved, setOptions] as const;
}

// Desktop publishes a curated slider, independent of the full model catalog.
export function defaultRemotePresets(models: RemoteModel[]) {
  return models
    .flatMap((model) =>
      (model.defaultPresets ?? [])
        .filter((p) => model.efforts.includes(p.effort))
        .map((p) => ({ model: model.id, ...p })),
    )
    .sort((a, b) => a.order - b.order)
    .map(({ model, effort }) => ({ model, effort }));
}

export const effortLabels: Record<string, string> = {
  none: "无",
  minimal: "最低",
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
};
