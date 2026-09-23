import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectorySync, ensurePrivateFileSync } from "./private-file-permissions.mjs";

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || /[\r\n]/.test(value)) {
    throw new Error(`${label}必须是不含换行的绝对路径`);
  }
  return resolve(value);
}

function projectRecord(value, codexProjectId, position) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex 项目 ${codexProjectId} 的记录无效`);
  }
  if (value.id !== codexProjectId) {
    throw new Error(`Codex 项目 ${codexProjectId} 的 ID 不一致`);
  }
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 120 || /[\r\n]/.test(name)) {
    throw new Error(`Codex 项目 ${codexProjectId} 的名称无效`);
  }
  if (!Array.isArray(value.rootPaths) || value.rootPaths.length === 0) {
    throw new Error(`Codex 项目 ${codexProjectId} 缺少源文件夹`);
  }
  const rootPaths = value.rootPaths.map((rootPath) =>
    absolutePath(rootPath, `Codex 项目 ${codexProjectId} 的源文件夹`),
  );
  if (new Set(rootPaths).size !== rootPaths.length) {
    throw new Error(`Codex 项目 ${codexProjectId} 的源文件夹重复`);
  }
  return { codexProjectId, name, rootPaths, position };
}

export function readCodexDesktopProjects(stateFile) {
  const path = absolutePath(stateFile, "Codex 项目状态文件");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Codex 项目状态文件必须是普通文件");
  }
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Codex 项目状态格式无效");
  }
  const localProjects = state["local-projects"];
  const projectOrder = state["project-order"];
  if (!localProjects || typeof localProjects !== "object" || Array.isArray(localProjects)) {
    throw new Error("Codex 项目状态缺少 local-projects");
  }
  // A fresh Desktop installation can omit project-order until its first
  // project. Only a valid, empty project map makes that omission unambiguous.
  if (projectOrder === undefined && Object.keys(localProjects).length === 0) return [];
  if (!Array.isArray(projectOrder)) {
    throw new Error("Codex 项目状态缺少 project-order");
  }
  if (new Set(projectOrder).size !== projectOrder.length) {
    throw new Error("Codex 项目顺序包含重复 ID");
  }
  return projectOrder.map((codexProjectId, position) => {
    if (typeof codexProjectId !== "string" || !codexProjectId || /[\r\n]/.test(codexProjectId)) {
      throw new Error("Codex 项目顺序包含无效 ID");
    }
    return projectRecord(localProjects[codexProjectId], codexProjectId, position);
  });
}

function normalizedSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.projects)) {
    throw new Error("Codex 项目快照格式无效");
  }
  const generatedAt = new Date(snapshot.generatedAt).toISOString();
  const projects = snapshot.projects.map((project, position) => {
    if (project?.position !== position) throw new Error("Codex 项目快照顺序无效");
    return projectRecord(
      {
        id: project.codexProjectId,
        name: project.name,
        rootPaths: project.rootPaths,
      },
      project.codexProjectId,
      position,
    );
  });
  return { schemaVersion: 1, generatedAt, projects };
}

export function writeProjectSnapshot(snapshotFile, snapshot) {
  const path = absolutePath(snapshotFile, "Codex 项目快照文件");
  const directory = dirname(path);
  ensurePrivateDirectorySync(directory);
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Codex 项目快照目录必须是普通目录");
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(normalizedSnapshot(snapshot))}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    ensurePrivateFileSync(temporary);
    renameSync(temporary, path);
    // Node cannot fsync directory handles on Windows. The file is still flushed
    // before atomic replacement; directory durability is available on POSIX.
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
    return true;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function startCodexProjectSnapshotWriter(options) {
  const stateFile = absolutePath(options.stateFile, "Codex 项目状态文件");
  const snapshotFile = absolutePath(options.snapshotFile, "Codex 项目快照文件");
  const debounceMs = options.debounceMs ?? 250;
  const reconcileMs = options.reconcileMs ?? 30_000;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  const watchFactory = options.watchFactory ?? watch;
  let closed = false;
  let debounceTimer;

  const refresh = () => {
    if (closed) return false;
    let projects;
    try {
      projects = readCodexDesktopProjects(stateFile);
    } catch {
      onError({ code: "CODEX_PROJECT_STATE_INVALID" });
      return false;
    }
    try {
      writeProjectSnapshot(snapshotFile, {
        schemaVersion: 1,
        generatedAt: now().toISOString(),
        projects,
      });
      return true;
    } catch {
      onError({ code: "CODEX_PROJECT_SNAPSHOT_WRITE_FAILED" });
      return false;
    }
  };

  if (!refresh()) throw new Error("Codex Desktop 项目快照初始化失败");
  const scheduleRefresh = () => {
    if (closed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, debounceMs);
  };
  let watcher;
  try {
    watcher = watchFactory(dirname(stateFile), (eventType, filename) => {
      if (!filename || filename.toString() === basename(stateFile)) scheduleRefresh();
    });
    watcher.on?.("error", () => onError({ code: "CODEX_PROJECT_WATCH_FAILED" }));
  } catch {
    onError({ code: "CODEX_PROJECT_WATCH_FAILED" });
  }
  const reconcileTimer = setInterval(refresh, reconcileMs);

  return {
    refresh,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(debounceTimer);
      clearInterval(reconcileTimer);
      watcher?.close();
    },
  };
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  const value = index >= 0 ? arguments_[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`选项 ${name} 缺少值`);
  return value;
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  try {
    const writer = startCodexProjectSnapshotWriter({
      stateFile: argumentValue(process.argv, "--state-file"),
      snapshotFile: argumentValue(process.argv, "--snapshot-file"),
    });
    const stop = () => {
      writer.close();
      process.exitCode = 0;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, code: "CODEX_PROJECT_SNAPSHOT_FAILED", message: error instanceof Error ? error.message : "Codex Desktop 项目快照启动失败" })}\n`,
    );
    process.exitCode = 1;
  }
}
