import type { DiscoveryState } from '@srilanka/contracts';

export const discoveryNames: Record<DiscoveryState, string> = {
  Unknown: '清除记录',
  Mapped: '地理信息',
  Observed: '侦察情报',
};
