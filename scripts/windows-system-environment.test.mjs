import assert from "node:assert/strict";
import test from "node:test";
import { windowsSystemEnvironment } from "./windows-system-environment.mjs";

test("isolated Windows children keep OS context without inheriting user module paths or secrets", () => {
  const source = Object.freeze({
    SYSTEMROOT: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    systemdrive: "C:",
    PROGRAMFILES: "C:\\Program Files (x86)",
    programw6432: "C:\\Program Files",
    programdata: "C:\\ProgramData",
    allusersprofile: "C:\\ProgramData",
    PSModulePath: "C:\\Users\\host\\Documents\\WindowsPowerShell\\Modules",
    WinPSModulePath: "C:\\Users\\host\\other-modules",
    HOME: "C:\\Users\\host",
    USERPROFILE: "C:\\Users\\host",
    APPDATA: "C:\\Users\\host\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\host\\AppData\\Local",
    CODEX_HOME: "C:\\Users\\host\\.codex",
    PATH: "C:\\Users\\host\\bin",
    HTTP_PROXY: "http://secret.invalid",
    OPENAI_API_KEY: "private fixture value",
    NODE_OPTIONS: "--require=C:\\Users\\host\\hook.js",
    NODE_PATH: "C:\\Users\\host\\node_modules",
  });
  assert.deepEqual(windowsSystemEnvironment(source), {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    COMSPEC: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemDrive: "C:",
    ProgramFiles: "C:\\Program Files (x86)",
    ProgramW6432: "C:\\Program Files",
    ProgramData: "C:\\ProgramData",
    ALLUSERSPROFILE: "C:\\ProgramData",
    PSModulePath:
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules",
  });
});

test("system module paths fall back to ProgramFiles and reject injected path-list entries", () => {
  assert.deepEqual(
    windowsSystemEnvironment({
      SystemRoot: "C:\\Windows;C:\\Users\\host\\modules",
      SystemDrive: "relative",
      ProgramFiles: "D:\\Programs",
      ProgramW6432: "relative",
      ProgramData: "C:\\ProgramData\nsecret",
      PSModulePath: "C:\\Users\\host\\modules",
    }),
    {
      ProgramFiles: "D:\\Programs",
      PSModulePath: "D:\\Programs\\WindowsPowerShell\\Modules",
    },
  );
  assert.deepEqual(windowsSystemEnvironment({ PSModulePath: "host-modules" }), {
    PSModulePath: "",
  });
});
