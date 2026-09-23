import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { copyThirdPartyLicenses } from "./third-party-licenses.mjs";

const supplementPath = fileURLToPath(
  new URL("../licenses/abstract-logging-2.0.1/LICENSE", import.meta.url),
);

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
}

function fixture(t) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "taskboard-licenses-")));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const root = {
    name: "fixture-root",
    version: "1.0.0",
    private: true,
    workspaces: ["apps/server", "apps/web"],
    dependencies: { "root-dep": "1.0.0" },
    devDependencies: { "dev-only": "1.0.0" },
  };
  const lock = {
    name: root.name,
    version: root.version,
    lockfileVersion: 3,
    packages: { "": root },
  };
  function packageAt(path, manifest, files = { LICENSE: "Fixture license text\n" }, dev = false) {
    write(join(project, path, "package.json"), manifest);
    lock.packages[path] = {
      version: manifest.version,
      ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
      ...(dev ? { dev: true } : {}),
      resolved: `https://registry.npmjs.org/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
    };
    for (const [name, contents] of Object.entries(files))
      write(join(project, path, name), contents);
  }
  for (const [name, dependencies] of [
    ["server", { "server-dep": "1.0.0" }],
    ["web", { "web-dep": "1.0.0", "nested-dep": "2.0.0" }],
  ]) {
    const path = `apps/${name}`;
    const manifest = { name: `@fixture/${name}`, version: "1.0.0", dependencies };
    write(join(project, path, "package.json"), manifest);
    lock.packages[path] = manifest;
    const link = `node_modules/@fixture/${name}`;
    lock.packages[link] = { resolved: path, link: true };
    mkdirSync(dirname(join(project, link)), { recursive: true });
    symlinkSync(join(project, path), join(project, link), "junction");
  }
  packageAt(
    "node_modules/root-dep",
    { name: "root-dep", version: "1.0.0", license: "MIT" },
    {
      LICENSE: "Root license\n",
      NOTICE: "Root attribution\n",
      "docs/LICENSE-additional": "Additional license\n",
      "licenses/embedded.txt": "Embedded component license\n",
    },
  );
  packageAt("node_modules/server-dep", {
    name: "server-dep",
    version: "1.0.0",
    license: "MIT",
    dependencies: { "nested-dep": "1.0.0" },
  });
  packageAt("node_modules/web-dep", { name: "web-dep", version: "1.0.0", license: "MIT" });
  for (const [path, version] of [
    ["node_modules/nested-dep", "2.0.0"],
    ["node_modules/server-dep/node_modules/nested-dep", "1.0.0"],
  ])
    packageAt(
      path,
      { name: "nested-dep", version, license: "MIT" },
      { LICENSE: `Nested ${version}\n` },
    );
  packageAt("node_modules/dev-only", { name: "dev-only", version: "1.0.0" }, {}, true);
  const save = () => {
    write(join(project, "package.json"), root);
    write(join(project, "package-lock.json"), lock);
  };
  save();
  return { project, runtime: join(project, "runtime"), root, lock, packageAt, save };
}

test("collects backend, bundled frontend, root and nested production licenses without development packages", (t) => {
  const { project, runtime } = fixture(t);
  write(join(runtime, "licenses/node-LICENSE"), "Keep the binary license\n");
  write(join(runtime, "licenses/npm/stale.txt"), "Old generated output\n");

  assert.deepEqual(copyThirdPartyLicenses(project, runtime), { packageCount: 5, fileCount: 8 });
  const directory = join(runtime, "licenses/npm");
  const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
  assert.deepEqual(
    index.packages.map((entry) => `${entry.name}@${entry.version}`),
    ["nested-dep@1.0.0", "nested-dep@2.0.0", "root-dep@1.0.0", "server-dep@1.0.0", "web-dep@1.0.0"],
  );
  for (const entry of index.packages) {
    assert.match(entry.source, /^https:\/\/registry\.npmjs\.org\//);
    for (const file of entry.files) {
      const output = readFileSync(join(directory, file.path));
      const source = readFileSync(
        join(project, entry.installedPaths[0], file.path.split("/").slice(2).join("/")),
      );
      assert.deepEqual(output, source);
      assert.equal(file.sha256, createHash("sha256").update(output).digest("hex"));
    }
  }
  assert.equal(index.packages.find((entry) => entry.name === "root-dep").files.length, 4);
  assert.equal(index.packages.find((entry) => entry.name === "server-dep").files.length, 1);
  assert.equal(existsSync(join(directory, "dev-only")), false);
  assert.equal(existsSync(join(directory, "stale.txt")), false);
  assert.equal(existsSync(join(runtime, "node_modules")), false);
  assert.equal(
    readFileSync(join(runtime, "licenses/node-LICENSE"), "utf8"),
    "Keep the binary license\n",
  );
});

test("preserves an upstream README containing the complete MIT license", (t) => {
  const { project, runtime } = fixture(t);
  const packageDirectory = join(project, "node_modules/web-dep");
  rmSync(join(packageDirectory, "LICENSE"));
  const readme = `# Web dependency\n\n## License\n\n${readFileSync(supplementPath, "utf8").replace(/[“”]/g, "'")}`;
  write(join(packageDirectory, "README.md"), readme);
  copyThirdPartyLicenses(project, runtime);
  assert.equal(readFileSync(join(runtime, "licenses/npm/web-dep/1.0.0/README.md"), "utf8"), readme);
});

