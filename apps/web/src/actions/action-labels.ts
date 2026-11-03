import type { ActionCategory, ActionSummary } from '@srilanka/contracts';

export const statusNames: Record<ActionSummary['status'], string> = {
  Draft: '草稿',
  Submitted: '已提交',
  HostReview: '主持人审核中',
  NeedPlayerInput: '需要补充',
  AIStructuring: 'AI 整理中',
  PendingHostApproval: '待主持人批准',
  PendingPlayerConfirmation: '待玩家确认',
  Approved: '已批准',
  Rejected: '已拒绝',
  Resolving: '结算中',
  Completed: '已完成',
  Withdrawn: '已撤回',
  Invalidated: '已失效',
};

export const categories: Array<[ActionCategory, string]> = [
  ['Exploration', '探索'],
  ['Policy', '内政 / 政策'],
  ['Diplomacy', '外交'],
  ['Construction', '建设'],
  ['Research', '研究'],
  ['Recruitment', '征募'],
  ['Military', '军事'],
  ['Intelligence', '情报'],
  ['Reform', '改革'],
  ['EventResponse', '事件回应'],
  ['Custom', '自由行动'],
];

export function categoryName(category: ActionCategory): string {
  return categories.find(([value]) => value === category)?.[1] ?? category;
}
