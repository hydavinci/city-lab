import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function atomicFile(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function atomicJSON(path: string, value: unknown): Promise<void> {
  await atomicFile(path, Buffer.from(JSON.stringify(value)));
}
export async function packageFile(root: string, path: string): Promise<Buffer> {
  if (!path.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) {
    throw new Error(`Unsafe mobility package path: ${path}`);
  }
  let at = root;
  for (const part of path.split('/')) {
    at = join(at, part);
    if ((await lstat(at)).isSymbolicLink()) throw new Error(`Package symlink is not supported: ${path}`);
  }
  if (!(await lstat(at)).isFile()) throw new Error(`Expected regular mobility package file: ${path}`);
  return readFile(at);
}
