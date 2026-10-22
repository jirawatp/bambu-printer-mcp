import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBoundedRegularFile } from '../src/safe-file.js';
import type { FileApi } from '../src/safe-file.js';

const CANARY = 'CANARY-PRIVATE-NAME';

async function withDirectory<T>(run: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `bambu-safe-${CANARY}-`));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const failure = (fn: () => unknown): Error => {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('expected a throw');
};

interface FakeOptions {
  size?: number;
  regular?: boolean;
  chunks?: Buffer[];
  endless?: boolean;
  fstatThrows?: boolean;
  readThrows?: boolean;
  closeThrows?: boolean;
  openThrows?: boolean;
}

function fake(options: FakeOptions = {}) {
  const calls = { open: 0, read: 0, close: 0, flags: 0, lastLength: 0 };
  const queue = [...(options.chunks ?? [])];
  const api: FileApi = {
    openSync: (_path, flags) => {
      calls.open += 1;
      calls.flags = flags;
      if (options.openThrows === true) throw new Error(`ENOENT /secret/${CANARY}`);
      return 7;
    },
    fstatSync: () => {
      if (options.fstatThrows === true) throw new Error(`EBADF ${CANARY}`);
      return { isFile: () => options.regular ?? true, size: options.size ?? 0 };
    },
    readSync: (_fd, buffer, offset, length) => {
      calls.read += 1;
      calls.lastLength = length;
      if (options.readThrows === true) throw new Error(`EIO ${CANARY}`);
      if (options.endless === true) { buffer[offset] = 0x41; return 1; }
      const next = queue.shift();
      if (next === undefined) return 0;
      next.copy(buffer, offset);
      return next.length;
    },
    closeSync: () => {
      calls.close += 1;
      if (options.closeThrows === true) throw new Error('EBADF');
    },
  };
  return { api, calls };
}

test('reads a small regular file, including an empty one and one exactly at the cap', async () => {
  await withDirectory(async (directory) => {
    const normal = join(directory, 'ok.pem');
    const empty = join(directory, 'empty.pem');
    const exact = join(directory, 'exact.pem');
    await writeFile(normal, 'héllo certificate\n');
    await writeFile(empty, '');
    await writeFile(exact, 'A'.repeat(64));
    assert.equal(readBoundedRegularFile(normal, 64), 'héllo certificate\n');
    assert.equal(readBoundedRegularFile(empty, 64), '');
    assert.equal(readBoundedRegularFile(exact, 64), 'A'.repeat(64));
  });
});

test('a file above the cap is refused by its reported size and the path is never echoed', async () => {
  await withDirectory(async (directory) => {
    const big = join(directory, 'big.pem');
    await writeFile(big, 'A'.repeat(65));
    const error = failure(() => readBoundedRegularFile(big, 64));
    assert.ok(error instanceof RangeError);
    assert.equal(error.message, 'file too large');
    assert.doesNotMatch(error.message, new RegExp(CANARY));
  });
});

test('missing files, directories and NUL paths are refused with fixed labels', async () => {
  await withDirectory((directory) => {
    const missing = failure(() => readBoundedRegularFile(join(directory, 'nope.pem'), 64));
    assert.equal(missing.message, 'file unavailable');
    assert.doesNotMatch(missing.message, new RegExp(CANARY));
    assert.equal(failure(() => readBoundedRegularFile(directory, 64)).message, 'not a regular file');
    assert.equal(failure(() => readBoundedRegularFile(`${directory}/a\0b`, 64)).message, 'file unavailable');
  });
});

test('a symlink as the final component is refused, so the checked file cannot be swapped for a link target', { skip: constants.O_NOFOLLOW === undefined }, async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, 'real.pem');
    const link = join(directory, 'link.pem');
    await writeFile(target, 'cert');
    symlinkSync(target, link);
    assert.equal(readBoundedRegularFile(target, 64), 'cert');
    assert.equal(failure(() => readBoundedRegularFile(link, 64)).message, 'file unavailable');
  });
});

test('a FIFO is refused immediately instead of blocking on a peer', { timeout: 15_000 }, async (t) => {
  await withDirectory((directory) => {
    const fifo = join(directory, 'pipe.pem');
    const made = spawnSync('mkfifo', [fifo], { timeout: 5_000 });
    if (made.status !== 0) { t.skip('mkfifo unavailable'); return; }
    const started = Date.now();
    assert.equal(failure(() => readBoundedRegularFile(fifo, 64)).message, 'not a regular file');
    assert.ok(Date.now() - started < 5_000, 'refusal must not wait for a writer');
  });
});

test('character devices are refused without reading from them', () => {
  for (const device of ['/dev/null', '/dev/zero']) {
    if (!existsSync(device)) continue;
    assert.equal(failure(() => readBoundedRegularFile(device, 64)).message, 'not a regular file', device);
  }
});

test('the descriptor is opened read-only, non-blocking and without following symlinks', () => {
  const { api, calls } = fake({ chunks: [Buffer.from('x')] });
  readBoundedRegularFile('/x', 64, api);
  assert.equal(calls.flags & constants.O_NONBLOCK, constants.O_NONBLOCK | 0);
  assert.equal(calls.flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW | 0);
  assert.equal(calls.flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC), 0);
});

test('a non-regular descriptor is never read and is always closed', () => {
  const { api, calls } = fake({ regular: false });
  assert.equal(failure(() => readBoundedRegularFile('/x', 64, api)).message, 'not a regular file');
  assert.equal(calls.read, 0);
  assert.equal(calls.close, 1);
});

test('a file that reports a small size but yields endless data is stopped at the byte cap', () => {
  const { api, calls } = fake({ size: 0, endless: true });
  const error = failure(() => readBoundedRegularFile('/proc-like', 64, api));
  assert.ok(error instanceof RangeError);
  assert.ok(calls.read <= 65, `reads were bounded (${calls.read})`);
  assert.equal(calls.close, 1);
});

test('a file that grows after the size check is caught by the read cap', () => {
  const { api } = fake({ size: 10, chunks: [Buffer.alloc(40, 0x41), Buffer.alloc(40, 0x42)] });
  assert.equal(failure(() => readBoundedRegularFile('/grows', 64, api)).message, 'file too large');
});

test('partial reads are assembled, a split UTF-8 character survives and a read never asks for more than the cap allows', () => {
  const bytes = Buffer.from('é-cert');
  const { api, calls } = fake({ size: bytes.length, chunks: [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)] });
  assert.equal(readBoundedRegularFile('/partial', 64, api), 'é-cert');
  assert.ok(calls.lastLength <= 65);
  assert.equal(calls.close, 1);
});

test('open, stat and read failures become bounded errors, close still runs and a failing close is ignored', () => {
  const opened = fake({ openThrows: true });
  assert.equal(failure(() => readBoundedRegularFile('/x', 64, opened.api)).message, 'file unavailable');
  assert.equal(opened.calls.close, 0, 'nothing was opened, nothing to close');

  const stat = fake({ fstatThrows: true });
  assert.throws(() => readBoundedRegularFile('/x', 64, stat.api));
  assert.equal(stat.calls.close, 1);

  const read = fake({ readThrows: true });
  assert.throws(() => readBoundedRegularFile('/x', 64, read.api));
  assert.equal(read.calls.close, 1);

  const close = fake({ chunks: [Buffer.from('ok')], closeThrows: true });
  assert.equal(readBoundedRegularFile('/x', 64, close.api), 'ok');
  assert.equal(close.calls.close, 1);
});
