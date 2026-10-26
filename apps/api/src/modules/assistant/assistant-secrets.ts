import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiFault } from '../../errors.js';

const aad = Buffer.from('srilanka-global-assistant-v1');

export class AssistantSecrets {
  constructor(private readonly keyFile: string) {}

  private async key(create: boolean): Promise<Buffer> {
    try {
      const key = await readFile(this.keyFile);
      if (key.length !== 32) throw new Error('Invalid key');
      return key;
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw this.unavailable();
    }
    await mkdir(dirname(this.keyFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.keyFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
    try {
      // Publish a complete key atomically, including across API processes.
      await link(temporary, this.keyFile).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
    } finally {
      await unlink(temporary);
    }
    return this.key(false);
  }

  private unavailable() {
    return new ApiFault(
      503,
      'ASSISTANT_SECRET_UNAVAILABLE',
      'AI 密钥无法读取，请系统管理员重新填写 API Key，或恢复备份卷中的加密密钥文件。',
    );
  }

  async encrypt(secret: string): Promise<string> {
    const key = await this.key(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
  }

  async decrypt(value: string): Promise<string> {
    try {
      if (!value.startsWith('v1.')) throw new Error('Invalid format');
      const bytes = Buffer.from(value.slice(3), 'base64');
      if (bytes.length < 29) throw new Error('Invalid ciphertext');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.key(false),
        bytes.subarray(0, 12),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw this.unavailable();
    }
  }
}
