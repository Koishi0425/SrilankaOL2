import { afterEach, expect, it, vi } from 'vitest';

import { createBackup, pruneScheduledBackups } from './backup.js';
import { BackupManager } from './backup-manager.js';

vi.mock('./backup.js', () => ({
  createBackup: vi.fn(),
  pruneScheduledBackups: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
const options = {
  databaseUrl: 'postgresql://user@localhost/game',
  directory: '/backups',
  sourceRoot: '/project',
  tools: {},
};

it('serializes checkpoints and allows retry after a failed backup', async () => {
  let release!: () => void;
  vi.mocked(createBackup)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ path: '/backups/first', manifest: {} as never });
        }),
    )
    .mockRejectedValueOnce(new Error('Disk full'))
    .mockResolvedValue({ path: '/backups/next', manifest: {} as never });
  const report = vi.fn();
  const manager = new BackupManager(options, 60, 48, report);
  const context = { gameId: 'game', quarterId: 'quarter', version: 1 };
  const first = manager.checkpoint(context);
  const second = manager.checkpoint(context);
  await Promise.resolve();
  expect(createBackup).toHaveBeenCalledTimes(1);
  const failed = expect(second).rejects.toThrow('Disk full');
  release();
  await first;
  await failed;
  await manager.checkpoint(context);
  expect(createBackup).toHaveBeenCalledTimes(3);
  expect(pruneScheduledBackups).not.toHaveBeenCalled();
  await manager.stop();
  await expect(manager.checkpoint(context)).rejects.toThrow('关闭');
});

it('backs up at startup and on schedule, pruning only after success', async () => {
  vi.useFakeTimers();
  vi.mocked(createBackup)
    .mockResolvedValueOnce({ path: '/backups/first', manifest: {} as never })
    .mockRejectedValueOnce(new Error('Disk unavailable'));
  const manager = new BackupManager(options, 60, 48, vi.fn());
  manager.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(pruneScheduledBackups).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(createBackup).toHaveBeenCalledTimes(2);
  expect(pruneScheduledBackups).toHaveBeenCalledTimes(1);
  await manager.stop();
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(createBackup).toHaveBeenCalledTimes(2);
});
