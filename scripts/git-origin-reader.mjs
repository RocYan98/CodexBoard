import { createReadStream } from "node:fs";
import { readdir, stat, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const execute = promisify(execFile);
const cache = new Map();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// Deliberately accepts only literal shell words. Never evaluate shell text, substitutions or scripts.
function shellCommands(text, windowsShell = false) {
  const commands = [];
  let words = [],
    word = "",
    quote = null;
  const flush = () => {
    if (word) words.push(word);
    word = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`" || c === "$" || c === "<" || c === ">") return [];
    if (c === "\\" && quote !== "'" && !windowsShell) {
      word += text[++i] ?? "";
      continue;
    }
    if (quote) {
      if (windowsShell && c === quote && text[i + 1] === quote) return [];
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (windowsShell && [";", "\n", "&"].includes(c)) return [];
    if (c === ";" || c === "\n" || c === "&") {
      flush();
      if (words.length) commands.push(words);
      words = [];
      continue;
    }
    if (c === "|" || c === "(" || c === ")" || c === "#") return [];
    if (/\s/.test(c)) flush();
    else word += c;
  }
  if (quote) return [];
  flush();
  if (words.length) commands.push(words);
  return commands;
}

function creations(item) {
  let cwd;
  try {
    cwd = item.cwd.startsWith("file:") ? fileURLToPath(item.cwd) : item.cwd;
  } catch {
    return [];
  }
  if (!isAbsolute(cwd)) return [];
  const command = item.command;
  if (!Array.isArray(command)) return [];
  const commandName = (value) => value.split(/[\\/]/).at(-1).toLowerCase();
  const program = commandName(command[0] ?? "");
  const windowsShell = ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(program);
  if (windowsShell) {
    const flag = command.at(-2)?.toLowerCase();
    if (!["-command", "-c"].includes(flag)) return [];
    if (
      command
        .slice(1, -2)
        .some((arg) => !["-noprofile", "-nologo", "-noninteractive"].includes(arg.toLowerCase()))
    )
      return [];
  }
  const shell = windowsShell || ["sh", "bash", "zsh"].includes(program);
  const groups = shell ? shellCommands(command.at(-1) ?? "", windowsShell) : [command];
  // PowerShell's final exit status cannot prove earlier statements succeeded.
  // Attribute a single literal native Git invocation; complex scripts stay unknown.
  if (windowsShell && groups.length !== 1) return [];
  const result = [];
  for (const group of groups) {
    if (group[0] === "cd" && group.length === 2) {
      cwd = resolve(cwd, group[1]);
      continue;
    }
    const args = [...group];
    if (!["git", "git.exe"].includes(commandName(args.shift() ?? ""))) continue;
    let directory = cwd;
    if (args[0] === "-C" && args[1]) {
      directory = resolve(cwd, args[1]);
      args.splice(0, 2);
    }
    const operation = args.shift();
    if (operation === "branch") {
      if (args[0] === "--") args.shift();
      if (args[0] && !args[0].startsWith("-") && args.length <= 2)
        result.push({ cwd: directory, branch: args[0], path: null, createsBranch: true });
    } else if (
      ["switch", "checkout"].includes(operation) &&
      ["-c", "-b"].includes(args[0]) &&
      args[1]
    ) {
      result.push({ cwd: directory, branch: args[1], path: null, createsBranch: true });
    } else if (operation === "worktree" && args.shift() === "add") {
      let branch = null,
        createsBranch = false,
        valid = true;
      const positional = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-b") {
          branch = args[++i];
          createsBranch = true;
        } else if (args[i] === "--detach" || args[i] === "--") continue;
        else if (args[i].startsWith("-")) {
          valid = false;
          break;
        } else positional.push(args[i]);
      }
      if (valid && positional[0])
        result.push({
          cwd: directory,
          branch: branch ?? positional[1] ?? null,
          path: resolve(directory, positional[0]),
          createsBranch,
        });
    }
  }
  return result;
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}
async function events(path) {
  const info = await stat(path);
  const previous = cache.get(path);
  if (previous?.size === info.size && previous?.mtime === info.mtimeMs) return previous.events;
  const found = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"item_completed"') || !line.includes('"CommandExecution"')) continue;
    try {
      const record = JSON.parse(line);
      const p = record.payload;
      if (
        record.type !== "event_msg" ||
        p?.type !== "item_completed" ||
        p.item?.type !== "CommandExecution" ||
        p.item.exit_code !== 0 ||
        !uuid.test(p.thread_id)
      )
        continue;
      const start = p.started_at_ms;
      const end = p.completed_at_ms ?? Date.parse(record.timestamp);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      for (const creation of creations(p.item))
        found.push({ ...creation, threadId: p.thread_id, start, end });
    } catch {
      /* Incomplete last lines are retried after the file changes. */
    }
  }
  cache.set(path, { size: info.size, mtime: info.mtimeMs, events: found });
  if (cache.size > 256) cache.delete(cache.keys().next().value);
  return found;
}

async function titles(home, ids) {
  if (!ids.length) return {};
  const names = (await readdir(home).catch(() => []))
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (!names.length) return {};
  let db;
  try {
    db = new Database(join(home, names[0]), { readonly: true, fileMustExist: true });
    return Object.fromEntries(
      db
        .prepare(`SELECT id, name FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`)
        .all(...ids)
        .map((row) => [row.id, row.name?.trim()]),
    );
  } catch {
    return {};
  } finally {
    db?.close();
  }
}

export async function readGitOrigins(home, query) {
  if (
    !isAbsolute(home ?? "") ||
    !isAbsolute(query?.mainPath ?? "") ||
    !Array.isArray(query.resources) ||
    query.resources.length > 500
  )
    throw new Error("Invalid origin query");
  if (!query.resources.length) return {};
  const unresolved = query.resources.filter((r) => !uuid.test(r.threadId ?? ""));
  const earliest = Math.min(...unresolved.map((r) => Date.parse(r.createdAt))) - 1000;
  const all = unresolved.length
    ? [...(await files(join(home, "sessions"))), ...(await files(join(home, "archived_sessions")))]
    : [];
  const candidates = [];
  for (const path of all) {
    try {
      if ((await stat(path)).mtimeMs >= earliest) candidates.push(...(await events(path)));
    } catch {
      /* Unavailable history stays unknown. */
    }
  }
  const roots = new Map([[query.mainPath, true]]);
  async function sameRepository(cwd) {
    if (roots.has(cwd)) return roots.get(cwd);
    try {
      const common = async (root) =>
        realpath(
          resolve(
            root,
            (
              await execute("git", ["-C", root, "rev-parse", "--git-common-dir"], { timeout: 2000 })
            ).stdout.trim(),
          ),
        );
      const matches = (await common(cwd)) === (await common(query.mainPath));
      roots.set(cwd, matches);
      return matches;
    } catch {
      roots.set(cwd, false);
      return false;
    }
  }
  const result = {};
  for (const resource of query.resources) {
    if (uuid.test(resource.threadId ?? "")) {
      result[resource.key] = {
        kind: "codex",
        threadId: resource.threadId,
        createdAt: resource.createdAt,
      };
      continue;
    }
    const time = Date.parse(resource.createdAt);
    const matches = new Set();
    for (const candidate of candidates) {
      if (time < candidate.start - 2000 || time > candidate.end) continue;
      if (
        resource.kind === "branch"
          ? !candidate.createsBranch || candidate.branch !== resource.branch
          : candidate.path !== resource.path
      )
        continue;
      if (await sameRepository(candidate.cwd)) matches.add(candidate.threadId);
    }
    if (matches.size === 1)
      result[resource.key] = {
        kind: "codex",
        threadId: [...matches][0],
        createdAt: resource.createdAt,
      };
  }
  const names = await titles(home, [...new Set(Object.values(result).map((r) => r.threadId))]);
  for (const origin of Object.values(result))
    if (names[origin.threadId]) origin.threadTitle = names[origin.threadId];
  return result;
}
