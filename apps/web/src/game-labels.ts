import type { GameRole, GameStatus, QuarterState } from '@srilanka/contracts';
export const seasonNames = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};

export const roleNames: Record<GameRole, string> = {
  Host: '主持人',
  Player: '玩家',
  Observer: '观察者',
  Administrator: '管理员',
};

export const gameStatusNames: Record<GameStatus, string> = {
  Preparing: '准备中',
  Running: '进行中',
  Paused: '已暂停',
  Correcting: '修正中',
  Completed: '已结束',
  Archived: '已归档',
};

export const quarterStateNames: Record<QuarterState, string> = {
  Preparing: '回合准备',
  EventResponse: '事件回应',
  ActionSubmission: '政策提交中',
  Locked: '提交已锁定',
  HostReview: '主持人审核中',
  AIProcessing: '行动整理中',
  Resolving: '结算中',
  PendingPublication: '待公布',
  Published: '已公布',
  DisputeReview: '争议审核',
  Correcting: '修正中',
  Completed: '回合结束',
};
