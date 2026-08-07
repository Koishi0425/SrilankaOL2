-- 一局游戏可能持续很长时间：允许保留已完成/归档历史，但同一时刻只能有一个仍在推进的游戏。
CREATE UNIQUE INDEX games_one_in_progress
  ON games ((TRUE))
  WHERE status IN ('Preparing', 'Running', 'Paused', 'Correcting');
