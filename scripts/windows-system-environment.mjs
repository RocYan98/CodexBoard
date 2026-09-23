import { win32 } from "node:path";

const systemFields = [
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SystemDrive",
  "ProgramFiles",
  "ProgramW6432",
  "ProgramData",
  "ALLUSERSPROFILE",
];

// Windows PowerShell needs its OS installation context even when the child has
// an isolated profile. Never inherit the caller's user module search paths.
export function windowsSystemEnvironment(source = process.env) {
  const environment = {};
  for (const name of systemFields) {
    const key = Object.keys(source).find((key) => key.toLowerCase() === name.toLowerCase());
    const value = key ? source[key] : undefined;
    if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) continue;
    if (name === "SystemDrive") {
      if (!/^[A-Za-z]:$/.test(value)) continue;
    } else if (name !== "PATHEXT" && (!win32.isAbsolute(value) || value.includes(";"))) {
      continue;
    }
    environment[name] = value;
  }
  const modules = [];
  if (environment.SystemRoot)
    modules.push(
      win32.join(environment.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    );
  const programFiles = environment.ProgramW6432 ?? environment.ProgramFiles;
  if (programFiles) modules.push(win32.join(programFiles, "WindowsPowerShell", "Modules"));
  environment.PSModulePath = modules.join(";");
  return environment;
}
