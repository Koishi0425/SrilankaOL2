import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AssistantSecrets } from './assistant-secrets.js';
import {
  globalAssistantInputSchema,
  normalizeAssistantUrl,
} from './assistant-settings.js';

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    if (!folder.startsWith(join(tmpdir(), 'srilanka-assistant-secret-')))
      throw new Error('Unexpected test path');
    await rm(folder, { recursive: true, force: true });
  }
});
async function keyFile() {
  const folder = await mkdtemp(join(tmpdir(), 'srilanka-assistant-secret-'));
  folders.push(folder);
  return join(folder, '.private/key');
}

it('encrypts credentials with a persisted authenticated key and supports concurrent first saves', async () => {
  const path = await keyFile();
  const stores = [new AssistantSecrets(path), new AssistantSecrets(path)];
  const encrypted = await Promise.all(
    stores.map((store) => store.encrypt('private-api-credential')),
  );
  expect(encrypted[0]).not.toBe(encrypted[1]);
  expect(encrypted.join('')).not.toContain('private-api-credential');
  expect((await readFile(path)).length).toBe(32);
  const restarted = new AssistantSecrets(path);
  for (const value of encrypted)
    expect(await restarted.decrypt(value)).toBe('private-api-credential');
  const bytes = Buffer.from(encrypted[0]!.slice(3), 'base64');
  bytes[bytes.length - 1]! ^= 1;
  await expect(
    restarted.decrypt(`v1.${bytes.toString('base64')}`),
  ).rejects.toMatchObject({ code: 'ASSISTANT_SECRET_UNAVAILABLE' });
});

it('does not silently replace a missing key while reading existing credentials', async () => {
  const path = await keyFile();
  const ciphertext = await new AssistantSecrets(path).encrypt(
    'private-api-credential',
  );
  const missing = await keyFile();
  await expect(
    new AssistantSecrets(missing).decrypt(ciphertext),
  ).rejects.toMatchObject({ code: 'ASSISTANT_SECRET_UNAVAILABLE' });
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('normalizes full completion URLs and refuses credentials or unsupported schemes in addresses', () => {
  expect(
    normalizeAssistantUrl('https://example.test/v1/chat/completions/'),
  ).toBe('https://example.test/v1');
  expect(normalizeAssistantUrl('http://192.168.1.2:8000/v1/')).toBe(
    'http://192.168.1.2:8000/v1',
  );
  for (const address of [
    'file:///secret',
    'https://user:password@example.test',
    'https://example.test?key=secret',
    'https://example.test/#fragment',
  ])
    expect(() => normalizeAssistantUrl(address)).toThrow();
  const input = {
    expectedRevision: 0,
    enabled: true,
    provider: 'compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: 'secret',
    jsonMode: true,
    disableThinking: false,
    timeoutMs: 60000,
  };
  expect(globalAssistantInputSchema.safeParse(input).success).toBe(true);
  expect(
    globalAssistantInputSchema.safeParse({ ...input, apiKey: 'line\nbreak' })
      .success,
  ).toBe(false);
  expect(
    globalAssistantInputSchema.safeParse({ ...input, systemPrompt: 'override' })
      .success,
  ).toBe(false);
});
