import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import {
  copyRuntimeDist,
  copyRuntimeDependencies,
  copyRuntimeScripts,
  DESKTOP_RUNTIME_SCRIPT_FILES,
  RUNTIME_SCRIPT_FILES,
  listRuntimeDependencyPaths,
} from "./package-runtime.mjs";

const project = fileURLToPath(new URL("../../..", import.meta.url));

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "taskboard-package-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

// Parse actual imports, exports, dynamic imports and URL-based runtime paths,
// avoiding false dependencies from comments or string content.
function localReferences(file) {
  const imports = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).imports || {};
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const references = [];
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      specifier = node.arguments[0];
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL"
    )
      specifier = node.arguments?.[0];
    if (specifier && ts.isStringLiteral(specifier)) {
      if (specifier.text.startsWith(".")) references.push(resolve(dirname(file), specifier.text));
      else if (imports[specifier.text]) references.push(resolve(project, imports[specifier.text]));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return references;
}

function dependencyClosure(roots) {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return;
    assert.ok(existsSync(file), `Missing runtime dependency: ${file}`);
    visited.add(file);
    for (const dependency of localReferences(file)) visit(dependency);
  }
  for (const root of roots) visit(root);
  return [...visited].sort();
}

test("packaged scripts cover native/backend runtime references without development tools", (t) => {
  const runtime = temporaryDirectory(t);
  copyRuntimeScripts(project, runtime);

  const bridgeRoots = filesUnder(join(project, "apps/server/src"))
    .filter((file) => file.endsWith(".ts"))
    .flatMap(localReferences)
    .filter((file) => file.startsWith(join(project, "scripts/")));
  assert.ok(bridgeRoots.length > 0, "Backend bridge runtime paths must be checked");

  const nativeSource = filesUnder(join(project, "apps/desktop/src-tauri/src"))
    .filter((file) => file.endsWith(".rs"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const desktopRoots = [...nativeSource.matchAll(/\b\w+\.join\("desktop\/([^"/]+\.mjs)"\)/g)].map(
    (match) => join(project, "apps/desktop/scripts", match[1]),
  );
  assert.ok(desktopRoots.length > 0, "Native runtime script paths must be checked");
  const closure = dependencyClosure([...bridgeRoots, ...desktopRoots]);
  assert.deepEqual(
    closure
      .filter((file) => file.startsWith(join(project, "scripts")))
      .map((file) => relative(join(project, "scripts"), file))
      .sort(),
    [...RUNTIME_SCRIPT_FILES].sort(),
  );
  assert.deepEqual(
    closure
      .filter((file) => file.startsWith(join(project, "apps/desktop/scripts")))
      .map((file) => relative(join(project, "apps/desktop/scripts"), file))
      .sort(),
    [...DESKTOP_RUNTIME_SCRIPT_FILES].sort(),
  );

  assert.deepEqual(readdirSync(join(runtime, "scripts")).sort(), [...RUNTIME_SCRIPT_FILES].sort());
  assert.deepEqual(
    readdirSync(join(runtime, "desktop")).sort(),
    [...DESKTOP_RUNTIME_SCRIPT_FILES].sort(),
  );
  for (const path of filesUnder(runtime)) {
    assert.doesNotMatch(path, /(?:fake-|run-e2e|check-codex-protocol|\.test\.mjs|build-macos)/);
    const [category, file] = relative(runtime, path).split(sep);
    const directory = category === "desktop" ? "apps/desktop/scripts" : "scripts";
    assert.deepEqual(readFileSync(path), readFileSync(join(project, directory, file)));
  }
});

function dependencyFixture(t) {
  const fixture = temporaryDirectory(t);
  const packages = {};
  const workspaces = ["apps/server", "apps/web", "packages/contracts", "packages/taskctl"];
  function addPackage(path, name, fields = {}) {
    const manifest = { name, version: "1.0.0", ...fields };
    mkdirSync(join(fixture, path), { recursive: true });
    writeFileSync(join(fixture, path, "package.json"), JSON.stringify(manifest));
    writeFileSync(join(fixture, path, "LICENSE"), `${name} license`);
    packages[path] = manifest;
  }
  addPackage("", "fixture", {
    private: true,
    workspaces,
    dependencies: { "smol-toml": "1.0.0" },
    devDependencies: { typescript: "1.0.0" },
  });
  addPackage("apps/server", "@codexboard/server", {
    dependencies: { fastify: "1.0.0", "better-sqlite3": "1.0.0", ws: "1.0.0" },
  });
  addPackage("apps/web", "@codexboard/web", {
    dependencies: { react: "1.0.0", mermaid: "1.0.0" },
  });
  addPackage("packages/contracts", "@codexboard/contracts", { dependencies: { zod: "1.0.0" } });
  addPackage("packages/taskctl", "@codexboard/taskctl", {
    dependencies: { "@codexboard/contracts": "1.0.0" },
  });
  mkdirSync(join(fixture, "node_modules/@codexboard"), { recursive: true });
  for (const workspace of workspaces) {
    const path = `node_modules/${packages[workspace].name}`;
    symlinkSync(join(fixture, workspace), join(fixture, path), "junction");
    packages[path] = { resolved: workspace, link: true };
  }
  for (const name of ["smol-toml", "zod", "better-sqlite3", "react", "mermaid", "typescript"])
    addPackage(`node_modules/${name}`, name);
  addPackage("apps/server/node_modules/ws", "ws");
  packages["node_modules/typescript"].dev = true;
  addPackage("node_modules/fastify", "fastify", { dependencies: { cookie: "2.0.0" } });
  addPackage("node_modules/fastify/node_modules/cookie", "cookie", { version: "2.0.0" });
  writeFileSync(
    join(fixture, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return fixture;
}

test("npm selects server/CLI/root dependencies and copied packages retain nested paths and licenses", (t) => {
  const fixture = dependencyFixture(t);
  const runtime = temporaryDirectory(t);
  const paths = listRuntimeDependencyPaths(fixture);
  assert.deepEqual(paths, [
    "apps/server/node_modules/ws",
    "node_modules/better-sqlite3",
    "node_modules/fastify",
    "node_modules/fastify/node_modules/cookie",
    "node_modules/smol-toml",
    "node_modules/zod",
  ]);
  // Files not selected by npm must not piggyback on a parent's recursive copy.
  const stale = join(fixture, "node_modules/fastify/node_modules/stale-development-tool");
  mkdirSync(stale);
  writeFileSync(join(stale, "package.json"), "{}");
  const sqlite = join(fixture, "node_modules/better-sqlite3");
  mkdirSync(join(sqlite, "prebuilds"));
  writeFileSync(
    join(sqlite, `prebuilds/${process.platform}-${process.arch}.node`),
    "native binary",
  );
  mkdirSync(join(sqlite, "build"));
  writeFileSync(join(sqlite, "build/config.gypi"), "local compiler paths");
  mkdirSync(join(fixture, "node_modules/fastify/build"));
  writeFileSync(join(fixture, "node_modules/fastify/build/index.js"), "runtime module");
  copyRuntimeDependencies(fixture, runtime, paths);
  assert.equal(existsSync(join(runtime, "node_modules/better-sqlite3/build")), false);
  assert.equal(existsSync(join(sqlite, "build/config.gypi")), true);
  assert.equal(
    readFileSync(
      join(
        runtime,
        `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`,
      ),
      "utf8",
    ),
    "native binary",
  );
  assert.equal(
    readFileSync(join(runtime, "node_modules/fastify/build/index.js"), "utf8"),
    "runtime module",
  );
  assert.equal(
    existsSync(join(runtime, "node_modules/fastify/node_modules/stale-development-tool")),
    false,
  );
  for (const path of paths)
    assert.deepEqual(
      readFileSync(join(runtime, path, "LICENSE")),
      readFileSync(join(fixture, path, "LICENSE")),
    );
  for (const name of ["react", "mermaid", "typescript", "@codexboard"])
    assert.equal(existsSync(join(runtime, "node_modules", name)), false);
});

test("npm dependency paths remain relative to a symlinked project root", (t) => {
  const fixture = dependencyFixture(t);
  const projectLink = join(temporaryDirectory(t), "project-link");
  symlinkSync(fixture, projectLink, "junction");
  assert.deepEqual(listRuntimeDependencyPaths(projectLink), listRuntimeDependencyPaths(fixture));
});

test("an incomplete npm dependency tree aborts packaging", (t) => {
  const fixture = dependencyFixture(t);
  rmSync(join(fixture, "node_modules/fastify"), { recursive: true });
  assert.throws(() => listRuntimeDependencyPaths(fixture), /无法读取生产依赖/);
});

test("release dist removes debug output while preserving executable modules and resources", async (t) => {
  const directory = temporaryDirectory(t);
  const source = join(directory, "source");
  const destination = join(directory, "release");
  const files = {
    "entry.mjs":
      'export { answer } from "./nested/answer.mjs";\n//# sourceMappingURL=entry.mjs.map\n',
    "entry.mjs.map": '{"sourcesContent":["private source"]}',
    "entry.d.mts": "export declare const answer: number;",
    "entry.d.mts.map": "{}",
    "nested/answer.mjs": "export const answer = 42;\r\n//# sourceMappingURL=answer.mjs.map\r\n",
    "nested/answer.mjs.map": "{}",
    "nested/answer.d.ts": "export declare const answer: number;",
    "nested/answer.d.ts.map": "{}",
    "nested/answer.d.cts": "export declare const answer: number;",
    "nested/compiler.tsbuildinfo": "{}",
    "nested/style.css": "body { color: red; }/*# sourceMappingURL=style.css.map */\n",
    "nested/style.css.map": "{}",
    "nested/protocol.json": '{"version":1}',
    "nested/answer.test.js": 'throw new Error("test output must not ship");',
    "nested/answer.spec.mjs": 'throw new Error("spec output must not ship");',
    "__tests__/fixture.cjs": 'throw new Error("test directories must not ship");',
    LICENSE: "Project license text",
    "image.png": Buffer.from([137, 80, 78, 71, 0, 255]),
    "example.mjs": "export const sample = `\n//# sourceMappingURL=keep-as-text.map\n`;\n",
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  copyRuntimeDist(source, destination);

  assert.deepEqual(
    filesUnder(destination)
      .map((file) => relative(destination, file).split(sep).join("/"))
      .sort(),
    [
      "LICENSE",
      "entry.mjs",
      "example.mjs",
      "image.png",
      "nested/answer.mjs",
      "nested/protocol.json",
      "nested/style.css",
    ],
  );
  assert.equal((await import(pathToFileURL(join(destination, "entry.mjs")).href)).answer, 42);
  assert.equal(
    readFileSync(join(destination, "nested/style.css"), "utf8"),
    "body { color: red; }\n",
  );
  for (const file of ["entry.mjs", "nested/answer.mjs", "nested/style.css"])
    assert.doesNotMatch(readFileSync(join(destination, file), "utf8"), /sourceMappingURL/);
  for (const file of ["LICENSE", "example.mjs", "image.png", "nested/protocol.json"])
    assert.deepEqual(readFileSync(join(destination, file)), readFileSync(join(source, file)));
  for (const [file, contents] of Object.entries(files))
    assert.deepEqual(readFileSync(join(source, file)), Buffer.from(contents));
});
