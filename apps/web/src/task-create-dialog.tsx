import { AttachmentCard } from "./attachment-card";
import { RemoteModelSettings } from "./remote-model-settings";
import { RemoteEffortGauge } from "./remote-effort-gauge";
import { readComposerOptions, effortLabels, type ComposerOptions } from "./remote-composer-model";
import { userErrorMessage } from "./user-error";
import { currentAssignee } from "./task-assignee";
import { GitBranch } from "./git-branch-icon";
import { useAttachmentTransfer } from "./use-attachment-transfer";
import { Notice } from "./notification-center";
import { notify } from "./notifications";
import { PersonAvatar } from "./person-avatar";
import { createUuid } from "./random-id";
import type {
  ProjectView,
  TaskPriority,
  TaskRelationCandidate,
  TaskStatus,
  TaskView,
  RemoteModel,
} from "@codexboard/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpToLine,
  Ellipsis,
  FolderKanban,
  Link as LinkIcon,
  ListTree,
  LoaderCircle,
  Maximize2,
  Paperclip,
  Search,
  Tag,
  UserRound,
  X,
} from "./icons";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { createTask, readTaskCreationOptions, uploadAttachment } from "./api";
import { taskMutationInvalidationKeys } from "./event-feed";
import { priorityLabel, statusLabel, useUiCopy } from "./locale";
import { defaultTaskCreationProjectId } from "./project-sync";
import { SfSymbol } from "./sf-symbol";
import { PriorityIcon } from "./priority-icon";
import { TASK_STATUS_META } from "./task-status";
import {
  appendAttachmentFiles,
  fitDialogRectToContent,
  formatBytes,
  filterTaskRelationCandidates,
  isCompactTaskDialogViewport,
  MAX_TASK_LABELS,
  maximizeDialogRect,
  relationCandidateState,
  resizeDialogRect,
  selectedLabelNamesInCatalogOrder,
  toggleSelectedLabelId,
  type DialogRect,
  type ResizeEdge,
} from "./task-create-model";

const STATUSES: readonly TaskStatus[] = ["backlog", "todo"];
const PRIORITIES: readonly TaskPriority[] = ["none", "urgent", "high", "medium", "low"];
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

type OpenPanel = "model" | "priority" | "labels" | "more" | null;
type RelationMenu = "child" | "parent" | "related" | null;

interface AttachmentDraft {
  readonly id: string;
  readonly uploadKey: string;
  readonly file: File;
  readonly previewUrl: string | null;
  readonly error?: string;
}

