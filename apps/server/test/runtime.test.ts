import {
  assertPrivateDirectorySync,
  assertPrivateFileSync,
} from "../../../scripts/private-file-permissions.mjs";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeDescriptorSchema } from "@codexboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../src/app-error.js";
import { loadConfig } from "../src/config.js";
import { createRuntimeCapability, publishRuntimeDescriptor } from "../src/modules/runtime/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexboard-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("runtime descriptor", () => {
  it("publishes a private descriptor and removes only its own runtime file", () => {
    const dataDirectory = temporaryDirectory();
    const config = loadConfig({
      CODEXBOARD_ENV: "test",
      CODEXBOARD_DATA_DIR: dataDirectory,
      CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
    });
    const capability = createRuntimeCapability();
    const handle = publishRuntimeDescriptor(
      config,
      capability,
      () => new Date("2026-08-30T12:00:00.000Z"),
    );

    assertPrivateDirectorySync(join(dataDirectory, "run"));
    assertPrivateFileSync(handle.path);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDirectory, "run")).mode & 0o777).toBe(0o700);
      expect(statSync(handle.path).mode & 0o777).toBe(0o600);
    }
    expect(RuntimeDescriptorSchema.parse(handle.descriptor)).toMatchObject({
      generatedAt: "2026-08-30T12:00:00.000Z",
      capabilityToken: capability,
      publicBaseUrl: "http://localhost:5173",
      localAdminBaseUrl: "http://127.0.0.1:47824",
    });

    handle.remove();
    expect(() => statSync(handle.path)).toThrow();
  });

  it("refuses a symlinked runtime directory", () => {
    const dataDirectory = temporaryDirectory();
    const target = temporaryDirectory();
    mkdirSync(join(dataDirectory), { recursive: true });
    symlinkSync(
      target,
      join(dataDirectory, "run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = loadConfig({
      CODEXBOARD_ENV: "test",
      CODEXBOARD_DATA_DIR: dataDirectory,
      CODEXBOARD_WORKSPACE_ROOTS: dataDirectory,
    });

    expect(() => publishRuntimeDescriptor(config, createRuntimeCapability())).toThrowError(
      AppError,
    );
  });
});
