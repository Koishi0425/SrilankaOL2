import {
  createBackup,
  pruneScheduledBackups,
  type BackupManifest,
  type BackupOptions,
} from './backup.js';

export class BackupManager {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly options: Omit<BackupOptions, 'reason' | 'context'>,
    private readonly intervalMinutes: number,
    private readonly keep: number,
    private readonly report: (
      event: 'complete' | 'failed',
      detail: string,
    ) => void,
  ) {
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      !Number.isInteger(keep) ||
      keep < 1
    )
      throw new Error('备份间隔和保留数量必须为正整数。');
  }

  checkpoint(context: NonNullable<BackupManifest['context']>): Promise<void> {
    return this.enqueue('before-publish', context);
  }

  private enqueue(
    reason: BackupOptions['reason'],
    context?: BackupManifest['context'],
  ): Promise<void> {
    const task = this.pending.then(async () => {
      if (this.stopped) throw new Error('备份服务正在关闭。');
      try {
        const result = await createBackup({ ...this.options, reason, context });
        if (reason === 'scheduled')
          await pruneScheduledBackups(
            this.options.directory,
            this.options.databaseUrl,
            this.keep,
          );
        this.report('complete', result.path);
      } catch (error) {
        this.report(
          'failed',
          error instanceof Error ? error.message : '未知错误',
        );
        throw error;
      }
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  start(): void {
    const schedule = async () => {
      await this.enqueue('scheduled').catch(() => undefined);
      if (!this.stopped) {
        this.timer = setTimeout(
          () => void schedule(),
          this.intervalMinutes * 60_000,
        );
        this.timer.unref();
      }
    };
    void schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
