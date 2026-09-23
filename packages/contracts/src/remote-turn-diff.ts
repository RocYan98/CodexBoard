const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Desktop may record edits as fileChange items without publishing turn.diff. */
export function remoteTurnDiff(value: unknown, cwd: string): string {
  const turn = record(value);
  if (text(turn.diff).trim()) return text(turn.diff);
  const patches = new Map<string, { header: string; hunks: string[] }>();
  const relative = (value: unknown) => {
    const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
    const path = windows ? text(value).replaceAll("\\", "/") : text(value);
    const root = windows ? cwd.replaceAll("\\", "/") : cwd;
    const prefix = `${root.replace(/\/$/, "")}/`;
    const contained = windows
      ? path.toLowerCase().startsWith(prefix.toLowerCase())
      : path.startsWith(prefix);
    return contained ? path.slice(prefix.length) : path;
  };
  for (const raw of Array.isArray(turn.items) ? turn.items : []) {
    const item = record(raw);
    if (item.type !== "fileChange" || item.status !== "completed") continue;
    for (const rawChange of Array.isArray(item.changes) ? item.changes : []) {
      const change = record(rawChange),
        kind = record(change.kind);
      const source = relative(change.path),
        path = relative(kind.move_path) || source;
      const diff = text(change.diff);
      if (!path || !diff) continue;
      const a = JSON.stringify(`a/${source}`),
        b = JSON.stringify(`b/${path}`);
      let header = `diff --git ${a} ${b}\n`;
      if (kind.type === "add") header += "new file mode 100644\n";
      if (kind.type === "delete") header += "deleted file mode 100644\n";
      if (path !== source)
        header += `rename from ${JSON.stringify(source)}\nrename to ${JSON.stringify(path)}\n`;
      header += `--- ${kind.type === "add" ? "/dev/null" : a}\n+++ ${kind.type === "delete" ? "/dev/null" : b}\n`;
      let hunks = diff;
      if (!/^@@ /m.test(diff) && (kind.type === "add" || kind.type === "delete")) {
        const lines = diff.replace(/\n$/, "").split("\n");
        const add = kind.type === "add";
        hunks = `@@ -${add ? "0,0" : `1,${lines.length}`} +${add ? `1,${lines.length}` : "0,0"} @@\n${lines.map((line) => `${add ? "+" : "-"}${line}`).join("\n")}\n`;
      }
      // Keep all recorded edits to a file in item order, without reading today's worktree.
      const entry = patches.get(path) ?? { header, hunks: [] };
      entry.hunks.push(hunks.endsWith("\n") ? hunks : `${hunks}\n`);
      patches.set(path, entry);
    }
  }
  return [...patches.values()].map((entry) => entry.header + entry.hunks.join("")).join("");
}
