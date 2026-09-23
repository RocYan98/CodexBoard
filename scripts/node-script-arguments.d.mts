/** Existing local Windows scripts use their canonical on-disk filename case. */
export function nodeScriptArguments(
  script: string,
  args?: readonly string[],
  platform?: NodeJS.Platform,
): string[];
