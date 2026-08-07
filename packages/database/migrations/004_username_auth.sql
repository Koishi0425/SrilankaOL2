-- 账号从邮箱迁移为用户名。旧邮箱默认使用 @ 前的部分，重名时追加 UUID 短后缀。
DROP INDEX users_email_unique;

ALTER TABLE users RENAME COLUMN email TO username;

WITH username_candidates AS (
  SELECT
    id,
    CASE
      WHEN POSITION('@' IN username) > 1 THEN SPLIT_PART(username, '@', 1)
      ELSE username
    END AS base_username
  FROM users
), ranked_usernames AS (
  SELECT
    id,
    base_username,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(base_username)
      ORDER BY id
    ) AS duplicate_number
  FROM username_candidates
)
UPDATE users AS target
SET username = CASE
  WHEN ranked.duplicate_number = 1 THEN LEFT(ranked.base_username, 64)
  ELSE LEFT(ranked.base_username, 55) || '_' || LEFT(target.id::TEXT, 8)
END
FROM ranked_usernames AS ranked
WHERE target.id = ranked.id;

ALTER TABLE users
  ADD CONSTRAINT users_username_format
  CHECK (
    username = BTRIM(username)
    AND CHAR_LENGTH(username) BETWEEN 1 AND 64
    AND username !~ '[[:space:]]'
  );

CREATE UNIQUE INDEX users_username_unique ON users (LOWER(username));
