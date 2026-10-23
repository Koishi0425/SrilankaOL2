import type { SettlementResultAudience } from '@srilanka/contracts';

export function resultAudienceLabel(
  audience?: SettlementResultAudience,
  countries: Array<{ id: string; name: string }> = [],
) {
  if (audience?.kind === 'Public') return '全体成员（含旁观者）';
  if (audience?.kind === 'HostOnly') return '仅主持人';
  if (audience?.kind === 'Countries')
    return `指定国家：${audience.countryIds.map((id) => countries.find((c) => c.id === id)?.name ?? '所选国家').join('、') || '尚未选择'}`;
  return '所属国家与主持人';
}

export function ResultAudienceEditor({
  value,
  countries,
  ownerCountryId,
  disabled,
  onChange,
}: {
  value?: SettlementResultAudience;
  countries: Array<{ id: string; name: string }>;
  ownerCountryId: string;
  disabled: boolean;
  onChange: (audience: SettlementResultAudience) => void;
}) {
  const audience = value ?? { kind: 'OwnerOnly' };
  return (
    <fieldset className="result-audience-editor" disabled={disabled}>
      <legend>结算结果可见范围</legend>
      <p>
        由主持人根据政策内容与实际影响决定，随结算发布生效。这里共享的是下方结算反馈；政策原文、内部审核意见与讨论仍按原有权限查看。
      </p>
      <label>
        可见范围
        <select
          value={audience.kind}
          onChange={(e) =>
            onChange(
              e.target.value === 'Countries'
                ? { kind: 'Countries', countryIds: [ownerCountryId] }
                : {
                    kind: e.target.value as 'OwnerOnly' | 'Public' | 'HostOnly',
                  },
            )
          }
        >
          <option value="OwnerOnly">所属国家与主持人</option>
          <option value="Countries">指定国家与主持人</option>
          <option value="Public">全体成员（含旁观者）</option>
          <option value="HostOnly">仅主持人</option>
        </select>
      </label>
      {audience.kind === 'Countries' && (
        <div className="result-audience-countries">
          <p>
            仅勾选国家的玩家可见；需要让政策所属国家知晓时，也请勾选该国家。主持人始终可见。
          </p>
          {countries.map((country) => (
            <label key={country.id}>
              <input
                type="checkbox"
                checked={audience.countryIds.includes(country.id)}
                onChange={(e) =>
                  onChange({
                    kind: 'Countries',
                    countryIds: e.target.checked
                      ? [...audience.countryIds, country.id]
                      : audience.countryIds.filter((id) => id !== country.id),
                  })
                }
              />
              {country.name}
            </label>
          ))}
          {!audience.countryIds.length && (
            <p role="alert">请至少选择一个国家，或改为“仅主持人”。</p>
          )}
        </div>
      )}
    </fieldset>
  );
}
