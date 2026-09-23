import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  assertPrivateFileSync,
  ensurePrivateDirectorySync,
} from "../../../scripts/private-file-permissions.mjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  credentialPaths,
  authFileLocations,
  compatibleCredentialStore,
  defaultCredentialStore,
  PendingCredentialSchema,
  readCredential,
  runtimeScope,
} from "./auth.js";
import type { RuntimeDescriptor } from "@codexboard/contracts";

const runtime: RuntimeDescriptor = {
  descriptorVersion: 1,
  pid: 42,
  generatedAt: "2026-09-09T00:00:00Z",
  publicBaseUrl: "https://board.example",
  localAdminBaseUrl: "http://127.0.0.1:47824",
  capabilityToken: "x".repeat(43),
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "taskctl-auth-test-"));
  roots.push(path);
  ensurePrivateDirectorySync(path);
  return path;
}

async function makePublic(path: string) {
  if (process.platform === "win32")
    execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
  else await chmod(path, 0o644);
}

async function expectPrivate(path: string) {
  assertPrivateFileSync(path);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
}

describe("private CLI credential files", () => {
  it("preserves explicit auth paths and prefers new variables even when empty", () => {
    expect(authFileLocations({ LARK_TASKBOARD_AUTH_FILE: "/old/auth" }, "/fake/home")).toEqual({
      current: "/old/auth",
    });
    expect(
      authFileLocations(
        { LARK_TASKBOARD_AUTH_FILE: "/old/auth", CODEXBOARD_AUTH_FILE: "/new/auth" },
        "/fake/home",
      ),
    ).toEqual({ current: "/new/auth" });
    expect(() =>
      authFileLocations({ LARK_TASKBOARD_AUTH_FILE: "/old/auth", CODEXBOARD_AUTH_FILE: "" }),
    ).toThrow("CODEXBOARD_AUTH_FILE 不能为空");
  });

  it("reads only matching legacy scopes and logout removes both generations", async () => {
    const root = await temporary();
    const locations = authFileLocations({ XDG_CONFIG_HOME: root }, root);
    const current = credentialPaths(runtime, locations.current);
    const legacy = credentialPaths(runtime, (locations.legacy as string[])[0]!);
    const different = credentialPaths(
      { ...runtime, publicBaseUrl: "https://other.example" },
      locations.current,
    );
    const store = compatibleCredentialStore(locations);
    const payload = JSON.stringify({
      scope: current.scope,
      requestId: "synthetic-request",
      claimSecret: "synthetic-claim",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    await defaultCredentialStore.write(legacy.pending, payload);
    expect(
      await readCredential(store, current.pending, PendingCredentialSchema, current.scope, 0),
    ).toMatchObject({ requestId: "synthetic-request" });
    expect(await store.read(different.pending)).toBeNull();
    expect(await defaultCredentialStore.read(current.pending)).toBeNull();
    await store.write(current.pending, "invalid-new-file");
    await expect(
      readCredential(store, current.pending, PendingCredentialSchema, current.scope, 0),
    ).rejects.toMatchObject({ code: "CLI_AUTH_FILE_INVALID" });
    await store.remove(current.pending);
    expect(await defaultCredentialStore.read(legacy.pending)).toBeNull();
    expect(await store.read(current.pending)).toBeNull();
  });

  it("does not fall back through unsafe new credentials or a mismatched legacy identity scope", async () => {
    const root = await temporary();
    const locations = authFileLocations({ XDG_CONFIG_HOME: root }, root);
    const paths = credentialPaths(runtime, locations.current);
    const old = credentialPaths(runtime, (locations.legacy as string[])[0]!);
    const store = compatibleCredentialStore(locations);
    await defaultCredentialStore.write(
      old.pending,
      JSON.stringify({
        scope: "different-runtime",
        requestId: "synthetic-request",
        claimSecret: "synthetic-claim",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    );
    await expect(
      readCredential(store, paths.pending, PendingCredentialSchema, paths.scope, 0),
    ).rejects.toMatchObject({ code: "CLI_AUTH_RUNTIME_MISMATCH" });
    await defaultCredentialStore.write(paths.pending, "new");
    await makePublic(paths.pending);
    await expect(store.read(paths.pending)).rejects.toMatchObject({
      code: "CLI_AUTH_FILE_PERMISSIONS",
    });
  });
  it("creates and replaces credentials with mode 0600, reads them and removes them", async () => {
    const root = await temporary();
    const path = join(root, "config", "auth.json");
    await defaultCredentialStore.write(path, "private-one");
    await expectPrivate(path);
    expect(await defaultCredentialStore.read(path)).toBe("private-one");
    await makePublic(path);
    await expect(defaultCredentialStore.read(path)).rejects.toMatchObject({
      code: "CLI_AUTH_FILE_PERMISSIONS",
    });
    await defaultCredentialStore.write(path, "private-two");
    await expectPrivate(path);
    expect(await defaultCredentialStore.read(path)).toBe("private-two");
    await defaultCredentialStore.remove(path);
    expect(await defaultCredentialStore.read(path)).toBeNull();
  });
  it("refuses to read symlinks and replaces a symlink without touching its target", async () => {
    const root = await temporary();
    const target = join(root, "target");
    const link = join(root, "credential");
    await writeFile(target, "unrelated", { mode: 0o600 });
    await symlink(target, link);
    await expect(defaultCredentialStore.read(link)).rejects.toMatchObject({
      code: "CLI_AUTH_FILE_READ",
    });
    await defaultCredentialStore.write(link, "new-credential");
    expect(await readFile(target, "utf8")).toBe("unrelated");
    expect(await defaultCredentialStore.read(link)).toBe("new-credential");
  });
  it("isolates both runtime URLs even with an explicit credential base path", async () => {
    const base = "/tmp/auth-config";
    const original = credentialPaths(runtime, base);
    expect(
      credentialPaths({ ...runtime, publicBaseUrl: "https://other.example" }, base).session,
    ).not.toBe(original.session);
    expect(
      credentialPaths({ ...runtime, localAdminBaseUrl: "http://127.0.0.1:47825" }, base).session,
    ).not.toBe(original.session);
    expect(
      credentialPaths({ ...runtime, capabilityToken: "y".repeat(43), pid: 99 }, base).session,
    ).toBe(original.session);
    expect(original.pending).not.toBe(original.session);
  });
  it("rejects a copied credential that belongs to another runtime", async () => {
    const root = await temporary();
    const path = join(root, "auth");
    await defaultCredentialStore.write(
      path,
      JSON.stringify({
        scope: "wrong-runtime",
        requestId: "r",
        claimSecret: "s",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    );
    await expect(
      readCredential(
        defaultCredentialStore,
        path,
        PendingCredentialSchema,
        runtimeScope(runtime),
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: "CLI_AUTH_RUNTIME_MISMATCH" });
  });
});
