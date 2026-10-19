import type { ActionCategory } from '@srilanka/contracts';

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
