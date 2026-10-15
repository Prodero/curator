import fs from 'node:fs/promises';
import { constants } from 'node:fs';

// Shared with host integration state. Windows uses its native ACL/inheritance model.
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Tighten only the explicitly addressed inode, never a linked file or another owner's data. */
export async function tightenPrivateMode(target: string): Promise<void> {
  if (process.platform === 'win32') return;
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  // A concurrent lock release can unlink an inode while lstat is resolving it.
  // Accept only a vanished, owned regular file; any replacement still fails closed.
  if (stat.isFile() && stat.nlink === 0 && process.getuid && stat.uid === process.getuid()) {
    const remaining = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!remaining) return;
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe private state permissions target');
  const mode = stat.isDirectory() ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
  if ((stat.mode & 0o7777) === mode) return;
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== stat.nlink || current.uid !== stat.uid) throw new Error('Private state changed while tightening permissions');
    await handle.chmod(mode);
  } finally { await handle.close(); }
}
