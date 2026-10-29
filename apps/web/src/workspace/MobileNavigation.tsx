import type { CountrySection } from '../countries/CountryPanel.js';

export type WorkspacePage =
  | 'map'
  | 'actions'
  | 'messages'
  | 'rules'
  | 'settlement'
  | 'country'
  | 'members'
  | 'preparation';
const paths = {
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6m6-3v15m6-12v15',
  actions: 'M6 3h12v18H6V3m3 5h6m-6 4h6m-6 4h4',
  settlement: 'M5 5h14v16H5V5m3-3v6m8-6v6M5 10h14m-10 5 2 2 4-4',
  messages: 'M3 4h18v13H9l-6 4V4m4 5h10m-10 4h6',
  more: 'M4 4h6v6H4V4m10 0h6v6h-6V4M4 14h6v6H4v-6m10 0h6v6h-6v-6',
};
export function MobileNavigation({
  page,
  more,
  host,
  observer,
  preview,
  readOnly,
  unread,
  onNavigate,
  onMore,
}: {
  page: WorkspacePage;
  more: boolean;
  host: boolean;
  observer: boolean;
  preview: boolean;
  readOnly: boolean;
  unread: number;
  onNavigate: (page: WorkspacePage) => void;
  onMore: () => void;
}) {
  const items = [
    { key: 'map', label: '地图' },
    ...(!preview && !observer
      ? [{ key: 'actions', label: host && !readOnly ? '审核' : '政策' }]
      : []),
    ...(!preview
      ? [
          { key: 'settlement', label: host && !readOnly ? '结算' : '结果' },
          { key: 'messages', label: '消息' },
        ]
      : []),
    { key: 'more', label: '全部功能' },
  ] as { key: keyof typeof paths; label: string }[];
  return (
    <nav className="mobile-navigation" aria-label="手机游戏导航">
      {items.map((item) => (
        <button
          key={item.key}
          aria-current={
            (
              item.key === 'more'
                ? more ||
                  !['map', 'actions', 'settlement', 'messages'].includes(page)
                : !more && page === item.key
            )
              ? 'page'
              : undefined
          }
          onClick={() =>
            item.key === 'more' ? onMore() : onNavigate(item.key)
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={paths[item.key]} />
          </svg>
          <span>{item.label}</span>
          {item.key === 'messages' && unread > 0 && (
            <b className="mobile-unread" aria-label={`${unread} 条未读消息`}>
              {unread > 99 ? '99+' : unread}
            </b>
          )}
        </button>
      ))}
    </nav>
  );
}

export function MobileDirectory({
  host,
  observer,
  preparing,
  readOnly,
  preview,
  onNavigate,
  onCountry,
  onOverview,
  onExitPreview,
}: {
  host: boolean;
  observer: boolean;
  preparing: boolean;
  readOnly: boolean;
  preview: boolean;
  onNavigate: (page: WorkspacePage) => void;
  onCountry: (section: CountrySection) => void;
  onOverview: () => void;
  onExitPreview: () => void;
}) {
  return (
    <section className="mobile-directory" aria-label="全部功能">
      <h3>全部功能</h3>
      {preview ? (
        <>
          <p>正在预览玩家可见的地图。</p>
          <button onClick={onExitPreview}>退出玩家视角预览</button>
        </>
      ) : (
        <>
          <p className="muted">国家事务、回合工作与本局设置</p>
          <h4>国家事务</h4>
          <div className="mobile-feature-grid">
            {(
              [
                'overview',
                ...(!observer ? ['economy', 'military', 'government'] : []),
                'diplomacy',
              ] as CountrySection[]
            ).map((section) => (
              <button key={section} onClick={() => onCountry(section)}>
                <strong>
                  {
                    {
                      overview: '国家概况',
                      economy: '经济与贸易',
                      military: '军事',
                      government: '政府与长期政策',
                      diplomacy: '外交',
                    }[section]
                  }
                </strong>
                <span>查看与管理 →</span>
              </button>
            ))}
          </div>
          <h4>回合与规则</h4>
          <div className="mobile-feature-grid">
            {!readOnly && (
              <button onClick={onOverview}>
                <strong>回合事务</strong>
                <span>待办、政策与未读消息 →</span>
              </button>
            )}
            <button onClick={() => onNavigate('rules')}>
              <strong>剧本与规则</strong>
              <span>背景、规则与经济参数 →</span>
            </button>
            {preparing && (
              <button onClick={() => onNavigate('preparation')}>
                <strong>开局准备</strong>
                <span>初始化与开局检查 →</span>
              </button>
            )}
            {host && (
              <button onClick={() => onNavigate('members')}>
                <strong>本局管理</strong>
                <span>成员、国家分配与游戏管理 →</span>
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
