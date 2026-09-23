import { remoteProjectOwner, compareRemoteThreads, remoteRecency } from "./remote-thread-order";
import { RemoteAsyncQuestions, RemoteEditMessage } from "./remote-message-actions";
import { installKeyboardDiagnostics } from "./remote-keyboard-diagnostics";
import { preventRemoteFocusScroll } from "./remote-focus-scroll";
import { isFeishuClient } from "./feishu-images";
import { RemoteApprovalForm } from "./remote-approval-form";
import { RemotePullRefresh } from "./remote-pull-refresh";
import { RemoteNotice } from "./remote-notice";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RemoteAction,
  RemoteRequest,
  RemoteThread,
  RemoteThreadSummary,
  SessionView,
} from "@codexboard/contracts";
import { BoardPage } from "./board";
import { listProjects } from "./api";
import {
  createRemoteThread,
  listRemoteThreads,
  readRemoteThread,
  readRemoteUsage,
  remoteAction,
  remoteErrorMessage,
} from "./remote-api";
import { MarkdownContent } from "./markdown";
import { SfSymbol } from "./sf-symbol";
import { parseRemoteDiff } from "./remote-diff";
import { RemoteTurnContent } from "./remote-turn";
import { RemoteToolItem } from "./remote-tool-item";
import { RemoteQueuedMessages } from "./remote-queued-messages";
import { RemoteComposer } from "./remote-composer";
import {
  useRemoteComposerOptions,
  useRemoteDraft,
  readRemoteComposerValue,
  writeRemoteComposerValue,
} from "./remote-composer-model";
import { RemoteImages } from "./remote-images";
import { RemoteReview, RemoteReviewShortcut } from "./remote-review";
import { copyText } from "./copy-text";
import { createUuid } from "./random-id";
import { fitRemoteViewport } from "./remote-viewport";
import "./mobile-remote.css";

const mobileQuery = "(max-width: 767px) and (pointer: coarse)";
function subscribeMobile(listener: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function route() {
  const query = new URLSearchParams(window.location.search);
  return { open: query.get("remote") === "1", thread: query.get("remoteThread") ?? undefined };
}
export function MobileWorkspace({ session }: { session: SessionView }) {
  const mobile = useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(mobileQuery).matches,
    () => false,
  );
  const [location, setLocation] = useState(route);
  useEffect(() => {
    const changed = () => setLocation(route());
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  const navigate = (open: boolean, thread?: string) => {
    const url = new URL(window.location.href);
    if (open) url.searchParams.set("remote", "1");
    else url.searchParams.delete("remote");
    if (thread) url.searchParams.set("remoteThread", thread);
    else url.searchParams.delete("remoteThread");
    window.history.pushState(null, "", url);
    setLocation({ open, thread });
  };
  const eligible = mobile;
  return eligible && location.open ? (
    <RemotePage
      session={session}
      threadId={location.thread}
      onSelect={(id) => navigate(true, id)}
      onClose={() => navigate(false)}
    />
  ) : (
    <BoardPage session={session} {...(eligible ? { onOpenRemote: () => navigate(true) } : {})} />
  );
}

function ErrorMessage({
  error,
  retry,
  refreshing = false,
}: {
  error: unknown;
  retry?: () => void;
  refreshing?: boolean;
}) {
  if (!error) return null;
  return (
    <RemoteNotice
      action={
        retry ? (
          <button className="remote-notice-refresh" onClick={retry} disabled={refreshing}>
            {refreshing ? "刷新中…" : "刷新"}
          </button>
        ) : undefined
      }
    >
      <span>{remoteErrorMessage(error)}</span>
    </RemoteNotice>
  );
}
function folder(cwd: string) {
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return !name || /^task-[0-9a-f-]{36}$/i.test(name) ? "最近" : name;
}

function RemoteGlyph({ name }: { name: "desktop" | "compose" | "copy" }) {
  return (
    <svg
      className="remote-glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "compose" ? 2.3 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "desktop" ? (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M9 21h6m-3-4v4" />
        </>
      ) : name === "compose" ? (
        <>
          <path d="M9.1 3.4H7.3c-3.1 0-4.2 1.1-4.2 4.2v9.1c0 3.1 1.1 4.2 4.2 4.2h9.1c3.1 0 4.2-1.1 4.2-4.2v-3" />
          <path d="m9 15.2 1-4.1L18.2 3a2.2 2.2 0 0 1 3.1 3.1l-8.1 8.1L9 15.2Z" />
        </>
      ) : (
        <>
          <rect x="8" y="7" width="12" height="14" rx="2" />
          <path d="M16 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
        </>
      )}
    </svg>
  );
}

function RemoteMenuIcon({ name }: { name: "changes" | "rename" }) {
  return (
    <svg
      className="remote-menu-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "changes" ? (
        <>
          <circle cx="6" cy="5" r="2.5" />
          <circle cx="6" cy="19" r="2.5" />
          <circle cx="19" cy="5" r="2.5" />
          <path d="M6 7.5v9M19 7.5v1a4 4 0 0 1-4 4h-5a4 4 0 0 0-4 4" />
        </>
      ) : (
        <>
          <path d="m3 21 1.5-6L16.7 2.8a3.2 3.2 0 0 1 4.5 4.5L9 19.5 3 21Z" />
          <path d="m14.5 5 4.5 4.5" />
        </>
      )}
    </svg>
  );
}

