ALTER TABLE games
  ADD COLUMN ended_at TIMESTAMPTZ,
  ADD COLUMN ended_by_user_id UUID REFERENCES users(id),
  ADD COLUMN ending_reason TEXT;

CREATE TABLE game_lifecycle_history (
  id UUID PRIMARY KEY,
  game_id UUID NOT NULL REFERENCES games(id),
  quarter_id UUID NOT NULL REFERENCES quarters(id),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- All existing game content is frozen, including writes from older clients or jobs.
-- Shared advisory locks serialize ending against in-flight content changes without
-- introducing a new game-row lock order into the existing quarter/map transactions.
CREATE FUNCTION require_writable_game(target_game UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE current_status TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(1936445702, hashtext(target_game::TEXT));
  SELECT status INTO current_status FROM games WHERE id=target_game FOR KEY SHARE;
  IF current_status IN ('Completed', 'Archived') THEN
    RAISE EXCEPTION 'GAME_READ_ONLY' USING ERRCODE='23514', CONSTRAINT='game_read_only';
  END IF;
END;
$$;

CREATE FUNCTION guard_game_content() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- Reading a conversation may update its read cursor after the game has ended.
  IF TG_TABLE_NAME='conversation_participants' AND TG_OP='UPDATE'
    AND (to_jsonb(NEW)-'last_read_at'-'last_read_message_id') =
        (to_jsonb(OLD)-'last_read_at'-'last_read_message_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM require_writable_game(OLD.game_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM require_writable_game(NEW.game_id); RETURN NEW; END IF;
  RETURN OLD;
END;
$$;

DO $$
DECLARE target RECORD;
BEGIN
  FOR target IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='game_id'
      AND table_name <> 'game_lifecycle_history'
  LOOP
    EXECUTE format('CREATE TRIGGER game_content_read_only BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_game_content()', target.table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION guard_game_lifecycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('Completed', 'Archived') THEN
    RAISE EXCEPTION 'GAME_READ_ONLY' USING ERRCODE='23514', CONSTRAINT='game_read_only';
  END IF;
  PERFORM require_writable_game(OLD.id);
  IF TG_OP='UPDATE' AND NEW.status IN ('Completed', 'Archived') AND
    NOT pg_try_advisory_xact_lock(1936445702, hashtext(OLD.id::TEXT)) THEN
    RAISE EXCEPTION 'GAME_BUSY' USING ERRCODE='23514', CONSTRAINT='game_busy';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER game_lifecycle_read_only BEFORE UPDATE OR DELETE ON games
FOR EACH ROW EXECUTE FUNCTION guard_game_lifecycle();
