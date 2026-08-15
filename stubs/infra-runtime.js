import os from 'node:os';
export function resolvePreferredOpenClawTmpDir() { return os.tmpdir(); }
export async function withFileLock(_filePath, fn) { return fn(); }
