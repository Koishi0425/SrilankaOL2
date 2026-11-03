import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FunctionComponent } from 'react';
import { lazyFeature } from './lazy-feature.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('loads only when mounted, shows progress and uses current props after loading', async () => {
  let resolve!: (module: {
    default: FunctionComponent<{ label: string }>;
  }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ default: FunctionComponent<{ label: string }> }>(
        (done) => (resolve = done),
      ),
  );
  const Feature = lazyFeature(load, '正在打开测试功能…');
  expect(load).not.toHaveBeenCalled();
  const page = render(<Feature label="初始内容" />);
  expect(
    screen.getByRole('status', { name: '正在打开测试功能…' }),
  ).toBeInTheDocument();
  page.rerender(<Feature label="更新后的内容" />);
  await act(async () => resolve({ default: ({ label }) => <p>{label}</p> }));
  expect(await screen.findByText('更新后的内容')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
});

it('retries a failed feature without reloading the page or discarding a sibling draft', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const load = vi
    .fn(async () => ({ default: () => <p>重试后已加载</p> }))
    .mockRejectedValueOnce(new Error('chunk connection failed'));
  const Feature = lazyFeature(load, '正在打开测试功能…');
  render(
    <>
      <textarea aria-label="正在编写的草稿" defaultValue="保留这段文字" />
      <Feature />
    </>,
  );
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重新加载此功能' }));
  expect(await screen.findByText('重试后已加载')).toBeInTheDocument();
  expect(screen.getByLabelText('正在编写的草稿')).toHaveValue('保留这段文字');
  expect(load).toHaveBeenCalledTimes(2);
});

it('retains the feature state while a previously opened panel is hidden', async () => {
  const load = vi.fn(async () => ({
    default: () => <textarea aria-label="功能草稿" />,
  }));
  const Feature = lazyFeature(load, '正在打开测试功能…');
  const page = render(
    <div hidden={false}>
      <Feature />
    </div>,
  );
  fireEvent.change(await screen.findByLabelText('功能草稿'), {
    target: { value: '切换页面后继续写' },
  });
  page.rerender(
    <div hidden>
      <Feature />
    </div>,
  );
  page.rerender(
    <div hidden={false}>
      <Feature />
    </div>,
  );
  expect(screen.getByLabelText('功能草稿')).toHaveValue('切换页面后继续写');
  expect(load).toHaveBeenCalledTimes(1);
});

it('shares an intentional preload with opening the panel without mounting it early', async () => {
  const mount = vi.fn(() => <p>预加载后打开</p>);
  const load = vi.fn(async () => ({ default: mount }));
  const Feature = lazyFeature(load, '正在打开测试功能…');
  Feature.preload();
  Feature.preload();
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  expect(mount).not.toHaveBeenCalled();
  render(<Feature />);
  expect(await screen.findByText('预加载后打开')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
});

it('allows a normal open after preloading fails', async () => {
  const load = vi
    .fn(async () => ({ default: () => <p>网络恢复后打开</p> }))
    .mockRejectedValueOnce(new Error('offline'));
  const Feature = lazyFeature(load, '正在打开测试功能…');
  Feature.preload();
  await act(async () => {});
  render(<Feature />);
  expect(await screen.findByText('网络恢复后打开')).toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(2);
});

it('reopens an already loaded feature synchronously after unmounting it', async () => {
  const load = vi.fn(async () => ({ default: () => <p>已加载的功能</p> }));
  const Feature = lazyFeature(load, '正在打开测试功能…');
  const first = render(<Feature />);
  await screen.findByText('已加载的功能');
  first.unmount();
  render(<Feature />);
  expect(screen.getByText('已加载的功能')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(1);
});
