import { useEffect, useState, useRef, type FormEvent } from 'react';
import type {
  AuthOptions,
  AccountAccessCode,
  AccountSecurityEvent,
  GameMemberSummary,
} from '@srilanka/contracts';
import { MINIMUM_PASSWORD_LENGTH } from '@srilanka/contracts';
import {
  fetchAuthOptions,
  login,
  register,
  changePassword,
  redeemPasswordReset,
  issuePasswordReset,
  createRegistrationInvitation,
  fetchAccountHistory,
} from '../api.js';

export function LoginPanel({
  message,
  onSuccess,
}: {
  message?: string;
  onSuccess: () => Promise<void>;
}) {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [username, setUsername] = useState(''),
    [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [code, setCode] = useState('');
  const [mode, setMode] = useState<'login' | 'register' | 'reset'>('login');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(message ?? ''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchAuthOptions()
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  function switchMode(next: typeof mode) {
    setMode(next);
    setPassword('');
    setConfirmation('');
    setCode('');
    setError('');
    setNotice('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (mode === 'reset' && password !== confirmation) {
      setError('两次填写的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'reset') {
        await redeemPasswordReset(username, code, password);
        switchMode('login');
        setNotice('密码已重置，请使用新密码登录。');
        return;
      }
      if (mode === 'register')
        await register({
          username,
          displayName,
          password,
          ...(options?.registrationMode === 'InviteOnly'
            ? { inviteCode: code }
            : {}),
        });
      else await login(username, password);
      await onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="auth-card">
      <h2>
        {mode === 'login' ? '登录' : mode === 'register' ? '注册' : '重置密码'}
      </h2>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="account-fields">
          {mode === 'register' && (
            <label>
              显示名称
              <input
                required
                maxLength={120}
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
          )}
          <label>
            用户名
            <input
              required
              maxLength={64}
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          {(mode === 'reset' ||
            (mode === 'register' &&
              options?.registrationMode === 'InviteOnly')) && (
            <label>
              {mode === 'reset' ? '重置码' : '邀请码'}
              <input
                required
                maxLength={128}
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
          )}
          <label>
            {mode === 'login'
              ? '密码'
              : `新密码（至少${MINIMUM_PASSWORD_LENGTH}个字符）`}
            <input
              required
              minLength={MINIMUM_PASSWORD_LENGTH}
              maxLength={256}
              type="password"
              autoComplete={
                mode === 'login' ? 'current-password' : 'new-password'
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === 'reset' && (
            <label>
              再次填写新密码
              <input
                required
                minLength={MINIMUM_PASSWORD_LENGTH}
                maxLength={256}
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          )}
          {mode === 'reset' && (
            <p className="muted">忘记密码时，请先向主持人申请重置码。</p>
          )}
          {mode === 'register' && (
            <p className="muted">注册后将用户名交给主持人加入游戏。</p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <button className="button button--primary" type="submit">
            {busy
              ? '正在处理…'
              : mode === 'login'
                ? '登录'
                : mode === 'register'
                  ? '注册'
                  : '重置密码'}
          </button>
          <div className="account-actions">
            {mode === 'login' ? (
              <>
                {options && options.registrationMode !== 'Closed' && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => switchMode('register')}
                  >
                    注册账号
                  </button>
                )}
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => switchMode('reset')}
                >
                  使用重置码
                </button>
              </>
            ) : (
              <button
                className="button button--quiet"
                type="button"
                onClick={() => switchMode('login')}
              >
                返回登录
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}

export function PasswordPanel({
  username,
  onClose,
  onChanged,
}: {
  username: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element?.showModal) element.showModal();
    else element?.setAttribute('open', '');
    return () => element?.close?.();
  }, []);
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (password !== confirmation) {
      setError('两次填写的新密码不一致。');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, password);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '修改失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="account-panel"
      aria-label="账号设置"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="account-heading">
        <h2>修改密码 · {username}</h2>
        <button
          type="button"
          className="button button--quiet"
          disabled={busy}
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy} className="account-fields">
          <label>
            当前密码
            <input
              required
              type="password"
              autoComplete="current-password"
              minLength={MINIMUM_PASSWORD_LENGTH}
              maxLength={256}
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </label>
          <label>
            新密码（至少{MINIMUM_PASSWORD_LENGTH}个字符）
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={MINIMUM_PASSWORD_LENGTH}
              maxLength={256}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label>
            再次填写新密码
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={MINIMUM_PASSWORD_LENGTH}
              maxLength={256}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <p className="muted">修改后需在所有设备重新登录。</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary">
            {busy ? '正在修改…' : '保存新密码'}
          </button>
        </fieldset>
      </form>
    </dialog>
  );
}

function AssistanceForm({
  gameId,
  target,
  onClose,
  onIssued,
}: {
  gameId: string;
  target: GameMemberSummary | 'invite';
  onClose: () => void;
  onIssued: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const [password, setPassword] = useState(''),
    [reason, setReason] = useState('');
  const [result, setResult] = useState<AccountAccessCode | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const invite = target === 'invite';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(
        invite
          ? await createRegistrationInvitation(gameId, password)
          : await issuePasswordReset(gameId, target.id, password, reason),
      );
      setPassword('');
      setReason('');
      onIssued();
    } catch (error) {
      setPassword('');
      setError(error instanceof Error ? error.message : '生成失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section ref={panel} className="account-assistance">
      <div className="account-heading">
        <h3>
          {invite ? '生成注册邀请码' : `协助 ${target.displayName} 重置登录`}
        </h3>
        <button
          className="button button--quiet"
          type="button"
          disabled={busy}
          onClick={onClose}
        >
          关闭
        </button>
      </div>
      {result ? (
        <>
          <p>
            {invite ? '邀请码' : '重置码'}仅显示这一次，供本人使用，有效至{' '}
            {new Date(result.expiresAt).toLocaleString('zh-CN')}。
          </p>
          {result.username && <p>用户名：{result.username}</p>}
          <div className="account-code">
            <input
              aria-label={invite ? '生成的邀请码' : '生成的重置码'}
              readOnly
              value={result.code}
              onFocus={(event) => event.target.select()}
            />
            <button
              className="button"
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.code);
                  setCopied(true);
                  setError('');
                } catch {
                  setError('未能复制，请选中代码手动复制。');
                }
              }}
            >
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <p className="muted">
            {invite
              ? '单次使用。注册后仍需按用户名添加成员。'
              : '请交给请求重置的本人，在登录页选择“使用重置码”。'}
          </p>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy} className="account-fields">
            <p className="muted">
              {invite
                ? '单次使用，7天内有效。'
                : '确认本人请求后生成，30分钟内有效；重新生成会使旧码失效。'}
            </p>
            {!invite && (
              <label>
                协助原因
                <input
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            )}
            <label>
              你的当前密码
              <input
                required
                type="password"
                autoComplete="current-password"
                minLength={MINIMUM_PASSWORD_LENGTH}
                maxLength={256}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="button" type="submit">
              {busy ? '正在生成…' : invite ? '生成邀请码' : '生成重置码'}
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
const eventNames: Record<AccountSecurityEvent['kind'], string> = {
  PasswordChanged: '修改密码',
  ResetIssued: '生成重置码',
  PasswordReset: '完成重置',
  InviteIssued: '生成邀请码',
  InviteUsed: '使用邀请码注册',
  OperatorResetIssued: '维护者生成重置码',
};
export function AccountManagement({
  gameId,
  active,
  readOnly,
  target,
  onClose,
}: {
  gameId: string;
  active: boolean;
  readOnly: boolean;
  target: GameMemberSummary | null;
  onClose: () => void;
}) {
  const [options, setOptions] = useState<AuthOptions | null>(null),
    [invite, setInvite] = useState(false),
    [history, setHistory] = useState<AccountSecurityEvent[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let current = true;
    void fetchAuthOptions()
      .then((value) => {
        if (current) setOptions(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [active]);
  useEffect(() => {
    if (!active || readOnly) {
      setInvite(false);
      onClose();
    }
  }, [active, readOnly, onClose]);
  async function loadHistory() {
    try {
      setHistory(await fetchAccountHistory(gameId));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '加载失败。');
    }
  }
  const selection = target ?? (invite ? 'invite' : null);
  return (
    <div className="account-management">
      <div className="account-actions">
        {!readOnly && options?.registrationMode === 'InviteOnly' && (
          <button
            className="button"
            type="button"
            onClick={() => {
              onClose();
              setInvite(true);
            }}
          >
            生成注册邀请码
          </button>
        )}
        <button
          className="button button--quiet"
          type="button"
          onClick={() => (history ? setHistory(null) : void loadHistory())}
        >
          账号协助记录
        </button>
      </div>
      {selection && active && !readOnly && (
        <AssistanceForm
          key={selection === 'invite' ? 'invite' : selection.id}
          gameId={gameId}
          target={selection}
          onClose={() => {
            onClose();
            setInvite(false);
          }}
          onIssued={() => {
            if (history) void loadHistory();
          }}
        />
      )}
      {history && (
        <div className="account-history">
          {history.length === 0 ? (
            <p className="muted">暂无账号协助记录。</p>
          ) : (
            <ul>
              {history.map((event) => (
                <li key={event.id}>
                  <time>
                    {new Date(event.createdAt).toLocaleString('zh-CN')}
                  </time>{' '}
                  {event.actorName ?? '维护者'} · {eventNames[event.kind]}
                  {event.targetName && ` · ${event.targetName}`}
                  {event.reason && `：${event.reason}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
