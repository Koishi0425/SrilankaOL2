import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LoginPanel,
  PasswordPanel,
  AccountManagement,
} from './AccountPanels.js';
import * as api from '../api.js';
vi.mock('../api.js', () => ({
  fetchAuthOptions: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  changePassword: vi.fn(),
  redeemPasswordReset: vi.fn(),
  issuePasswordReset: vi.fn(),
  createRegistrationInvitation: vi.fn(),
  fetchAccountHistory: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});
beforeEach(() => {
  vi.mocked(api.fetchAuthOptions).mockResolvedValue({
    registrationMode: 'InviteOnly',
    minimumPasswordLength: 15,
  });
});
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const newPassword = 'a long new account password';
describe('account forms', () => {
  it('requests an invitation only during registration and clears secrets when switching modes', async () => {
    const success = vi.fn().mockResolvedValue(undefined);
    render(<LoginPanel onSuccess={success} />);
    fireEvent.click(await screen.findByRole('button', { name: '注册账号' }));
    fill('显示名称', '玩家');
    fill('用户名', 'new-user');
    fill('邀请码', 'invite-secret');
    fill('新密码（至少15个字符）', newPassword);
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    await waitFor(() =>
      expect(api.register).toHaveBeenCalledWith({
        username: 'new-user',
        displayName: '玩家',
        inviteCode: 'invite-secret',
        password: newPassword,
      }),
    );
    await waitFor(() => expect(success).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(screen.queryByLabelText('邀请码')).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
  });
  it('keeps login available when registration options cannot be loaded', async () => {
    vi.mocked(api.fetchAuthOptions).mockRejectedValue(new Error('network'));
    render(<LoginPanel onSuccess={vi.fn().mockResolvedValue(undefined)} />);
    fill('用户名', 'existing');
    fill('密码', 'old-password');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() =>
      expect(api.login).toHaveBeenCalledWith('existing', 'old-password'),
    );
    expect(
      screen.queryByRole('button', { name: '注册账号' }),
    ).not.toBeInTheDocument();
  });
  it('hides registration in closed mode', async () => {
    vi.mocked(api.fetchAuthOptions).mockResolvedValue({
      registrationMode: 'Closed',
      minimumPasswordLength: 15,
    });
    render(<LoginPanel onSuccess={vi.fn()} />);
    await waitFor(() => expect(api.fetchAuthOptions).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: '注册账号' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '使用重置码' }),
    ).toBeInTheDocument();
  });
  it('validates password confirmation and returns to normal login after reset', async () => {
    const success = vi.fn();
    render(<LoginPanel onSuccess={success} />);
    fireEvent.click(screen.getByRole('button', { name: '使用重置码' }));
    fill('用户名', 'player');
    fill('重置码', 'reset-secret');
    fill('新密码（至少15个字符）', newPassword);
    fill('再次填写新密码', 'different long password');
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不一致');
    expect(api.redeemPasswordReset).not.toHaveBeenCalled();
    fill('再次填写新密码', newPassword);
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
    await waitFor(() =>
      expect(api.redeemPasswordReset).toHaveBeenCalledWith(
        'player',
        'reset-secret',
        newPassword,
      ),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('密码已重置');
    expect(screen.getByLabelText('密码')).toHaveValue('');
    expect(success).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it('keeps change-password errors visible and clears the form when closed', async () => {
    vi.mocked(api.changePassword).mockRejectedValue(
      new Error('当前密码不正确。'),
    );
    const changed = vi.fn(),
      close = vi.fn();
    const view = render(
      <PasswordPanel username="player" onClose={close} onChanged={changed} />,
    );
    fill('当前密码', 'old-password');
    fill('新密码（至少15个字符）', newPassword);
    fill('再次填写新密码', newPassword);
    fireEvent.click(screen.getByRole('button', { name: '保存新密码' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '当前密码不正确',
    );
    expect(changed).not.toHaveBeenCalled();
    view.unmount();
    render(
      <PasswordPanel username="player" onClose={close} onChanged={changed} />,
    );
    expect(screen.getByLabelText('当前密码')).toHaveValue('');
    expect(localStorage.length).toBe(0);
  });
  it('shows a generated code only in memory and requests the host password for each operation', async () => {
    vi.mocked(api.createRegistrationInvitation).mockResolvedValue({
      code: 'one-time-invitation',
      expiresAt: '2030-01-01T00:00:00Z',
    });
    const close = vi.fn();
    render(
      <AccountManagement
        gameId="game"
        active
        readOnly={false}
        target={null}
        onClose={close}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: '生成注册邀请码' }),
    );
    fill('你的当前密码', 'host-password');
    fireEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
    expect(await screen.findByLabelText('生成的邀请码')).toHaveValue(
      'one-time-invitation',
    );
    expect(screen.queryByLabelText('你的当前密码')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(
      screen.queryByDisplayValue('one-time-invitation'),
    ).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '生成注册邀请码' }));
    expect(screen.getByLabelText('你的当前密码')).toHaveValue('');
  });
});
