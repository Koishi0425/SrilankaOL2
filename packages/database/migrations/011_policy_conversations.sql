ALTER TABLE conversations
  ADD COLUMN host_player_member_id UUID,
  ADD COLUMN action_review_action_id UUID,
  ADD CONSTRAINT conversations_host_player_fk FOREIGN KEY (game_id, host_player_member_id)
    REFERENCES game_members(game_id, id),
  ADD CONSTRAINT conversations_action_review_fk FOREIGN KEY (game_id, action_review_action_id)
    REFERENCES actions(game_id, id),
  ADD CONSTRAINT conversations_canonical_type CHECK (
    (host_player_member_id IS NULL OR (type = 'HostPlayer' AND action_review_action_id IS NULL))
    AND (action_review_action_id IS NULL OR type = 'ActionReview')
  ),
  ADD CONSTRAINT conversations_host_player_unique UNIQUE (game_id, host_player_member_id),
  ADD CONSTRAINT conversations_action_review_unique UNIQUE (game_id, action_review_action_id);

ALTER TABLE conversation_participants ADD COLUMN last_read_message_id UUID;