type RemoteOrganization = "projects" | "time" | "recent";
function loadOrganization(): RemoteOrganization {
  try {
    const saved = localStorage.getItem("remote-organization");
    return saved === "time" || saved === "recent" ? saved : "projects";
  } catch {
    return "projects";
  }
}
function usagePeriod(minutes: number | null) {
  if (minutes === 10080) return "本周";
  if (minutes === 1440) return "每日";
  if (minutes === null) return "当前周期";
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

function RemotePage({
  session,
  threadId,
  onSelect,
  onClose,
}: {
  session: SessionView;
  threadId: string | undefined;
  onSelect: (id?: string) => void;
  onClose: () => void;
}) {
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const previousViewport = viewportMeta?.getAttribute("content") ?? null;
    viewportMeta?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
    );
    const preventGesture = (event: Event) => event.preventDefault();
    const preventPinch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    // Safari gesture events cover browsers that ignore user-scalable=no.
    document.addEventListener("gesturestart", preventGesture, { passive: false });
    document.addEventListener("gesturechange", preventGesture, { passive: false });
    document.addEventListener("touchmove", preventPinch, { passive: false });
    const viewport = window.visualViewport;
    const update = () => {
      if (!viewport || viewport.scale !== 1) return;
      const container = page.current?.parentElement;
      if (!container) return;
      // Keyboard dismissal can leave Safari reporting the old offset after navigation.
      const editing =
        page.current?.contains(document.activeElement) &&
        document.activeElement?.matches("input, textarea, select, [contenteditable='true']");
      // Only the remote list/messages should scroll. iOS focus scrolling can
      // otherwise move the containing block and amplify the viewport offset.
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }
      const bounds = container.getBoundingClientRect();
      // iOS Feishu resizes/pans its native webview for the keyboard. Its
      // transient visualViewport offset arrives before the container resize;
      // applying it here moves the entire page down a second time.
      const nativeKeyboard = isFeishuClient() && /iP(?:hone|ad|od)/.test(navigator.userAgent);
      const fitted = fitRemoteViewport(
        {
          top: bounds.top,
          bottom: nativeKeyboard ? bounds.bottom : Math.max(bounds.bottom, viewport.height),
        },
        { offsetTop: editing && !nativeKeyboard ? viewport.offsetTop : 0, height: viewport.height },
      );
      page.current?.style.setProperty("--remote-top", `${fitted.top}px`);
      page.current?.style.setProperty("--remote-fixed-top", `${fitted.fixedTop}px`);
      page.current?.style.setProperty("--remote-height", `${fitted.height}px`);
    };
    let focusFrame = 0;
    const updateAfterFocus = () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(update);
    };
    const restoreFocusScroll = page.current ? preventRemoteFocusScroll(page.current) : () => {};
    const restoreDiagnostics = page.current
      ? installKeyboardDiagnostics(page.current, session.csrfToken)
      : () => {};
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    update();
    const containerObserver = new ResizeObserver(update);
    if (page.current?.parentElement) containerObserver.observe(page.current.parentElement);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update);
    document.addEventListener("focusin", updateAfterFocus);
    document.addEventListener("focusout", updateAfterFocus);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      if (previousViewport === null) viewportMeta?.removeAttribute("content");
      else viewportMeta?.setAttribute("content", previousViewport);
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("touchmove", preventPinch);
      document.body.style.overflow = previousOverflow;
      restoreFocusScroll();
      restoreDiagnostics();
      containerObserver.disconnect();
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update);
      document.removeEventListener("focusin", updateAfterFocus);
      document.removeEventListener("focusout", updateAfterFocus);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [session.csrfToken]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [creating, setCreating] = useState(false);
  useLayoutEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    page.current?.style.setProperty("--remote-top", "0px");
  }, [threadId, creating]);
  const [listMenu, setListMenu] = useState(false);
  const [organization, setOrganization] = useState<RemoteOrganization>(loadOrganization);
  const usage = useQuery({
    queryKey: ["remote-usage"],
    queryFn: readRemoteUsage,
    enabled: listMenu && !threadId,
    refetchInterval: 60_000,
    retry: false,
  });
  const organize = (value: RemoteOrganization) => {
    setOrganization(value);
    try {
      localStorage.setItem("remote-organization", value);
    } catch {
      /* Storage can be unavailable in private mode. */
    }
    setListMenu(false);
  };

  const [initialProject, setInitialProject] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const startTask = (project = "") => {
    setInitialProject(project);
    setCreating(true);
  };
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const threads = useInfiniteQuery({
    queryKey: ["remote-threads", debounced],
    queryFn: ({ pageParam }) => listRemoteThreads(debounced, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !threadId,
    refetchInterval: 10_000,
    retry: false,
  });
  const all = [
    ...new Map(
      (threads.data?.pages.flatMap((p) => p.threads) ?? []).map((t) => [t.id, t]),
    ).values(),
  ];
  const availableProjects = (projects.data ?? []).filter(
    (project) => project.kind === "codex" && project.syncState !== "stale",
  );
  const groups = availableProjects.map((project) => ({
    id: project.id,
    label: project.name,
    items: [] as RemoteThreadSummary[],
  }));
  const recent = { id: "", label: "最近", items: [] as RemoteThreadSummary[] };
  for (const thread of all) {
    const owner = remoteProjectOwner(thread, availableProjects);
    (groups.find((group) => group.id === owner) ?? recent).items.push(thread);
  }
  for (const group of [...groups, recent]) group.items.sort(compareRemoteThreads);
  const orderedGroups =
    organization === "time"
      ? [
          {
            id: "",
            label: "最近任务",
            items: [...all].sort((a, b) => remoteRecency(b) - remoteRecency(a)),
          },
        ]
      : organization === "recent"
        ? [recent, ...groups]
        : [...groups, recent];
  const visibleGroups = orderedGroups.filter((group) => !debounced || group.items.length);
  return (
    <main className="remote-page" aria-label="Codex Remote" ref={page}>
      {creating ? (
        <NewRemoteTask
          csrf={session.csrfToken}
          initialProject={initialProject}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onSelect(id);
          }}
        />
      ) : threadId ? (
        <RemoteConversation
          key={threadId}
          id={threadId}
          csrf={session.csrfToken}
          onBack={() => onSelect()}
        />
      ) : (
        <>
          <header className="remote-header remote-list-header">
            <button className="remote-icon remote-floating" aria-label="返回看板" onClick={onClose}>
              <SfSymbol name="chevron.left" />
            </button>
            <div className="remote-list-heading">
              <h1>远程</h1>
              <div className="remote-host-status">
                <span
                  className={`remote-host-dot${!threads.data || threads.isError ? " is-offline" : ""}`}
                />
                <RemoteGlyph name="desktop" /> 此电脑
              </div>
            </div>
            <button
              className="remote-icon remote-floating"
              aria-label="任务列表选项"
              aria-expanded={listMenu}
              onClick={() => setListMenu(!listMenu)}
            >
              <SfSymbol name="ellipsis" />
            </button>
          </header>
          {listMenu && (
            <>
              <button
                className="remote-menu-backdrop"
                aria-label="关闭任务列表选项"
                onClick={() => setListMenu(false)}
              />
              <div className="remote-menu remote-list-menu">
                <p>整理</p>
                <div role="group" aria-label="整理任务">
                  {(
                    [
                      ["projects", "按项目", "folder"],
                      ["time", "按时间倒序排列", "clock"],
                      ["recent", "最近优先", "bubble.left"],
                    ] as const
                  ).map(([value, label, icon]) => (
                    <button
                      key={value}
                      className="remote-organize-option"
                      aria-pressed={organization === value}
                      onClick={() => organize(value)}
                    >
                      <span className="remote-organize-check">
                        {organization === value && <SfSymbol name="checkmark" />}
                      </span>
                      <SfSymbol name={icon} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <div className="remote-usage-section">
                  <p>剩余用量</p>
                  {usage.isPending ? (
                    <p role="status">正在读取…</p>
                  ) : usage.isError ? (
                    <>
                      <RemoteNotice role="status">暂时无法读取用量</RemoteNotice>
                      <button onClick={() => void usage.refetch()}>重试</button>
                    </>
                  ) : !usage.data?.windows.length ? (
                    <p>暂无用量信息</p>
                  ) : (
                    usage.data.windows.map((window) => (
                      <div className="remote-usage-window" key={window.id}>
                        {new Set(usage.data.windows.map((item) => item.name)).size > 1 && (
                          <small>{window.name}</small>
                        )}
                        <span>
                          {usagePeriod(window.windowDurationMins)}{" "}
                          {Math.round(window.remainingPercent)}%
                        </span>
                        {window.resetsAt !== null && (
                          <small>
                            {new Date(window.resetsAt * 1000).toLocaleString("zh-CN", {
                              month: "numeric",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}{" "}
                            重置
                          </small>
                        )}
                      </div>
                    ))
                  )}
                </div>
                <button
                  className="remote-list-refresh"
                  onClick={() => {
                    void threads.refetch();
                    void usage.refetch();
                    setListMenu(false);
                  }}
                >
                  刷新任务
                </button>
              </div>
            </>
          )}
          <RemotePullRefresh
            onRefresh={() =>
              Promise.allSettled([
                threads.refetch({ cancelRefetch: false }),
                projects.refetch({ cancelRefetch: false }),
              ])
            }
          >
            <ErrorMessage
              error={threads.error ?? projects.error}
              refreshing={threads.isFetching || projects.isFetching}
              retry={() => {
                void threads.refetch();
                void projects.refetch();
              }}
            />
            {threads.isPending ? (
              <p className="remote-empty" role="status">
                正在加载任务…
              </p>
            ) : !all.length && !threads.error && !!debounced ? (
              <div className="remote-empty">
                <SfSymbol name="bubble.left" />
                <h2>{search ? "没有匹配的任务" : "开始一个新任务"}</h2>
                <p>让 Codex 在你的电脑 上继续工作。</p>
              </div>
            ) : null}
            {!threads.isPending && organization !== "time" && (
              <h2 className="remote-project-heading">项目</h2>
            )}
            {!threads.isPending &&
              visibleGroups.map(({ id, label, items }) => {
                const open = organization === "time" || !!debounced || expanded.has(id);
                return (
                  <section
                    className={`remote-project-group${id ? "" : " remote-recent-group"}`}
                    key={id}
                  >
                    <div className="remote-project-row">
                      <button
                        className="remote-project-toggle"
                        aria-expanded={open}
                        onClick={() =>
                          setExpanded((previous) => {
                            const next = new Set(previous);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                      >
                        {id && <SfSymbol name="folder" />}
                        <span>{label}</span>
                        <SfSymbol name="chevron.right" className="remote-project-chevron" />
                      </button>
                      <button
                        className="remote-icon remote-project-create"
                        aria-label={`在${label}中新建任务`}
                        onClick={() => startTask(id)}
                      >
                        <RemoteGlyph name="compose" />
                      </button>
                    </div>
                    {open && (
                      <ul className="remote-thread-list">
                        {items.map((thread) => (
                          <li key={thread.id}>
                            <button
                              onClick={() => onSelect(thread.id)}
                              title={`${folder(thread.cwd)} · ${thread.title}`}
                            >
                              <span className="remote-thread-title">{thread.title}</span>
                              {thread.status === "active" && (
                                <span
                                  className="remote-status-spinner"
                                  role="img"
                                  aria-label="处理中"
                                />
                              )}
                            </button>
                          </li>
                        ))}
                        {!items.length && !threads.hasNextPage && (
                          <li className="remote-group-empty">暂无任务</li>
                        )}
                        {threads.hasNextPage && (
                          <li>
                            <button
                              className="remote-load-more"
                              disabled={threads.isFetchingNextPage}
                              onClick={() => void threads.fetchNextPage()}
                            >
                              {threads.isFetchingNextPage ? "正在加载…" : "展开显示"}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                );
              })}
          </RemotePullRefresh>
          <footer className="remote-list-footer">
            <label className="remote-search">
              <SfSymbol name="magnifyingglass" />
              <input
                type="search"
                aria-label="搜索 Codex 任务"
                placeholder="搜索任务"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button
              className="remote-icon remote-floating remote-create-button"
              aria-label="新建 Codex 任务"
              onClick={() => startTask()}
            >
              <RemoteGlyph name="compose" />
            </button>
          </footer>
        </>
      )}
    </main>
  );
}

function NewRemoteTask({
  csrf,
  initialProject,
  onClose,
  onCreated,
}: {
  csrf: string;
  initialProject: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const [project, setProject] = useState(initialProject);
  const [draft, setDraft] = useRemoteDraft("new");
  const [composerOptions, setComposerOptions] = useRemoteComposerOptions("new");
  const key = useRef(createUuid());
  const [createdThread, setCreatedThread] = useState<{ threadId: string } | null>(null);
  const sendReceipt = useRef({ fingerprint: "", key: createUuid() });
  const create = useMutation({
    mutationFn: async () => {
      const result =
        createdThread ?? (await createRemoteThread(project || null, csrf, key.current));
      setCreatedThread(result);
      if (draft.trim() || composerOptions.attachments.length) {
        const action: RemoteAction = {
          type: "send",
          text: draft.trim(),
          approvalMode: composerOptions.approvalMode,
          model: composerOptions.model,
          effort: composerOptions.effort,
          serviceTier: composerOptions.serviceTier,
          attachments: composerOptions.attachments.map((file) => file.id),
        };
        const fingerprint = JSON.stringify(action);
        if (sendReceipt.current.fingerprint !== fingerprint)
          sendReceipt.current = { fingerprint, key: createUuid() };
        // Hydrate the Desktop owner before sending. Retrying keeps both the
        // created thread and the send receipt, including an ambiguous timeout.
        await readRemoteThread(result.threadId);
        await remoteAction(result.threadId, action, csrf, sendReceipt.current.key);
      }
      return result;
    },
    retry: false,
    onSuccess: (result) => {
      writeRemoteComposerValue(`remote-draft:${result.threadId}`, "");
      setDraft("");
      writeRemoteComposerValue(
        `remote-options:${result.threadId}`,
        JSON.stringify({ ...composerOptions, attachments: [] }),
      );
      setComposerOptions({ ...composerOptions, attachments: [] });
      onCreated(result.threadId);
    },
  });
  return (
    <section className="remote-new-task" aria-labelledby="remote-new-title">
      <header className="remote-header">
        <button
          className="remote-icon remote-floating"
          aria-label="取消新建任务"
          onClick={onClose}
          disabled={create.isPending}
        >
          <SfSymbol name="chevron.left" />
        </button>
        <h2 id="remote-new-title" className="remote-sr-only">
          新任务
        </h2>
      </header>
      <div className="remote-new-space" />
      <footer className="remote-new-footer">
        <div className="remote-new-options">
          <label className="remote-project-choice">
            <SfSymbol name="folder" />
            <span className="remote-project-select">
              <span className="remote-project-select-size" aria-hidden="true">
                {projects.data?.find((item) => item.id === project)?.name ?? "最近"}
              </span>
              <select
                aria-label="工作位置"
                value={project}
                disabled={create.isPending || projects.isPending || !!createdThread}
                onChange={(e) => {
                  setProject(e.target.value);
                  key.current = createUuid();
                  create.reset();
                }}
              >
                <option value="">最近</option>
                {projects.data
                  ?.filter((p) => p.kind === "codex" && p.syncState !== "stale")
                  .map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </span>
          </label>
        </div>
        <ErrorMessage error={create.error} />
        <ErrorMessage
          error={projects.error}
          retry={() => void projects.refetch()}
          refreshing={projects.isFetching}
        />
        <RemoteComposer
          csrf={csrf}
          draft={draft}
          onDraft={setDraft}
          options={composerOptions}
          onOptions={setComposerOptions}
          disabled={projects.isPending || projects.isError}
          pending={create.isPending}
          submitLabel="创建"
          inputLabel="新任务消息"
          placeholder="有什么需要帮忙？"
          onSubmit={() => create.mutate()}
        />
      </footer>
    </section>
  );
}

function RemoteConversation({
  id,
  csrf,
  onBack,
}: {
  id: string;
  csrf: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const [composerOptions, setComposerOptions] = useRemoteComposerOptions(id);
  const conversation = useQuery({
    queryKey: ["remote-thread", id],
    queryFn: ({ signal }) => readRemoteThread(id, signal),
    refetchInterval: (query) => (query.state.error ? false : 2_000),
    retry: false,
    staleTime: 0,
  });
  const thread = conversation.isFetchedAfterMount ? conversation.data : undefined;
  const [draft, setDraft] = useRemoteDraft(id);
  const [editingBefore, setEditingBefore] = useState<string | undefined>(
    () => readRemoteComposerValue(`remote-queue-before:${id}`) || undefined,
  );
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState<string>();
  const [copyGuidance, setCopyGuidance] = useState<string>();
  const [renaming, setRenaming] = useState(false);
  const [changes, setChanges] = useState<{ turnId: string; path?: string } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const scrollHeight = useRef(0);
  const contentHeight = useRef(0);
  useLayoutEffect(() => {
    const box = scroll.current;
    if (!box) return;
    scrollHeight.current = box.clientHeight;
    contentHeight.current = box.scrollHeight;
    const observer = new ResizeObserver(() => {
      scrollHeight.current = box.clientHeight;
      contentHeight.current = box.scrollHeight;
      const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
      if (pinnedToBottom.current && box.scrollTop < bottom - 1) box.scrollTop = bottom;
    });
    observer.observe(box);
    if (scrollContent.current) observer.observe(scrollContent.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (editingBefore) writeRemoteComposerValue(`remote-queue-before:${id}`, editingBefore);
    else writeRemoteComposerValue(`remote-queue-before:${id}`, null);
  }, [id, editingBefore]);
  useLayoutEffect(() => {
    const box = scroll.current;
    if (!box || !pinnedToBottom.current) return;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    // Leave native momentum and bottom overscroll alone. An unchanged poll must
    // not reset WebKit's scroll animation, even to the same clamped position.
    if (box.scrollTop < bottom - 1) box.scrollTop = bottom;
  }, [thread?.turns, thread?.queue, thread?.requests, thread?.status]);
  const mutation = useMutation({
    mutationFn: ({ action, key }: { action: RemoteAction; key: string }) =>
      remoteAction(id, action, csrf, key),
    retry: false,
    onSuccess: (_, { action }) => {
      if (
        action.type === "send" ||
        action.type === "steer" ||
        (action.type === "queue" && action.operation === "append")
      ) {
        setEditingBefore(undefined);
        setDraft("");
        setComposerOptions((previous) => ({ ...previous, attachments: [] }));
        writeRemoteComposerValue(`remote-send:${id}`, null);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["remote-thread", id] });
      void queryClient.invalidateQueries({ queryKey: ["remote-threads"] });
    },
  });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const result = await conversation.refetch();
      if (result.isSuccess) mutation.reset();
    } finally {
      setRefreshing(false);
    }
  };
  const act = (action: RemoteAction) => mutation.mutate({ action, key: createUuid() });
  const send = (queue = false) => {
    if (!draft.trim() && !composerOptions.attachments.length) return;
    if (queue && (!thread?.activeTurnId || !thread.queue?.available || !thread.queue.token)) return;
    const action: RemoteAction = queue
      ? {
          type: "queue",
          operation: "append",
          turnId: thread!.activeTurnId!,
          queueToken: thread!.queue!.token!,
          text: draft.trim(),
          ...(composerOptions.attachments.length
            ? { attachments: composerOptions.attachments.map((file) => file.id) }
            : {}),
          ...(editingBefore ? { beforeMessageId: editingBefore } : {}),
        }
      : {
          type: "send",
          text: draft.trim(),
          approvalMode: composerOptions.approvalMode,
          ...(composerOptions.serviceTier !== undefined
            ? { serviceTier: composerOptions.serviceTier }
            : {}),
          ...(composerOptions.model
            ? { model: composerOptions.model, effort: composerOptions.effort }
            : {}),
          ...(composerOptions.attachments.length
            ? { attachments: composerOptions.attachments.map((file) => file.id) }
            : {}),
        };
    const fingerprint = JSON.stringify(
      action.type === "queue" ? { ...action, queueToken: undefined } : action,
    );
    let key = createUuid();
    try {
      const saved = JSON.parse(readRemoteComposerValue(`remote-send:${id}`) ?? "null") as {
        fingerprint?: string;
        key?: string;
      } | null;
      if (saved?.fingerprint === fingerprint && saved.key) key = saved.key;
    } catch {
      /* A corrupt local receipt must not break the composer. */
    }
    writeRemoteComposerValue(`remote-send:${id}`, JSON.stringify({ fingerprint, key }));
    pinnedToBottom.current = true;
    mutation.mutate({ action, key });
  };
  const busy =
    thread?.status === "active" || thread?.status === "waiting" || Boolean(thread?.activeTurnId);
  const unavailable = !thread || conversation.isError || mutation.isPending || refreshing;
  const canSteer = Boolean(thread?.activeTurnId && !thread.requests.length);
  const canQueue = Boolean(thread?.activeTurnId && thread.queue?.available && thread.queue.token);
  const queueAction = async (
    operation: "take" | "cancel" | "steer",
    message: NonNullable<RemoteThread["queue"]>["messages"][number],
  ) => {
    if (!thread?.queue?.token) return;
    const action: RemoteAction = {
      type: "queue",
      operation,
      queueToken: thread.queue.token,
      messageId: message.id,
      ...(operation === "steer" && thread.activeTurnId ? { turnId: thread.activeTurnId } : {}),
    };
    const fingerprint = JSON.stringify(action);
    const stored = readRemoteComposerValue(`remote-queue-action:${id}`);
    let key = createUuid();
    try {
      const receipt = JSON.parse(stored ?? "null");
      if (receipt?.fingerprint === fingerprint) key = receipt.key;
    } catch {
      /* Keep the original message on a malformed receipt. */
    }
    writeRemoteComposerValue(`remote-queue-action:${id}`, JSON.stringify({ fingerprint, key }));
    if (operation !== "cancel") {
      writeRemoteComposerValue(`remote-queue-recovery:${id}`, message.text);
      writeRemoteComposerValue(
        `remote-queue-recovery-options:${id}`,
        JSON.stringify({ ...composerOptions, attachments: message.attachments ?? [] }),
      );
    }
    const restore = () => {
      setDraft(message.text);
      setComposerOptions((options) => ({ ...options, attachments: message.attachments ?? [] }));
    };
    const index = thread.queue.messages.findIndex((item) => item.id === message.id);
    try {
      await mutation.mutateAsync({ action, key });
      if (operation === "take") {
        restore();
        setEditingBefore(thread.queue.messages[index + 1]?.id);
        requestAnimationFrame(() => composer.current?.focus());
      }
      writeRemoteComposerValue(`remote-queue-recovery:${id}`, null);
      writeRemoteComposerValue(`remote-queue-recovery-options:${id}`, null);
    } catch {
      if (operation === "steer" && !draft.trim() && !composerOptions.attachments.length) restore();
    }
  };
  return (
    <>
      <header className="remote-header remote-conversation-header">
        <button className="remote-icon remote-floating" aria-label="返回任务" onClick={onBack}>
          <SfSymbol name="chevron.left" />
        </button>
        <div className="remote-heading">
          <strong>{thread?.title || "Codex"}</strong>
          <small>{thread ? `${folder(thread.cwd)} · 此电脑` : "连接桌面…"}</small>
        </div>
        <button
          className="remote-icon remote-floating"
          aria-label="对话选项"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <SfSymbol name="ellipsis" />
        </button>
      </header>
      {menu && (
        <div className="remote-menu">
          <button
            disabled={!thread || conversation.isError}
            onClick={() => {
              setReviewing(true);
              setMenu(false);
            }}
          >
            <RemoteMenuIcon name="changes" />
            查看代码改动
          </button>
          <button
            disabled={unavailable}
            onClick={() => {
              setRenaming(true);
              setMenu(false);
            }}
          >
            <RemoteMenuIcon name="rename" />
            重命名
          </button>
          {busy && !!thread?.requests.length && (
            <button
              aria-label="停止 Codex"
              disabled={unavailable || !thread.activeTurnId}
              onClick={() => {
                if (thread.activeTurnId) act({ type: "stop", turnId: thread.activeTurnId });
                setMenu(false);
              }}
            >
              停止任务
            </button>
          )}
        </div>
      )}
      {renaming && thread && (
        <RenameRemoteThread
          id={id}
          title={thread.title}
          csrf={csrf}
          onClose={() => setRenaming(false)}
        />
      )}
      <ErrorMessage
        error={conversation.error}
        retry={() => void refresh()}
        refreshing={refreshing}
      />
      {copyGuidance && <RemoteNotice role="status">{copyGuidance}</RemoteNotice>}
      <div
        className="remote-messages"
        ref={scroll}
        onScroll={() => {
          const box = scroll.current;
          // Layout-driven scroll events must not cancel bottom following while
          // images, diagrams or collapsed activity change the content height.
          if (
            box &&
            box.clientHeight === scrollHeight.current &&
            box.scrollHeight === contentHeight.current
          )
            pinnedToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
        }}
      >
        <div className="remote-message-content" ref={scrollContent}>
          {(!conversation.isFetchedAfterMount || conversation.isPending) && (
            <p className="remote-empty" role="status">
              正在连接桌面对话…
            </p>
          )}
          {thread && !thread.historyComplete && (
            <button
              className="remote-load-more"
              disabled={unavailable}
              onClick={() => act({ type: "history" })}
            >
              加载更早的消息
            </button>
          )}
          {thread && thread.turns.length === 0 && (
            <div className="remote-empty">
              <h2>有什么需要帮忙？</h2>
              <p>发送消息，Codex 会在你的电脑 上执行。</p>
            </div>
          )}
          {thread?.turns.map((turn) => (
            <section className="remote-turn" key={turn.id}>
              <RemoteTurnContent
                turn={turn}
                showActivityStatus={
                  turn.id === thread.activeTurnId &&
                  !thread.requests.length &&
                  thread.status !== "waiting"
                }
                changes={
                  turn.diff ? (
                    <RemoteDiffSummary
                      diff={turn.diff}
                      onOpen={(path) => setChanges({ turnId: turn.id, ...(path ? { path } : {}) })}
                    />
                  ) : null
                }
                renderItem={(item, action, after) =>
                  item.type === "userMessage" ? (
                    <div className="remote-user-entry" key={item.id}>
                      <RemoteImages threadId={thread.id} item={item} />
                      {item.text && <div className="remote-user-message">{item.text}</div>}
                      <div className="remote-user-actions">
                        {item.text && (
                          <button
                            className="remote-copy"
                            aria-label="复制消息"
                            title="复制消息"
                            onClick={() => {
                              void copyText(item.text).then((result) => {
                                if (result.copied) {
                                  setCopied(item.id);
                                  setCopyGuidance(undefined);
                                } else {
                                  setCopied(undefined);
                                  setCopyGuidance(result.guidance);
                                }
                              });
                            }}
                          >
                            <RemoteGlyph name="copy" />
                            <span className={copied === item.id ? "" : "remote-sr-only"}>
                              {copied === item.id ? "已复制" : "复制"}
                            </span>
                          </button>
                        )}
                        {thread.editableMessage?.itemId === item.id && !busy && (
                          <RemoteEditMessage
                            key={`${item.id}-${thread.editableMessage.token}`}
                            text={item.text}
                            candidate={thread.editableMessage}
                            disabled={unavailable}
                            onSubmit={(action) =>
                              mutation.mutateAsync({ action, key: createUuid() })
                            }
                          />
                        )}
                      </div>
                    </div>
                  ) : item.type === "agentMessage" || item.type === "plan" ? (
                    <article className="remote-agent-message" key={item.id}>
                      {!item.asyncQuestions?.length && <MarkdownContent markdown={item.text} />}
                      <RemoteAsyncQuestions
                        item={item}
                        disabled={unavailable}
                        onSubmit={(action) => mutation.mutateAsync({ action, key: createUuid() })}
                      />
                      {after}
                      <button
                        className="remote-copy"
                        aria-label="复制回复"
                        onClick={() => {
                          void copyText(item.text).then((result) => {
                            if (result.copied) {
                              setCopied(item.id);
                              setCopyGuidance(undefined);
                            } else {
                              setCopied(undefined);
                              setCopyGuidance(result.guidance);
                            }
                          });
                        }}
                      >
                        <RemoteGlyph name="copy" />
                        <span className={copied === item.id ? "" : "remote-sr-only"}>
                          {copied === item.id ? "已复制" : "复制"}
                        </span>
                      </button>
                    </article>
                  ) : (
                    <RemoteToolItem
                      key={item.id}
                      item={item}
                      threadId={thread.id}
                      action={action}
                    />
                  )
                }
              />
              {turn.error && <RemoteNotice>本次执行未完成，请重试或补充说明。</RemoteNotice>}
              {turn.status === "interrupted" && <p className="remote-muted">已停止</p>}
            </section>
          ))}
          {thread?.queue && (
            <RemoteQueuedMessages
              queue={thread.queue}
              disabled={unavailable}
              canSteer={canSteer}
              hasDraft={Boolean(draft.trim() || composerOptions.attachments.length)}
              onAction={queueAction}
            />
          )}
          {busy &&
            !thread?.queue?.messages.length &&
            (thread?.status === "waiting" ||
              !thread?.turns.some((turn) => turn.status === "inProgress")) && (
              <div className="remote-working" role="status">
                {thread?.status === "waiting" ? (
                  <>
                    <span className="remote-waiting-dot" />
                    等待你的回复
                  </>
                ) : (
                  <span className="remote-thinking">正在思考</span>
                )}
              </div>
            )}
        </div>
      </div>
      <footer className="remote-composer-area">
        <ErrorMessage error={mutation.error} retry={() => void refresh()} refreshing={refreshing} />
        {thread && <RemoteReviewShortcut id={id} onOpen={() => setReviewing(true)} />}
        {thread?.requests.length ? (
          <div className="remote-request-dock" aria-label="等待处理的请求">
            {" "}
            {thread?.requests.map((request) =>
              request.approval ? (
                <RemoteApprovalForm
                  key={`${request.id}:${request.approval.token}`}
                  requestId={request.id}
                  approval={request.approval}
                  disabled={unavailable}
                  onRespond={act}
                />
              ) : (
                <RemoteApproval
                  key={String(request.id)}
                  request={request}
                  disabled={unavailable}
                  onRespond={act}
                  draft={draft}
                  onDraftChange={setDraft}
                />
              ),
            )}
          </div>
        ) : null}
        {!thread?.requests.some((r) => ["permissions", "command", "file"].includes(r.kind)) && (
          <RemoteComposer
            csrf={csrf}
            draft={draft}
            onDraft={setDraft}
            options={composerOptions}
            onOptions={setComposerOptions}
            inputRef={composer}
            currentModel={thread?.model}
            currentEffort={thread?.effort}
            disabled={unavailable}
            pending={mutation.isPending}
            busy={!!busy}
            canQueue={canQueue}
            placeholder={busy ? "跟进" : "在此电脑 上工作"}
            onSubmit={() => {
              if (!unavailable && (!busy || canQueue)) send(!!busy);
            }}
            onStop={() => {
              if (thread?.activeTurnId) act({ type: "stop", turnId: thread.activeTurnId });
            }}
          />
        )}
        <p className="remote-composer-note remote-sr-only">
          在 Mac 上执行 · {thread?.model || "沿用桌面设置"}
          {thread?.effort ? ` · ${thread.effort}` : ""}
        </p>
      </footer>
      {changes && (
        <RemoteReview
          id={id}
          turnId={changes.turnId}
          initialPath={changes.path}
          onClose={() => setChanges(null)}
        />
      )}
      {reviewing && <RemoteReview id={id} onClose={() => setReviewing(false)} />}
    </>
  );
}

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="remote-diff-counts">
      <span className="remote-added">+{added}</span>
      <span className="remote-removed">−{removed}</span>
    </span>
  );
}

function RemoteDiffSummary({ diff, onOpen }: { diff: string; onOpen: (path?: string) => void }) {
  const files = parseRemoteDiff(diff);
  const [expanded, setExpanded] = useState(true);
  return (
    <div className={`remote-diff-summary${expanded ? " is-expanded" : ""}`}>
      <button
        className="remote-diff-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span>已更改 {files.length} 个文件</span>
        <DiffCounts
          added={files.reduce((sum, file) => sum + file.added, 0)}
          removed={files.reduce((sum, file) => sum + file.removed, 0)}
        />
        <SfSymbol name="chevron.right" />
      </button>
      <div className="remote-diff-collapse" inert={!expanded}>
        <div className="remote-diff-rows">
          {files.slice(0, 3).map((file, index) => (
            <button
              key={index}
              aria-label={`查看 ${file.path} 的改动`}
              onClick={() => onOpen(file.path)}
            >
              <span className="remote-diff-path" title={file.path}>
                {file.path}
              </span>
              <DiffCounts added={file.added} removed={file.removed} />
            </button>
          ))}
          {files.length > 3 && (
            <button className="remote-diff-more" onClick={() => onOpen()}>
              <span>查看另外 {files.length - 3} 个文件</span>
              <SfSymbol name="chevron.right" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RenameRemoteThread({
  id,
  title,
  csrf,
  onClose,
}: {
  id: string;
  title: string;
  csrf: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(title);
  const key = useRef(createUuid());
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: () => remoteAction(id, { type: "rename", name: name.trim() }, csrf, key.current),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["remote-thread", id] });
      void queryClient.invalidateQueries({ queryKey: ["remote-threads"] });
      onClose();
    },
  });
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.select();
  }, []);
  return (
    <dialog
      className="remote-rename-dialog"
      ref={dialog}
      aria-labelledby="remote-rename-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!rename.isPending) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && !rename.isPending) rename.mutate();
        }}
      >
        <h2 id="remote-rename-title">重命名任务</h2>
        <input
          ref={input}
          aria-label="对话名称"
          value={name}
          maxLength={120}
          disabled={rename.isPending}
          onChange={(event) => {
            setName(event.target.value);
            key.current = createUuid();
            rename.reset();
          }}
        />
        <ErrorMessage error={rename.error} />
        <div className="remote-rename-actions">
          <button type="button" disabled={rename.isPending} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            disabled={!name.trim() || name.trim() === title || rename.isPending}
          >
            {rename.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function RemoteApproval({
  request,
  disabled,
  onRespond,
  draft,
  onDraftChange,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  request: RemoteRequest;
  disabled: boolean;
  onRespond: (action: RemoteAction) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (["permissions", "command", "file"].includes(request.kind)) {
    const permission = request.kind === "permissions";
    const respond = (decision: "accept" | "acceptForSession" | "decline" | "cancel") =>
      onRespond({
        type: "respond",
        requestId: request.id,
        decision,
        ...(permission ? { permissionToken: request.permissionToken } : {}),
      });
    const decline = request.decisions.includes("decline") ? "decline" : "cancel";
    return (
      <section
        className="remote-approval remote-permission-approval"
        aria-label={permission ? "权限审批" : request.title}
      >
        <header>
          <p className="remote-request-label">请求权限</p>
          <h3>{request.title}</h3>
        </header>
        <div className="remote-permission-body" tabIndex={0} aria-label="申请的权限范围">
          {permission ? (
            <>
              {request.permissionReason && <p>{request.permissionReason}</p>}
              <div className="remote-permission-paths">
                {request.permissionDescription || request.detail}
              </div>
              {request.permissionCwd && (
                <details className="remote-permission-cwd">
                  <summary>工作目录</summary>
                  <p>{request.permissionCwd}</p>
                </details>
              )}
            </>
          ) : (
            <pre className="remote-command">
              <SfSymbol name={request.kind === "file" ? "folder" : "apple.terminal"} />
              <span>{request.detail}</span>
            </pre>
          )}
        </div>
        <div className="remote-approval-actions">
          {request.decisions.includes("accept") && (
            <button
              className="remote-approve"
              disabled={disabled || (permission && !request.permissionToken)}
              onClick={() => respond("accept")}
            >
              允许一次
            </button>
          )}
          {request.decisions.includes("acceptForSession") && (
            <button
              className="remote-session-approve"
              disabled={disabled || (permission && !request.permissionToken)}
              onClick={() => respond("acceptForSession")}
            >
              本次会话允许
            </button>
          )}
        </div>
        <div className="remote-approval-followup">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15z" />
          </svg>
          <textarea
            aria-label="发送给 Codex"
            placeholder="告诉 Codex 如何调整"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            rows={1}
            maxLength={100000}
          />
          {request.decisions.includes(decline) && (
            <button
              className="remote-decline"
              disabled={disabled || (permission && !request.permissionToken)}
              onClick={() => respond(decline)}
            >
              {decline === "decline" ? "拒绝" : "取消"}
            </button>
          )}
        </div>
        {draft.trim() && (
          <RemoteNotice className="remote-approval-draft-hint" role="status">
            补充要求已存为草稿，处理审批后可发送。
          </RemoteNotice>
        )}
      </section>
    );
  }
  return (
    <section className="remote-approval" aria-label={request.title}>
      <p className="remote-request-label">
        {request.kind === "input" ? "需要你的回复" : "请求权限"}
      </p>
      <h3>{request.title}</h3>
      {request.detail && (
        <pre className="remote-command">
          <SfSymbol name={request.kind === "file" ? "folder" : "apple.terminal"} />
          {request.detail}
        </pre>
      )}
      {request.kind === "unsupported" ? (
        <p>此请求需要在 Mac 上处理，完成后会自动同步。</p>
      ) : request.kind === "input" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRespond({
              type: "respond",
              requestId: request.id,
              answers: Object.fromEntries(
                request.questions.map((q) => [q.id, [answers[q.id] ?? ""]]),
              ),
            });
          }}
        >
          {request.questions.map((q) => (
            <fieldset key={q.id} disabled={disabled}>
              <legend>
                {q.header ? `${q.header}：` : ""}
                {q.question}
              </legend>
              {q.options.map((option) => (
                <label className="remote-option" key={option.label}>
                  <input
                    type="radio"
                    name={`${request.id}-${q.id}`}
                    checked={answers[q.id] === option.label}
                    onChange={() => setAnswers({ ...answers, [q.id]: option.label })}
                  />
                  <span>
                    {option.label}
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
              <input
                aria-label={q.question}
                type={q.isSecret ? "password" : "text"}
                placeholder="输入回复"
                maxLength={10_000}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            </fieldset>
          ))}
          <button
            disabled={
              disabled ||
              !request.questions.length ||
              request.questions.some((q) => !answers[q.id]?.trim())
            }
          >
            提交回复
          </button>
        </form>
      ) : (
        <div className="remote-approval-actions">
          {request.decisions.map((decision) => (
            <button
              key={decision}
              className={decision === "accept" ? "remote-approve" : "remote-decline"}
              disabled={disabled}
              onClick={() =>
                onRespond({
                  type: "respond",
                  requestId: request.id,
                  decision,
                })
              }
            >
              {decision === "accept"
                ? "允许一次"
                : decision === "acceptForSession"
                  ? "本次会话允许"
                  : decision === "decline"
                    ? "拒绝"
                    : "取消"}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
