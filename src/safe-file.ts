import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** The filesystem calls used, injectable so special-file and race behavior is testable without blocking. */
export interface FileApi {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
}

const realFileApi: FileApi = { openSync, fstatSync, readSync, closeSync };

/**
 * `O_NONBLOCK` makes opening a FIFO (or a stalled device) return at once instead of waiting for a
 * peer; `O_NOFOLLOW` refuses a symlink as the final path component, so what is opened cannot be
 * swapped for a link target after a check. A flag the platform lacks is `undefined`, which a
 * bitwise OR treats as 0.
 */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

/**
 * Read a small regular file as UTF-8, bounded and descriptor-based. The path is opened once; all
 * checks and reads then use that descriptor, so a path swapped afterwards (symlink, FIFO, device)
 * cannot change what is read. A non-regular file (FIFO, device, directory, socket) is refused
 * before any read, which is what makes the read unable to block on one. The size cap is enforced
 * on the bytes actually read as well as on the reported size, because some files report size 0
 * and still produce data. Errors are fixed labels; the path is never included.
 */
export function readBoundedRegularFile(path: string, maxBytes: number, api: FileApi = realFileApi): string {
  let fd: number;
  try {
    fd = api.openSync(path, OPEN_FLAGS);
  } catch {
    throw new Error('file unavailable');
  }
  try {
    const stats = api.fstatSync(fd);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > maxBytes) throw new RangeError('file too large');
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const read = api.readSync(fd, buffer, total, buffer.length - total, null);
      if (read <= 0) break;
      total += read;
    }
    if (total > maxBytes) throw new RangeError('file too large');
    return buffer.toString('utf8', 0, total);
  } finally {
    try {
      api.closeSync(fd);
    } catch { /* nothing further can be done */ }
  }
}
