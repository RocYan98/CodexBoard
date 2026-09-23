import { AttachmentCard } from "./attachment-card";
import { chooseFeishuMedia, isFeishuClient } from "./feishu-images";
import { remoteUploadErrorMessage } from "./remote-api";
import { RemoteNotice } from "./remote-notice";
import { RemoteImagePreview } from "./remote-images";
import { useEffect, useRef, useState, type RefObject, type MouseEvent } from "react";
import type { ComposerOptions } from "./remote-composer-model";
import { uploadRemoteFile } from "./remote-api";
import { RemoteModelSettings } from "./remote-model-settings";
import { RemoteEffortGauge } from "./remote-effort-gauge";
import { SfSymbol } from "./sf-symbol";
import "./remote-composer.css";

const approvalChoices = [
  { id: "ask", label: "请求批准", detail: "编辑外部文件和使用互联网前询问", icon: "hand.raised" },
  {
    id: "auto",
    label: "替我批准",
    detail: "由自动审批审核操作，必要时询问",
    icon: "checkmark.shield",
  },
  {
    id: "full",
    label: "完全访问",
    detail: "完全访问计算机（风险较高）",
    icon: "exclamationmark.shield",
  },
] as const;

export function RemoteComposer({
  csrf,
  draft,
  onDraft,
  options,
  onOptions,
  onSubmit,
  onStop,
  disabled = false,
  pending = false,
  busy = false,
  canQueue = false,
  currentModel,
  currentEffort,
  submitLabel = "发送消息",
  placeholder = "在此电脑 上工作",
  inputLabel = "发送给 Codex",
  inputRef,
}: {
  csrf: string;
  draft: string;
  onDraft: (value: string) => void;
  options: ComposerOptions;
  onOptions: (value: ComposerOptions) => void;
  onSubmit: () => void;
  onStop?: () => void;
  disabled?: boolean;
  pending?: boolean;
  busy?: boolean;
  canQueue?: boolean;
  currentModel?: string | undefined;
  currentEffort?: string | undefined;
  submitLabel?: string;
  placeholder?: string;
  inputLabel?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [attachmentPreview, setAttachmentPreview] = useState<{ url: string; name: string }>();
  const [focused, setFocused] = useState(false);
  const [menu, setMenuState] = useState<"add" | "permissions" | "model" | "models" | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const setMenu = (value: typeof menu) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (value === null && menu) {
      setClosing(true);
      closeTimer.current = setTimeout(() => {
        setMenuState(null);
        setClosing(false);
      }, 160);
    } else {
      setClosing(false);
      setMenuState(value);
    }
  };
  const [uploading, setUploading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      uploadController.current?.abort();
      uploadController.current = null;
    },
    [],
  );
  const [uploadError, setUploadError] = useState("");
  const localInput = useRef<HTMLTextAreaElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const textInput = inputRef ?? localInput;
  const inputHasFocus = () => textInput.current?.ownerDocument.activeElement === textInput.current;
  const preserveInputFocus = (event: MouseEvent<HTMLDivElement>) => {
    if (!inputHasFocus() || !(event.target instanceof Element)) return;
    // Cancel focus transfer at mousedown, including compatibility mouse
    // events after a touch. Canceling pointerdown itself swallows WebKit taps.
    // Range dragging has its own pointer handling; outside taps dismiss.
    if (event.target.closest("textarea, input, .remote-composer-backdrop")) return;
    event.preventDefault();
  };
  useEffect(() => {
    const input = textInput.current;
    if (!input) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !composerWrap.current?.contains(event.target)) {
        setFocused(false);
        input.blur();
      }
    };
    input.ownerDocument.addEventListener("pointerdown", outside, true);
    return () => input.ownerDocument.removeEventListener("pointerdown", outside, true);
  }, [textInput]);
  const closeMenu = () => {
    setMenu(null);
    textInput.current?.focus({ preventScroll: true });
  };
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  // WebKit maps this MIME type to public.data: use the document picker without
  // adding image/video types that trigger iOS's media-source menu.
  const filePickerAccept =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
      ? "application/octet-stream"
      : undefined;
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const expanded = focused || !!menu || !!draft || !!options.attachments.length;
  const hasContent = !!draft.trim() || !!options.attachments.length;
  const locked = disabled || pending || uploading || selecting;

  async function upload(
    list: FileList | File[] | null | ((signal: AbortSignal) => Promise<File[]>),
  ) {
    setMenu(null);
    if (
      !list ||
      (typeof list !== "function" && !list.length) ||
      disabled ||
      pending ||
      uploadController.current
    )
      return;
    if (
      optionsRef.current.attachments.length + (typeof list === "function" ? 1 : list.length) >
      8
    ) {
      setUploadError("最多添加 8 个附件");
      return;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    setSelecting(typeof list === "function");
    setUploadProgress(0);
    setUploadError("");
    try {
      const selected =
        typeof list === "function" ? await list(controller.signal) : Array.from(list);
      controller.signal.throwIfAborted();
      if (!selected.length) return;
      if (optionsRef.current.attachments.length + selected.length > 8) {
        setUploadError("最多添加 8 个附件");
        return;
      }
      // Native selection/read is complete. Cancellation never starts upload UI.
      setSelecting(false);
      setUploading(true);
      for (const file of selected) {
        const attachment = await uploadRemoteFile(file, csrf, setUploadProgress, controller.signal);
        controller.signal.throwIfAborted();
        const next = {
          ...optionsRef.current,
          attachments: [...optionsRef.current.attachments, attachment],
        };
        optionsRef.current = next;
        onOptions(next);
      }
    } catch (error) {
      if (!controller.signal.aborted) setUploadError(remoteUploadErrorMessage(error));
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = null;
        setUploading(false);
        setSelecting(false);
      }
    }
  }
  const open = (value: NonNullable<typeof menu>) =>
    setMenu(!closing && menu === value ? null : value);
  return (
    <div
      ref={composerWrap}
      className="remote-composer-wrap"
      onMouseDownCapture={preserveInputFocus}
      onKeyDown={(event) => {
        if (event.key === "Escape") closeMenu();
      }}
    >
      {uploadError && (
        <RemoteNotice onDismiss={() => setUploadError("")}>{uploadError}</RemoteNotice>
      )}
      {uploading && (
        <RemoteNotice className="remote-upload-status" role="status">
          <span className="remote-upload-progress">
            <span>正在上传 {uploadProgress}%</span>
            <button
              type="button"
              className="remote-upload-cancel"
              aria-label="取消上传"
              onClick={() => uploadController.current?.abort()}
            >
              <SfSymbol name="xmark" size={12} />
            </button>
          </span>
        </RemoteNotice>
      )}
      {busy && options.attachments.length > 0 && (
        <RemoteNotice className="remote-upload-status" role="status">
          附件将随消息加入队列
        </RemoteNotice>
      )}
      <input
        ref={files}
        hidden
        type="file"
        multiple
        accept={filePickerAccept}
        aria-label="上传文件"
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={photos}
        hidden
        type="file"
        multiple
        accept="image/*,video/*"
        aria-label="上传照片与视频"
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={camera}
        hidden
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="使用相机"
        onChange={(event) => {
          void upload(event.target.files);
          event.target.value = "";
        }}
      />
      {menu && (
        <>
          <button
            className={`remote-composer-backdrop${closing ? " is-closing" : ""}`}
            aria-label="关闭输入设置"
            type="button"
            onClick={() => {
              setMenu(null);
              textInput.current?.blur();
              setFocused(false);
            }}
          />
          <div
            className={`remote-composer-popover remote-composer-popover-${menu}${closing ? " is-closing" : ""}`}
            role="dialog"
            aria-label={
              menu === "add" ? "添加附件" : menu === "permissions" ? "审批方式" : "模型设置"
            }
          >
            {menu === "add" && (
              <div className="remote-add-menu">
                <button
                  type="button"
                  onClick={() => {
                    if (isFeishuClient())
                      void upload((signal) =>
                        chooseFeishuMedia(8 - optionsRef.current.attachments.length, signal),
                      );
                    else photos.current?.click();
                  }}
                >
                  <span>
                    <SfSymbol name="photo" />
                  </span>
                  照片与视频
                </button>
                <button type="button" onClick={() => files.current?.click()}>
                  <span>
                    <SfSymbol name="folder" />
                  </span>
                  文件
                </button>
                <button type="button" onClick={() => camera.current?.click()}>
                  <span>
                    <SfSymbol name="camera" />
                  </span>
                  相机
                </button>
              </div>
            )}
            {menu === "permissions" && (
              <>
                <p>应如何批准 Codex 操作？</p>
                <div className="remote-permission-menu" role="group" aria-label="审批预设">
                  {approvalChoices.map((choice) => (
                    <button
                      type="button"
                      key={choice.id}
                      aria-pressed={options.approvalMode === choice.id}
                      onClick={() => {
                        onOptions({ ...options, approvalMode: choice.id });
                        closeMenu();
                      }}
                    >
                      <SfSymbol name={choice.icon} />
                      <span>
                        {choice.label}
                        <small>{choice.detail}</small>
                      </span>
                      {options.approvalMode === choice.id && <SfSymbol name="checkmark" />}
                    </button>
                  ))}
                </div>
                <RemoteNotice className="remote-settings-note" role="status">
                  {busy ? "当前回合与排队消息保持原设置；用于空闲后的发送" : "用于下一次发送"}
                </RemoteNotice>
              </>
            )}
            {(menu === "model" || menu === "models") && (
              <RemoteModelSettings
                options={options}
                onOptions={onOptions}
                menu={menu}
                setMenu={setMenu}
                currentModel={currentModel}
                currentEffort={currentEffort}
                busy={busy}
                inputHasFocus={inputHasFocus}
              />
            )}
          </div>
        </>
      )}
      <form
        className={`remote-composer remote-rich-composer${expanded ? " is-expanded" : ""}${options.attachments.length ? " has-attachments" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked && (submitLabel === "创建" || hasContent) && (!busy || canQueue)) onSubmit();
        }}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          // Mirroring may blur the native text view before any pointer event
          // reaches a tool. Keep it mounted until an explicit outside action.
          if (event.relatedTarget && !composerWrap.current?.contains(event.relatedTarget))
            setFocused(false);
        }}
      >
        {options.attachments.length > 0 && (
          <div className="remote-attachment-list">
            {options.attachments.map((file) => (
              <AttachmentCard
                key={file.id}
                name={file.name}
                size={file.size}
                imageUrl={
                  file.mimeType.startsWith("image/")
                    ? `/api/v1/remote/uploads/${encodeURIComponent(file.id)}/preview`
                    : undefined
                }
                onPreview={() =>
                  setAttachmentPreview({
                    url: `/api/v1/remote/uploads/${encodeURIComponent(file.id)}/preview`,
                    name: file.name,
                  })
                }
                removeLabel={`移除 ${file.name}`}
                removeDisabled={pending || uploading || selecting}
                onRemove={() =>
                  onOptions({
                    ...options,
                    attachments: options.attachments.filter((item) => item.id !== file.id),
                  })
                }
              />
            ))}
          </div>
        )}
        {attachmentPreview && (
          <RemoteImagePreview
            image={attachmentPreview}
            onClose={() => setAttachmentPreview(undefined)}
          />
        )}
        <button
          className="remote-composer-add"
          type="button"
          aria-label="添加附件"
          aria-expanded={menu === "add"}
          disabled={locked}
          onClick={() => open("add")}
        >
          <SfSymbol name="plus" />
        </button>
        <textarea
          ref={inputRef ?? localInput}
          aria-label={inputLabel}
          placeholder={placeholder}
          rows={1}
          maxLength={100_000}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!images.length) return;
            event.preventDefault();
            void upload(images);
          }}
          disabled={pending}
        />
        {expanded && (
          <button
            className="remote-composer-gear"
            type="button"
            aria-label="审批方式"
            aria-expanded={menu === "permissions"}
            disabled={pending}
            onClick={() => open("permissions")}
          >
            <SfSymbol name="gearshape" />
          </button>
        )}
        <div className="remote-composer-controls">
          {expanded && (
            <button
              className="remote-model-control"
              type="button"
              aria-label="模型与推理强度"
              aria-expanded={menu === "model" || menu === "models"}
              disabled={pending}
              onClick={() => open("model")}
            >
              <RemoteEffortGauge effort={options.effort ?? currentEffort} />
            </button>
          )}
          {busy && !hasContent && onStop ? (
            <button
              className="remote-send"
              type="button"
              aria-label="停止 Codex"
              disabled={disabled || pending}
              onClick={onStop}
            >
              <SfSymbol name="stop.fill" />
            </button>
          ) : (
            <button
              className="remote-send"
              type="submit"
              aria-label={submitLabel}
              disabled={locked || (submitLabel !== "创建" && !hasContent) || (busy && !canQueue)}
            >
              {pending ? <span className="remote-status-spinner" /> : <SfSymbol name="arrow.up" />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
