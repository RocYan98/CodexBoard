export function isWindowsPipePath(path: string): boolean;
export function desktopIpcPath(codexHome: string, platform?: NodeJS.Platform): string;
export function bridgeSocketPath(dataDirectory: string, platform?: NodeJS.Platform): string;
export function localEndpoint(path: string): string;
export function localEndpointPath(endpoint: string): string;