test("fails for an external license link without its text before replacing existing output", (t) => {
  const { project, runtime } = fixture(t);
  rmSync(join(project, "node_modules/web-dep/LICENSE"));
  write(join(project, "node_modules/web-dep/NOTICE"), "An attribution without permission text\n");
  write(
    join(project, "node_modules/web-dep/README.md"),
    "## License\n\n[MIT](https://example.invalid/license)\n",
  );
  write(join(runtime, "licenses/npm/previous.txt"), "Previous inventory\n");
  assert.throws(
    () => copyThirdPartyLicenses(project, runtime),
    /缺少第三方许可正文：web-dep@1\.0\.0/,
  );
  assert.equal(
    readFileSync(join(runtime, "licenses/npm/previous.txt"), "utf8"),
    "Previous inventory\n",
  );
});

test("uses the verified abstract-logging supplement only for its exact package version and license", (t) => {
  const { project, runtime, root, packageAt, save } = fixture(t);
  root.dependencies["abstract-logging"] = "2.0.1";
  packageAt(
    "node_modules/abstract-logging",
    { name: "abstract-logging", version: "2.0.1", license: "MIT" },
    {
      "Readme.md": "## License\n\n[MIT License](http://jsumners.mit-license.org/)\n",
    },
  );
  save();
  copyThirdPartyLicenses(project, runtime);
  assert.deepEqual(
    readFileSync(join(runtime, "licenses/npm/abstract-logging/2.0.1/LICENSE")),
    readFileSync(supplementPath),
  );
  const index = JSON.parse(readFileSync(join(runtime, "licenses/npm/index.json"), "utf8"));
  assert.equal(
    index.packages.find((entry) => entry.name === "abstract-logging").supplement.source,
    "https://jsumners.mit-license.org/license.txt",
  );
  write(join(project, "node_modules/abstract-logging/package.json"), {
    name: "abstract-logging",
    version: "2.0.1",
    license: "ISC",
  });
  assert.throws(
    () => copyThirdPartyLicenses(project, runtime),
    /缺少第三方许可正文：abstract-logging@2\.0\.1/,
  );
  root.dependencies["abstract-logging"] = "2.0.2";
  packageAt(
    "node_modules/abstract-logging",
    { name: "abstract-logging", version: "2.0.2", license: "MIT" },
    {},
  );
  save();
  assert.throws(
    () => copyThirdPartyLicenses(project, runtime),
    /缺少第三方许可正文：abstract-logging@2\.0\.2/,
  );
});

test("rejects installed versions that differ from the lockfile", (t) => {
  const { project, runtime, lock, save } = fixture(t);
  lock.packages["node_modules/root-dep"].version = "1.0.1";
  save();
  assert.throws(() => copyThirdPartyLicenses(project, runtime), /第三方依赖版本与 lockfile 不一致/);
});

test("rejects production packages absent from the lockfile", (t) => {
  const { project, runtime, lock, save } = fixture(t);
  delete lock.packages["node_modules/root-dep"];
  save();
  assert.throws(() => copyThirdPartyLicenses(project, runtime), /第三方依赖路径不在 lockfile 中/);
});

test("stops when npm reports a missing required production dependency", (t) => {
  const { project, runtime } = fixture(t);
  rmSync(join(project, "node_modules/web-dep"), { recursive: true });
  assert.throws(() => copyThirdPartyLicenses(project, runtime), /无法读取第三方生产依赖/);
  assert.equal(existsSync(join(runtime, "licenses/npm")), false);
});
