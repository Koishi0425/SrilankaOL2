import { beforeEach, expect, it, vi } from 'vitest';
import { DraftSession, priorPolicyDraftKey } from './local-drafts.js';
const valid = (v: unknown): v is { text: string } =>
  !!v && typeof v === 'object' && 'text' in v && typeof v.text === 'string';
const key = (user = 'u', game = 'g', quarter = 'q') =>
  `srilanka:draft:v1:${JSON.stringify([user, game, quarter, 'policy', 'new'])}`;
beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it('preserves an unacknowledged draft across reload and only replaces it after explicit restoration', () => {
  const first = new DraftSession(key(), valid);
  expect(first.write({ text: '未保存' })).toBe(true);
  const reload = new DraftSession(key(), valid);
  expect(reload.pending).toBe(true);
  expect(reload.saved?.value.text).toBe('未保存');
  expect(reload.write({ text: '空页面' })).toBe(false);
  reload.resume();
  expect(reload.write({ text: '继续写' })).toBe(true);
  expect(new DraftSession(key(), valid).saved?.value.text).toBe('继续写');
  reload.clear();
  expect(localStorage.getItem(key())).toBeNull();
});
it('refuses stale writes and clearing after another tab changes the same draft', () => {
  const first = new DraftSession(key(), valid),
    second = new DraftSession(key(), valid);
  first.write({ text: '一页的新内容' });
  expect(second.write({ text: '二页旧内容' })).toBe(false);
  expect(second.error).toContain('另一页面');
  second.clear();
  expect(new DraftSession(key(), valid).saved?.value.text).toBe('一页的新内容');
});
it('finds old uncreated policies only for this account and game', () => {
  new DraftSession(key('u', 'g', 'old'), valid).write({ text: '旧季本国稿' });
  new DraftSession(key('other', 'g', 'old'), valid).write({
    text: '他人私人稿',
  });
  new DraftSession(key('u', 'other-game', 'old'), valid).write({
    text: '其他游戏稿',
  });
  expect(priorPolicyDraftKey(key())).toBe(key('u', 'g', 'old'));
  expect(new DraftSession(key('different'), valid).saved).toBeNull();
  new DraftSession(key(), valid).write({ text: '本季' });
  expect(priorPolicyDraftKey(key())).toBe(key());
});
it('reports corrupt or unavailable storage without claiming it saved or overwriting data', () => {
  localStorage.setItem(key(), 'broken');
  const corrupt = new DraftSession(key(), valid);
  expect(corrupt.error).toBeTruthy();
  expect(corrupt.write({ text: '覆盖' })).toBe(false);
  expect(localStorage.getItem(key())).toBe('broken');
  localStorage.clear();
  const normal = new DraftSession(key(), valid);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  expect(normal.write({ text: '重要文字' })).toBe(false);
  expect(normal.saved).toBeNull();
  expect(normal.error).toContain('暂存失败');
});
