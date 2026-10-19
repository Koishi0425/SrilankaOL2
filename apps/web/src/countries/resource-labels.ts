export const resourceNames = { Treasury: '国库', Manpower: '人力' };
export const signedAmount = (amount: number) =>
  `${amount > 0 ? '+' : ''}${amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
