import {
  ensurePrivateDirectorySync,
  ensurePrivateFileSync,
} from "../../../../../scripts/private-file-permissions.mjs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  RuntimeCapabilitySchema,
  RuntimeDescriptorSchema,
  type RuntimeDescriptor,
} from "@codexboard/contracts";

import { AppError } from "../../app-error.js";
import type { AppConfig } from "../../config.js";

export interface RuntimeDescriptorHandle {
  readonly path: string;
  readonly descriptor: RuntimeDescriptor;
  remove(): void;
}

export function createRuntimeCapability(): string {
  return RuntimeCapabilitySchema.parse(randomBytes(32).toString("base64url"));
}

export function capabilitiesMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function publishRuntimeDescriptor(
  config: AppConfig,
  capabilityToken: string,
  now: () => Date = () => new Date(),
): RuntimeDescriptorHandle {
  const runDirectory = join(config.CODEXBOARD_DATA_DIR, "run");
  const descriptorPath = join(runDirectory, "runtime.json");
  const temporaryPath = join(runDirectory, `.runtime-${process.pid}-${randomUUID()}.tmp`);

  try {
    if (existsSync(runDirectory) && lstatSync(runDirectory).isSymbolicLink()) {
      throw new AppError("CONFIG_INVALID", 500, "运行时目录不能是符号链接");
    }
    ensurePrivateDirectorySync(runDirectory);

    const descriptor = RuntimeDescriptorSchema.parse({
      descriptorVersion: 1,
      pid: process.pid,
      generatedAt: now().toISOString(),
      publicBaseUrl: config.CODEXBOARD_ORIGIN,
      localAdminBaseUrl: `http://${config.CODEXBOARD_ADMIN_HOST}:${config.CODEXBOARD_ADMIN_PORT}`,
      capabilityToken,
    });
    writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    ensurePrivateFileSync(temporaryPath);
    renameSync(temporaryPath, descriptorPath);

    return {
      path: descriptorPath,
      descriptor,
      remove() {
        removeIfCurrent(descriptorPath, descriptor);
      },
    };
  } catch (cause: unknown) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    if (cause instanceof AppError) {
      throw cause;
    }
    throw new AppError("CONFIG_INVALID", 500, "无法安全写入运行时描述", { cause });
  }
}

function removeIfCurrent(path: string, expected: RuntimeDescriptor): void {
  try {
    const current: unknown = JSON.parse(readFileSync(path, "utf8"));
    const parsed = RuntimeDescriptorSchema.safeParse(current);
    if (
      parsed.success &&
      parsed.data.pid === expected.pid &&
      capabilitiesMatch(expected.capabilityToken, parsed.data.capabilityToken)
    ) {
      unlinkSync(path);
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
