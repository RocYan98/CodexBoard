import { describe, expect, it } from "vitest";

import {
  allocateProjectKey,
  formatTaskIdentifier,
} from "../src/modules/project-sync/project-key.js";

describe("projectKey", () => {
  it("combines the root basename prefix with a deterministic path checksum", () => {
    expect(allocateProjectKey("/Users/test/Projects/codexboard", new Set())).toBe("COPA");
    expect(allocateProjectKey("/Users/test/Docker", new Set())).toBe("DOVO");
    expect(allocateProjectKey("/Users/test/Projects/codex-example", new Set())).toBe("COXL");
    expect(allocateProjectKey("/Users/test/Projects/sample-app", new Set())).toBe("SAGA");
  });

  it("normalizes accents and fills missing Latin prefix letters from the checksum", () => {
    expect(allocateProjectKey("/Users/test/Résumé", new Set())).toBe("REHW");
    expect(allocateProjectKey("/Users/test/论文", new Set())).toBe("YVRE");
    expect(allocateProjectKey("/Users/test/A", new Set())).toBe("AMNQ");
    expect(allocateProjectKey("/Users/test/123", new Set())).toBe("GVYW");
  });

  it("extends collisions and the reserved TEMP key to a stable five-letter key", () => {
    const root = "/Users/test/Projects/codexboard";

    expect(allocateProjectKey(root, new Set(["COPA"]))).toBe("COOPA");
    expect(allocateProjectKey(root, new Set(["COPA", "COOPA"]))).toBe("COOPB");
    expect(allocateProjectKey(root, new Set(["COPA", "COOPA"]))).toBe("COOPB");
    expect(allocateProjectKey("/Users/test/test-1495", new Set())).toBe("TETMP");
  });

  it("checks every five-letter suffix before reporting exhaustion", () => {
    const occupied = new Set<string>(["COPA"]);
    for (let first = 0; first < 26; first += 1) {
      for (let second = 0; second < 26; second += 1) {
        for (let third = 0; third < 26; third += 1) {
          const suffix = String.fromCharCode(65 + first, 65 + second, 65 + third);
          if (suffix !== "AAA") occupied.add(`CO${suffix}`);
        }
      }
    }

    expect(allocateProjectKey("/Users/test/Projects/codexboard", occupied)).toBe("COAAA");
  });

  it("rejects a relative or empty root", () => {
    expect(() => allocateProjectKey("relative/project", new Set())).toThrow(
      "项目根目录必须是绝对路径",
    );
    expect(() => allocateProjectKey("", new Set())).toThrow("项目根目录必须是绝对路径");
  });

  it("uses the path's syntax rather than the host platform for Windows and UNC roots", () => {
    const key = allocateProjectKey("C:\\Projects\\CodexBoard", new Set());
    expect(key).toMatch(/^CO[A-Z]{2}$/);
    expect(allocateProjectKey("C:/Projects/other/../CodexBoard/", new Set())).toBe(key);
    expect(allocateProjectKey("c:/projects/CODEXBOARD", new Set())).toBe(key);
    expect(allocateProjectKey("\\\\server\\share\\CodexBoard", new Set())).toMatch(/^CO[A-Z]{2}$/);
    expect(() => allocateProjectKey("C:relative", new Set())).toThrow("绝对路径");
  });
});

describe("task identifier", () => {
  it("pads task numbers to at least three digits", () => {
    expect(formatTaskIdentifier("COPA", 1)).toBe("COPA-001");
    expect(formatTaskIdentifier("COPA", 12)).toBe("COPA-012");
    expect(formatTaskIdentifier("COPA", 999)).toBe("COPA-999");
    expect(formatTaskIdentifier("COPA", 1000)).toBe("COPA-1000");
    expect(formatTaskIdentifier("TEMP", 1)).toBe("TEMP-001");
  });

  it("rejects invalid keys and task numbers", () => {
    expect(() => formatTaskIdentifier("CDX-OLD", 1)).toThrow("项目 Key 格式无效");
    expect(() => formatTaskIdentifier("TEMP", 0)).toThrow("任务编号必须是正整数");
    expect(() => formatTaskIdentifier("TEMP", 1.5)).toThrow("任务编号必须是正整数");
  });
});