interface RejectedFile {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

interface PopoverAnchor {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly maxHeight: number;
}

function measurePopoverAnchor(
  trigger: HTMLElement,
  panel: HTMLElement | null,
  alignRight: boolean,
): PopoverAnchor {
  const rect = trigger.getBoundingClientRect();
  const dialog = panel?.getBoundingClientRect();
  const headerBottom = panel
    ?.querySelector<HTMLElement>(".task-create-header")
    ?.getBoundingClientRect().bottom;
  const minimumLeft = (dialog?.left ?? 12) + 12;
  const maximumLeft = Math.max(minimumLeft, (dialog?.right ?? window.innerWidth) - 372);
  const maximumRight = (dialog?.right ?? window.innerWidth - 12) - 12;
  return {
    left: alignRight ? rect.left : Math.max(minimumLeft, Math.min(rect.left, maximumLeft)),
    right: Math.max(12, window.innerWidth - Math.min(rect.right, maximumRight)),
    bottom: Math.max(24, window.innerHeight - rect.top + 8),
    maxHeight: Math.min(230, Math.max(88, rect.top - (headerBottom ?? 0) - 12)),
  };
}

function newIdempotencyKey(): string {
  return createUuid();
}

function errorMessage(error: unknown, fallback: string): string {
  return userErrorMessage(error, fallback);
}

function relationLabel(candidate: TaskRelationCandidate): string {
  return `${candidate.identifier} · ${candidate.title}`;
}

function dialogBounds() {
  return { width: window.innerWidth, height: window.innerHeight, padding: 32 };
}

function initialDialogRect(): DialogRect {
  const bounds = dialogBounds();
  const width = Math.min(704, bounds.width - bounds.padding * 2);
  const height = Math.min(304, bounds.height - bounds.padding * 2);
  return {
    left: Math.round((bounds.width - width) / 2),
    top: Math.round((bounds.height - height) / 2),
    width,
    height,
  };
}

function initialDesktopDialogRect(): DialogRect | undefined {
  if (
    typeof window === "undefined" ||
    isCompactTaskDialogViewport({ width: window.innerWidth, height: window.innerHeight })
  ) {
    return undefined;
  }
  return initialDialogRect();
}

function sameDialogRect(left: DialogRect | undefined, right: DialogRect): boolean {
  return (
    left?.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function pixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function requiredDialogHeight(
  panel: HTMLElement,
  form: HTMLFormElement,
  footer: HTMLElement,
): number {
  const header = panel.querySelector<HTMLElement>(".task-create-header");
  const title = form.querySelector<HTMLElement>(".task-create-title-input");
  const description = form.querySelector<HTMLElement>(".task-create-description-input");
  const attachments = form.querySelector<HTMLElement>(".task-create-attachment-list");
  if (!header || !title || !description) return panel.getBoundingClientRect().height;

  const formStyle = getComputedStyle(form);
  const descriptionStyle = getComputedStyle(description);
  return Math.ceil(
    header.getBoundingClientRect().height +
      pixelValue(formStyle.paddingTop) +
      pixelValue(formStyle.paddingBottom) +
      title.getBoundingClientRect().height +
      pixelValue(descriptionStyle.marginTop) +
      pixelValue(descriptionStyle.minHeight) +
      (attachments?.getBoundingClientRect().height ?? 0) +
      footer.getBoundingClientRect().height,
  );
}

function selectedCandidate(
  candidates: readonly TaskRelationCandidate[],
  id: string,
): TaskRelationCandidate | undefined {
  return candidates.find((candidate) => candidate.id === id);
}

export function TaskCreateDialog({
  open,
  project,
  projects,
  csrfToken,
  mutationsEnabled,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly project: ProjectView;
  readonly projects: readonly ProjectView[];
  readonly csrfToken: string;
  readonly mutationsEnabled: boolean;
  readonly onClose: () => void;
  readonly onCreated: (task: TaskView) => void;
}) {
  const copy = useUiCopy();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const metaStripRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const relationPopoverRef = useRef<HTMLDivElement>(null);
  const relationSubmenuRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const creationSucceededRef = useRef(false);
  const createdTaskRef = useRef<TaskView | undefined>(undefined);
  const taskIdempotencyKeyRef = useRef(newIdempotencyKey());
  const customRectRef = useRef<DialogRect | undefined>(initialDesktopDialogRect());
  const defaultContentHeightRef = useRef<number | undefined>(undefined);
  const expandedRef = useRef(false);
  const resizingRef = useRef(false);
  const attachmentItemsRef = useRef<readonly AttachmentDraft[]>([]);
  const initializedOptionsProjectRef = useRef<string | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const [modelOptions, setModelOptions] = useState<ComposerOptions>();
  const [modelMenu, setModelMenu] = useState<"model" | "models">("models");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [targetProjectId, setTargetProjectId] = useState(() =>
    defaultTaskCreationProjectId(project),
  );
  const [developmentContextId, setDevelopmentContextId] = useState("");
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([]);
  const setInputError = (message?: string) => {
    if (message) notify(message, "error");
  };
  const [parentTaskId, setParentTaskId] = useState("");
  const [childTaskIds, setChildTaskIds] = useState<string[]>([]);
  const [relatedTaskIds, setRelatedTaskIds] = useState<string[]>([]);
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<PopoverAnchor>();
  const [relationMenu, setRelationMenu] = useState<RelationMenu>(null);
  const [relationSearch, setRelationSearch] = useState("");
  const [dialogRect, setDialogRect] = useState<DialogRect | undefined>(initialDesktopDialogRect);
  const [expanded, setExpanded] = useState(false);
  const [attachmentItems, setAttachmentItems] = useState<AttachmentDraft[]>([]);
  const [rejectedFiles, setRejectedFiles] = useState<RejectedFile[]>([]);
  const [createdTask, setCreatedTask] = useState<TaskView>();

  const creationOptions = useQuery({
    queryKey: ["task-creation-options", targetProjectId],
    queryFn: () => readTaskCreationOptions(targetProjectId),
    enabled:
      open &&
      Boolean(targetProjectId) &&
      projects.some((candidate) => candidate.id === targetProjectId && !candidate.archivedAt),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 5_000,
  });

  const candidates = creationOptions.data?.relationCandidates ?? [];
  const catalogLabels = creationOptions.data?.labels ?? [];
  const catalogLabelIds = new Set(catalogLabels.map((label) => label.id));
  const activeSelectedLabelIds = selectedLabelIds.filter((id) => catalogLabelIds.has(id));
  const labels = selectedLabelNamesInCatalogOrder(catalogLabels, activeSelectedLabelIds);
  const effectiveDevelopmentContextId =
    creationOptions.data &&
    developmentContextId !== (creationOptions.data.defaultDevelopmentContext.id ?? "") &&
    !creationOptions.data.developmentContexts.some((context) => context.id === developmentContextId)
      ? (creationOptions.data.defaultDevelopmentContext.id ?? "")
      : developmentContextId;
  const selectedAssignee = currentAssignee(
    creationOptions.data?.assignees ?? [],
    creationOptions.data?.currentIdentity,
  );
  const selectedContext = creationOptions.data?.developmentContexts.find(
    (context) => context.id === effectiveDevelopmentContextId,
  );
  const contextLabel =
    selectedContext?.label ?? creationOptions.data?.defaultDevelopmentContext.label ?? "无";
  const targetProject = projects.find((candidate) => candidate.id === targetProjectId) ?? project;
  const targetProjectAvailable = projects.some(
    (candidate) => candidate.id === targetProjectId && !candidate.archivedAt,
  );

  const completeCreation = (task: TaskView) => {
    creationSucceededRef.current = true;
    for (const queryKey of taskMutationInvalidationKeys(targetProjectId, [
      task.id,
      parentTaskId,
      ...childTaskIds,
      ...relatedTaskIds,
    ])) {
      void queryClient.invalidateQueries({ queryKey });
    }
    void queryClient.invalidateQueries({ queryKey: ["task-creation-options", targetProjectId] });
    onClose();
    onCreated(task);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      setInputError(undefined);
      let task = createdTaskRef.current;
      if (!task) {
        task = await createTask(
          {
            projectId: targetProjectId,
            ...(modelOptions?.model && modelOptions.effort
              ? {
                  modelOptions: {
                    model: modelOptions.model,
                    effort: modelOptions.effort,
                    serviceTier: modelOptions.serviceTier,
                  },
                }
              : {}),
            title,
            description,
            status,
            priority,
            labels,
            assigneeIdentity: selectedAssignee?.identity ?? null,
            developmentContextId: effectiveDevelopmentContextId || null,
            links: [],
            initialRelations: {
              parentTaskId: parentTaskId || null,
              childTaskId: null,
              childTaskIds,
              relatedTaskIds,
            },
          },
          csrfToken,
          taskIdempotencyKeyRef.current,
        );
        createdTaskRef.current = task;
        setCreatedTask(task);
      }

      const failures = new Map<string, string>();
      for (const attachment of attachmentItemsRef.current) {
        try {
          await uploadAttachment(task.id, attachment.file, csrfToken, attachment.uploadKey);
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
          setAttachmentItems((current) => current.filter((item) => item.id !== attachment.id));
        } catch (error: unknown) {
          failures.set(attachment.id, errorMessage(error, "附件上传失败"));
        }
      }
      if (failures.size > 0) {
        setAttachmentItems((current) =>
          current.map((item) => {
            const message = failures.get(item.id);
            return message ? { ...item, error: message } : item;
          }),
        );
      }
      return { task, failures: failures.size };
    },
    onSuccess(result) {
      if (result.failures === 0) completeCreation(result.task);
      else setInputError("任务已创建；部分附件上传失败，请重试或移除失败附件。");
    },
  });

  useEffect(() => {
    attachmentItemsRef.current = attachmentItems;
  }, [attachmentItems]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    const maximum = creationOptions.data?.attachmentMaxBytes;
    if (!maximum) return;
    const oversized = attachmentItemsRef.current.filter((item) => item.file.size > maximum);
    if (oversized.length === 0) return;
    for (const item of oversized) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    const oversizedIds = new Set(oversized.map((item) => item.id));
    setAttachmentItems((current) => current.filter((item) => !oversizedIds.has(item.id)));
    setRejectedFiles((current) => [
      ...current,
      ...oversized.map((item) => ({
        id: newIdempotencyKey(),
        name: item.file.name,
        reason: `文件超过 ${formatBytes(maximum)} 上限`,
      })),
    ]);
  }, [creationOptions.data?.attachmentMaxBytes]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnTarget = returnFocusRef.current;
    if (open) {
      if (!dialog.open) dialog.showModal();
      titleInputRef.current?.focus();
    } else if (dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      queueMicrotask(() => {
        if (
          !creationSucceededRef.current &&
          returnTarget?.isConnected &&
          !returnTarget.hasAttribute("disabled")
        ) {
          returnTarget.focus();
        }
      });
    };
  }, [open]);

  useEffect(
    () => () => {
      for (const item of attachmentItemsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    const data = creationOptions.data;
    if (!data || initializedOptionsProjectRef.current === data.projectId) return;
    initializedOptionsProjectRef.current = data.projectId;
    setDevelopmentContextId(data.defaultDevelopmentContext.id ?? "");
  }, [creationOptions.data]);

  useEffect(() => {
    if (!openPanel) return;
    const closeOnBlank = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-task-popover]") && !target.closest("[data-task-trigger]")) {
        setOpenPanel(null);
        setRelationMenu(null);
        setRelationSearch("");
      }
    };
    document.addEventListener("pointerdown", closeOnBlank);
    return () => document.removeEventListener("pointerdown", closeOnBlank);
  }, [openPanel]);

  useEffect(() => {
    const onResize = () => {
      if (isCompactTaskDialogViewport({ width: window.innerWidth, height: window.innerHeight })) {
        setDialogRect(undefined);
        setExpanded(false);
      } else if (expanded) {
        setDialogRect(maximizeDialogRect(dialogBounds()));
      } else {
        setDialogRect((current) => current ?? customRectRef.current ?? initialDialogRect());
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);

  useEffect(() => {
    const panel = panelRef.current;
    const form = formRef.current;
    const footer = footerRef.current;
    if (!panel || !form || !footer || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const fitContent = () => {
      if (
        expandedRef.current ||
        resizingRef.current ||
        isCompactTaskDialogViewport({ width: window.innerWidth, height: window.innerHeight })
      ) {
        return;
      }
      const baseline = customRectRef.current ?? initialDialogRect();
      const contentHeight = requiredDialogHeight(panel, form, footer);
      if (!creationOptions.isSuccess) return;
      defaultContentHeightRef.current ??= contentHeight;
      const next = fitDialogRectToContent(
        baseline,
        baseline.height + Math.max(0, contentHeight - defaultContentHeightRef.current),
        dialogBounds(),
      );
      setDialogRect((current) => (sameDialogRect(current, next) ? current : next));
    };
    const scheduleFit = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fitContent);
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(form);
    observer.observe(footer);
    observer.observe(metaStripRef.current ?? footer);
    const attachments = form.querySelector<HTMLElement>(".task-create-attachment-list");
    if (attachments) observer.observe(attachments);
    scheduleFit();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const menu = relationPopoverRef.current;
    const submenu = relationSubmenuRef.current;
    if (!relationMenu || !panel || !menu || !submenu) return;

    // Wrapped controls can move the trigger to either side of the dialog.
    // Measure both menus instead of assuming the submenu has room on the right.
    const dialog = panel.getBoundingClientRect();
    const parent = menu.getBoundingClientRect();
    const width = submenu.getBoundingClientRect().width;
    const minimumLeft = dialog.left + 12;
    const maximumLeft = Math.max(minimumLeft, dialog.right - width - 12);
    const desiredLeft =
      parent.right + 6 <= maximumLeft ? parent.right + 6 : parent.left - width - 6;
    const left = Math.max(minimumLeft, Math.min(desiredLeft, maximumLeft));
    submenu.style.left = `${left - parent.left - menu.clientLeft}px`;
  }, [relationMenu, popoverAnchor, dialogRect]);

  const formEnabled = mutationsEnabled && targetProjectAvailable && !mutation.isPending;
  const optionControlsEnabled = formEnabled && creationOptions.isSuccess && !createdTask;
  const canSubmit = formEnabled && creationOptions.isSuccess && Boolean(title.trim());

  useEffect(() => {
    if (optionControlsEnabled) return;
    const frame = window.requestAnimationFrame(() => {
      setOpenPanel(null);
      setRelationMenu(null);
      setRelationSearch("");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [optionControlsEnabled]);

  const requestClose = () => {
    if (mutation.isPending) return;
    if (createdTaskRef.current && attachmentItemsRef.current.length > 0) {
      setInputError("请重试或移除上传失败的附件后再关闭。");
      return;
    }
    if (createdTaskRef.current) completeCreation(createdTaskRef.current);
    else onClose();
  };

  const changeProject = (projectId: string) => {
    setTargetProjectId(projectId);
    initializedOptionsProjectRef.current = undefined;
    setDevelopmentContextId("");
    setSelectedLabelIds([]);
    setParentTaskId("");
    setChildTaskIds([]);
    setRelatedTaskIds([]);
    setRelationSearch("");
    setInputError(undefined);
  };

  const toggleLabel = (labelId: string) => {
    setSelectedLabelIds((current) =>
      toggleSelectedLabelId(
        current.filter((id) => catalogLabelIds.has(id)),
        labelId,
      ),
    );
  };

  const togglePanel = (panel: Exclude<OpenPanel, null>, trigger: HTMLElement) => {
    if (openPanel === panel) {
      setOpenPanel(null);
      setRelationMenu(null);
      setRelationSearch("");
      return;
    }
    const anchor = measurePopoverAnchor(trigger, panelRef.current, panel === "more");
    setPopoverAnchor(
      panel === "model"
        ? {
            ...anchor,
            maxHeight: Math.min(420, Math.max(120, trigger.getBoundingClientRect().top - 24)),
          }
        : anchor,
    );
    setOpenPanel(panel);
    setRelationMenu(null);
    setRelationSearch("");
  };

  const popoverStyle = (alignRight = false): CSSProperties | undefined =>
    popoverAnchor
      ? alignRight
        ? {
            right: popoverAnchor.right,
            bottom: popoverAnchor.bottom,
            left: "auto",
            maxHeight: popoverAnchor.maxHeight,
          }
        : {
            left: popoverAnchor.left,
            bottom: popoverAnchor.bottom,
            right: "auto",
            maxHeight: popoverAnchor.maxHeight,
          }
      : undefined;

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const selected = Array.from(files);
    const maxBytes = creationOptions.data?.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
    const result = appendAttachmentFiles(
      attachmentItems.map((item) => item.file),
      selected,
      maxBytes,
    );
    const appended = result.accepted.slice(attachmentItems.length);
    setAttachmentItems((current) => [
      ...current,
      ...appended.map((file) => ({
        id: newIdempotencyKey(),
        uploadKey: newIdempotencyKey(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
    ]);
    setRejectedFiles((current) => [
      ...current,
      ...result.rejected.map(({ file, reason }) => ({
        id: newIdempotencyKey(),
        name: file.name,
        reason,
      })),
    ]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const descriptionTransfer = useAttachmentTransfer({
    enabled: formEnabled && !createdTask,
    onFiles: addFiles,
  });

  const removeAttachment = (id: string) => {
    const item = attachmentItemsRef.current.find((candidate) => candidate.id === id);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    const remaining = attachmentItemsRef.current.filter((candidate) => candidate.id !== id);
    setAttachmentItems(remaining);
    if (createdTaskRef.current && remaining.length === 0 && !mutation.isPending) {
      completeCreation(createdTaskRef.current);
    }
  };

  const beginResize = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      expanded ||
      isCompactTaskDialogViewport({ width: window.innerWidth, height: window.innerHeight }) ||
      !panelRef.current
    )
      return;
    event.preventDefault();
    const measured = panelRef.current.getBoundingClientRect();
    const start = {
      left: measured.left,
      top: measured.top,
      width: measured.width,
      height: measured.height,
    };
    const startX = event.clientX;
    const startY = event.clientY;
    resizingRef.current = true;
    const move = (pointer: PointerEvent) => {
      const next = resizeDialogRect(
        start,
        edge,
        pointer.clientX - startX,
        pointer.clientY - startY,
        { ...dialogBounds(), minWidth: 560, minHeight: 300 },
      );
      customRectRef.current = next;
      setDialogRect(next);
    };
    const finish = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      document.body.classList.remove("is-resizing-task-dialog");
    };
    document.body.classList.add("is-resizing-task-dialog");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const toggleExpanded = () => {
    if (!panelRef.current) return;
    if (expanded) {
      const restored = customRectRef.current ?? initialDialogRect();
      setDialogRect(restored);
      setExpanded(false);
    } else {
      setDialogRect(maximizeDialogRect(dialogBounds()));
      setExpanded(true);
    }
  };

  const selectRelation = (kind: Exclude<RelationMenu, null>, candidate: TaskRelationCandidate) => {
    const state = relationCandidateState(kind, candidate.id, {
      parentTaskId,
      childTaskIds,
      relatedTaskIds,
    });
    if (state.disabled) return;
    if (kind === "child") {
      setChildTaskIds((current) =>
        current.includes(candidate.id)
          ? current.filter((id) => id !== candidate.id)
          : [...current, candidate.id],
      );
    }
    if (kind === "parent") {
      setParentTaskId((current) => (current === candidate.id ? "" : candidate.id));
    }
    if (kind === "related") {
      setRelatedTaskIds((current) =>
        current.includes(candidate.id)
          ? current.filter((id) => id !== candidate.id)
          : [...current, candidate.id],
      );
    }
  };

  const candidatesForRelation = () => filterTaskRelationCandidates(candidates, relationSearch);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) mutation.mutate();
  };

  const keepKeyboardFocusInside = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable.at(-1) as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const style: CSSProperties | undefined = dialogRect
    ? {
        left: dialogRect.left,
        top: dialogRect.top,
        width: dialogRect.width,
        height: dialogRect.height,
      }
    : undefined;

  return (
    <dialog
      ref={dialogRef}
      className="task-create-backdrop"
      aria-labelledby="task-create-title"
      aria-busy={mutation.isPending}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        if (openPanel) {
          setOpenPanel(null);
          setRelationMenu(null);
        } else requestClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={panelRef}
        className={`task-create-dialog${expanded ? " task-create-dialog--expanded" : ""}${openPanel ? " task-create-dialog--popover-open" : ""}`}
        style={style}
        onKeyDown={keepKeyboardFocusInside}
      >
        {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeEdge[]).map((edge) => (
          <div
            className={`task-create-resize-zone task-create-resize-zone--${edge}`}
            key={edge}
            aria-hidden="true"
            onPointerDown={(event) => beginResize(edge, event)}
          />
        ))}
        <header className="task-create-header">
          <h2 id="task-create-title">{copy.newTask}</h2>
          <div className="task-create-header-actions">
            <button
              className="icon-button task-create-resize"
              type="button"
              aria-label={expanded ? "还原新增任务大小" : "放大新增任务"}
              disabled={mutation.isPending}
              onClick={toggleExpanded}
            >
              <Maximize2 aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭新增任务"
              disabled={mutation.isPending}
              onClick={requestClose}
            >
              <X aria-hidden="true" data-sf-symbol="xmark" />
            </button>
          </div>
        </header>

        <form ref={formRef} className="task-create-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="task-create-title-input">
            {copy.taskTitle}
          </label>
          <input
            ref={titleInputRef}
            className="task-create-title-input"
            id="task-create-title-input"
            placeholder={copy.taskTitle}
            value={title}
            maxLength={500}
            disabled={!formEnabled || Boolean(createdTask)}
            required
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className="sr-only" htmlFor="task-create-description-input">
            {copy.taskDescription}
          </label>
          <textarea
            className={`task-create-description-input ${descriptionTransfer.dragging ? "is-dragging" : ""}`}
            id="task-create-description-input"
            placeholder="添加描述…（支持粘贴或拖拽附件）"
            {...descriptionTransfer.handlers}
            value={description}
            maxLength={100_000}
            disabled={!formEnabled || Boolean(createdTask)}
            onChange={(event) => setDescription(event.target.value)}
          />

          {descriptionTransfer.error && (
            <Notice message={descriptionTransfer.error} eventKey={descriptionTransfer.error} />
          )}
          {attachmentItems.length > 0 ? (
            <div className="task-create-attachment-list" aria-label="已添加附件">
              {attachmentItems.map((item) => (
                <AttachmentCard
                  key={item.id}
                  name={item.file.name}
                  size={item.file.size}
                  imageUrl={item.previewUrl ?? undefined}
                  error={item.error}
                  onRemove={() => removeAttachment(item.id)}
                  removeDisabled={mutation.isPending}
                />
              ))}
            </div>
          ) : null}

          <footer ref={footerRef} className="task-create-footer">
            <div className="task-create-meta-row">
              <div ref={metaStripRef} className="task-create-meta-strip" aria-label="任务创建选项">
                {project.kind === "all" ? (
                  <label className="task-create-meta-control">
                    <FolderKanban aria-hidden="true" data-sf-symbol="folder" />
                    <span className="sr-only">任务归属项目</span>
                    <select
                      value={targetProjectId}
                      disabled={!formEnabled || Boolean(createdTask)}
                      onChange={(event) => changeProject(event.target.value)}
                    >
                      {projects.map((candidate) => (
                        <option value={candidate.id} key={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div
                    className="task-create-meta-control"
                    aria-label={`任务归属项目：${targetProject.name}`}
                  >
                    <FolderKanban aria-hidden="true" data-sf-symbol="folder" />
                    <span>{targetProject.name}</span>
                  </div>
                )}

                <div className="task-create-menu-anchor task-create-model">
                  <button
                    type="button"
                    className="task-create-meta-control"
                    data-task-trigger
                    aria-label="模型与推理强度"
                    aria-expanded={openPanel === "model"}
                    disabled={!optionControlsEnabled}
                    onClick={(event) => {
                      setModelMenu(modelOptions ? "model" : "models");
                      togglePanel("model", event.currentTarget);
                    }}
                  >
                    <RemoteEffortGauge effort={modelOptions?.effort} />
                    <span>
                      {modelOptions
                        ? `${queryClient.getQueryData<RemoteModel[]>(["remote-models"])?.find((model) => model.id === modelOptions.model)?.name ?? modelOptions.model} · ${effortLabels[modelOptions.effort ?? ""] ?? modelOptions.effort}${modelOptions.serviceTier ? " · 加速" : ""}`
                        : "Codex 默认模型"}
                    </span>
                  </button>
                  {openPanel === "model" && (
                    <div
                      className="task-create-popover remote-composer-popover task-create-model-popover"
                      data-task-popover
                      role="dialog"
                      aria-label="模型设置"
                      style={popoverStyle()}
                    >
                      <RemoteModelSettings
                        options={modelOptions ?? readComposerOptions(null)}
                        onOptions={setModelOptions}
                        menu={modelMenu}
                        setMenu={setModelMenu}
                      />
                      <button
                        className="task-create-model-default"
                        type="button"
                        onClick={() => {
                          setModelOptions(undefined);
                          setOpenPanel(null);
                        }}
                      >
                        使用 Codex 默认设置
                      </button>
                    </div>
                  )}
                </div>

                <label className="task-create-meta-control" htmlFor="task-create-status">
                  <SfSymbol name={TASK_STATUS_META[status].symbol} size={16} />
                  <span className="sr-only">{copy.initialStatus}</span>
                  <select
                    id="task-create-status"
                    value={status}
                    disabled={!optionControlsEnabled}
                    onChange={(event) => setStatus(event.target.value as TaskStatus)}
                  >
                    {STATUSES.map((value) => (
                      <option value={value} key={value}>
                        {statusLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>

                <div className={`task-create-menu-anchor${priority === "none" ? " is-muted" : ""}`}>
                  <button
                    className="task-create-meta-control"
                    type="button"
                    data-task-trigger
                    aria-label={`优先级：${priorityLabel(priority)}`}
                    aria-expanded={openPanel === "priority"}
                    disabled={!optionControlsEnabled}
                    onClick={(event) => togglePanel("priority", event.currentTarget)}
                  >
                    <PriorityIcon priority={priority} />
                    <span>{priorityLabel(priority)}</span>
                  </button>
                  {openPanel === "priority" ? (
                    <div
                      className="task-create-popover task-create-choice-menu task-create-priority-menu"
                      role="menu"
                      aria-label="选择优先级"
                      style={popoverStyle()}
                      data-task-popover
                    >
                      {PRIORITIES.map((value) => (
                        <button
                          type="button"
                          key={value}
                          disabled={!optionControlsEnabled}
                          data-selected={value === priority || undefined}
                          onClick={() => {
                            setPriority(value);
                            setOpenPanel(null);
                          }}
                        >
                          <PriorityIcon priority={value} />
                          <span>{priorityLabel(value)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="task-create-menu-anchor">
                  <span
                    className="task-create-meta-control"
                    aria-label={`负责人：${selectedAssignee?.name ?? "当前用户"}`}
                    title="创建任务后自动由当前登录用户负责"
                  >
                    {selectedAssignee ? (
                      <PersonAvatar person={selectedAssignee} />
                    ) : (
                      <UserRound aria-hidden="true" data-sf-symbol="person.crop.circle" />
                    )}
                    <span>{selectedAssignee?.name ?? "当前用户"}</span>
                  </span>
                </div>

                <div className="task-create-menu-anchor">
                  <button
                    className="task-create-meta-control"
                    type="button"
                    data-task-trigger
                    aria-label={`标签：${labels.length ? labels.join("；") : "未选择"}`}
                    aria-expanded={openPanel === "labels"}
                    disabled={!optionControlsEnabled}
                    onClick={(event) => togglePanel("labels", event.currentTarget)}
                  >
                    <Tag aria-hidden="true" data-sf-symbol="tag" />
                    <span title={labels.join("；")}>
                      {labels.length ? labels.join("；") : "标签"}
                    </span>
                  </button>
                  {openPanel === "labels" ? (
                    <div
                      className="task-create-popover task-create-label-menu"
                      role="group"
                      aria-label="选择标签"
                      style={popoverStyle()}
                      data-task-popover
                    >
                      {catalogLabels.map((label) => (
                        <label key={label.id}>
                          <input
                            type="checkbox"
                            checked={activeSelectedLabelIds.includes(label.id)}
                            disabled={
                              !optionControlsEnabled ||
                              (!activeSelectedLabelIds.includes(label.id) &&
                                activeSelectedLabelIds.length >= MAX_TASK_LABELS)
                            }
                            onChange={() => toggleLabel(label.id)}
                          />
                          <span>{label.name}</span>
                        </label>
                      ))}
                      {(creationOptions.data?.labels.length ?? 0) === 0 ? (
                        <span className="task-create-empty-option">
                          暂无标签，可在看板的标签管理中添加
                        </span>
                      ) : null}
                      {activeSelectedLabelIds.length >= MAX_TASK_LABELS ? (
                        <span className="task-create-empty-option">最多选择 20 个标签</span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <label
                  className={`task-create-meta-control${contextLabel === "无" ? " is-muted" : ""}`}
                  htmlFor="task-create-context"
                >
                  <GitBranch />
                  <span className="sr-only">分支 / Worktree</span>
                  <select
                    id="task-create-context"
                    aria-label="分支 / Worktree"
                    value={effectiveDevelopmentContextId}
                    disabled={!optionControlsEnabled}
                    onChange={(event) => setDevelopmentContextId(event.target.value)}
                  >
                    <option value="">
                      {creationOptions.data?.defaultDevelopmentContext.label ?? "无"}
                    </option>
                    {(creationOptions.data?.developmentContexts ?? []).map((context) => (
                      <option value={context.id} key={context.id}>
                        {context.label}
                      </option>
                    ))}
                  </select>
                </label>

                {childTaskIds.map((id) => (
                  <RelationPill
                    key={id}
                    kind="child"
                    candidate={selectedCandidate(candidates, id)}
                    onRemove={() =>
                      setChildTaskIds((current) => current.filter((item) => item !== id))
                    }
                  />
                ))}
                {parentTaskId ? (
                  <RelationPill
                    kind="parent"
                    candidate={selectedCandidate(candidates, parentTaskId)}
                    onRemove={() => setParentTaskId("")}
                  />
                ) : null}
                {relatedTaskIds.map((id) => (
                  <RelationPill
                    key={id}
                    kind="related"
                    candidate={selectedCandidate(candidates, id)}
                    onRemove={() =>
                      setRelatedTaskIds((current) =>
                        current.filter((candidateId) => candidateId !== id),
                      )
                    }
                  />
                ))}

                <div className="task-create-menu-anchor task-create-more-anchor">
                  <button
                    ref={moreButtonRef}
                    className="task-create-meta-control task-create-more-button"
                    type="button"
                    data-task-trigger
                    aria-label="更多任务选项"
                    aria-expanded={openPanel === "more"}
                    disabled={!optionControlsEnabled}
                    onClick={(event) => togglePanel("more", event.currentTarget)}
                  >
                    <Ellipsis aria-hidden="true" data-sf-symbol="ellipsis" />
                  </button>
                  {openPanel === "more" ? (
                    <div
                      ref={relationPopoverRef}
                      className="task-create-popover task-create-relation-menu"
                      role="menu"
                      aria-label="更多任务选项菜单"
                      style={popoverStyle(true)}
                      data-task-popover
                    >
                      <div className="task-create-relation-primary">
                        <button
                          type="button"
                          data-selected={childTaskIds.length ? "true" : undefined}
                          data-active={relationMenu === "child" ? "true" : undefined}
                          aria-current={relationMenu === "child" ? "true" : undefined}
                          disabled={!optionControlsEnabled}
                          onClick={() => {
                            setRelationMenu((current) => (current === "child" ? null : "child"));
                            setRelationSearch("");
                          }}
                        >
                          <ListTree aria-hidden="true" data-sf-symbol="list.bullet.indent" />
                          <span>添加子任务</span>
                          <b>›</b>
                        </button>
                        <button
                          type="button"
                          data-selected={parentTaskId ? "true" : undefined}
                          data-active={relationMenu === "parent" ? "true" : undefined}
                          aria-current={relationMenu === "parent" ? "true" : undefined}
                          disabled={!optionControlsEnabled}
                          onClick={() => {
                            setRelationMenu((current) => (current === "parent" ? null : "parent"));
                            setRelationSearch("");
                          }}
                        >
                          <ArrowUpToLine aria-hidden="true" data-sf-symbol="arrow.up.to.line" />
                          <span>添加父任务</span>
                          <b>›</b>
                        </button>
                        <button
                          type="button"
                          data-active={relationMenu === "related" ? "true" : undefined}
                          aria-current={relationMenu === "related" ? "true" : undefined}
                          disabled={!optionControlsEnabled}
                          onClick={() => {
                            setRelationMenu((current) =>
                              current === "related" ? null : "related",
                            );
                            setRelationSearch("");
                          }}
                        >
                          <LinkIcon aria-hidden="true" data-sf-symbol="link" />
                          <span>添加关联任务</span>
                          <b>›</b>
                        </button>
                      </div>
                      {relationMenu ? (
                        <div
                          ref={relationSubmenuRef}
                          className="task-create-relation-submenu"
                          role="menu"
                          aria-label={`${
                            relationMenu === "child"
                              ? "子"
                              : relationMenu === "parent"
                                ? "父"
                                : "关联"
                          }任务候选`}
                        >
                          <label className="task-create-relation-search">
                            <Search aria-hidden="true" />
                            <span className="sr-only">搜索任务</span>
                            <input
                              type="search"
                              aria-label="搜索任务"
                              placeholder="搜索任务"
                              value={relationSearch}
                              autoFocus
                              onChange={(event) => setRelationSearch(event.target.value)}
                            />
                          </label>
                          {candidatesForRelation().map((candidate) => {
                            const candidateState = relationCandidateState(
                              relationMenu,
                              candidate.id,
                              { parentTaskId, childTaskIds, relatedTaskIds },
                            );
                            return (
                              <button
                                type="button"
                                key={candidate.id}
                                disabled={!optionControlsEnabled || candidateState.disabled}
                                aria-label={`${candidate.identifier} ${candidate.title}`}
                                aria-pressed={candidateState.selected}
                                data-selected={candidateState.selected || undefined}
                                onClick={() => selectRelation(relationMenu, candidate)}
                              >
                                <span>{candidate.identifier}</span>
                                <small>{candidate.title}</small>
                              </button>
                            );
                          })}
                          {candidatesForRelation().length === 0 ? (
                            <span className="task-create-empty-option">暂无可绑定任务</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <Notice
              message={
                rejectedFiles.length
                  ? `以下文件未添加：${rejectedFiles.map((file) => `${file.name}：${file.reason}`).join("；")}`
                  : null
              }
              eventKey={rejectedFiles}
            />

            <div className="task-create-submit-row">
              <div className="task-create-attachment-entry">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => addFiles(event.target.files)}
                />
                <button
                  className="task-create-add-link"
                  type="button"
                  aria-label={
                    attachmentItems.length
                      ? `添加附件，已选择 ${attachmentItems.length} 个`
                      : "添加附件"
                  }
                  disabled={!optionControlsEnabled}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip aria-hidden="true" data-sf-symbol="paperclip" />
                  <span>添加附件</span>
                  {attachmentItems.length > 0 ? (
                    <b className="task-create-attachment-badge">{attachmentItems.length}</b>
                  ) : null}
                </button>
              </div>
              <div className="task-create-action-status">
                {!targetProjectAvailable ? (
                  <Notice message="所选项目已不可用，请关闭弹窗后重新选择。" />
                ) : !mutationsEnabled ? (
                  <Notice message="当前无法创建任务，请恢复连接或确认项目权限。" tone="info" />
                ) : creationOptions.isPending ? (
                  <span className="task-create-loading" role="status">
                    正在加载创建选项…
                  </span>
                ) : creationOptions.isError ? (
                  <>
                    <Notice message="创建选项加载失败。" eventKey={creationOptions.error} />
                    <button type="button" onClick={() => void creationOptions.refetch()}>
                      重试加载创建选项
                    </button>
                  </>
                ) : mutation.isError ? (
                  <Notice
                    message={errorMessage(mutation.error, copy.operationFailed)}
                    eventKey={mutation.error}
                  />
                ) : null}
                <div className="task-create-actions">
                  <button className="button button--primary" type="submit" disabled={!canSubmit}>
                    {mutation.isPending ? (
                      <LoaderCircle className="spin" aria-hidden="true" />
                    ) : null}
                    {createdTask ? "重试附件" : "创建任务"}
                  </button>
                </div>
              </div>
            </div>
          </footer>
        </form>
      </section>
    </dialog>
  );
}

function RelationPill({
  kind,
  candidate,
  onRemove,
}: {
  readonly kind: "child" | "parent" | "related";
  readonly candidate: TaskRelationCandidate | undefined;
  readonly onRemove: () => void;
}) {
  const Icon = kind === "child" ? ListTree : kind === "parent" ? ArrowUpToLine : LinkIcon;
  const title = candidate ? relationLabel(candidate) : "任务已不可用";
  const prefix = kind === "child" ? "子任务" : kind === "parent" ? "父任务" : "关联";
  return (
    <div
      className="task-create-meta-control task-create-relation-pill"
      tabIndex={0}
      title={`${prefix}：${title}`}
    >
      <Icon
        aria-hidden="true"
        data-sf-symbol={
          kind === "child" ? "list.bullet.indent" : kind === "parent" ? "arrow.up.to.line" : "link"
        }
      />
      <span>
        {prefix}：{candidate?.identifier ?? "不可用"}
      </span>
      <button
        type="button"
        aria-label={`删除${prefix} ${candidate?.identifier ?? ""}`}
        onClick={onRemove}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
