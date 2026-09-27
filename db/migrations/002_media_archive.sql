BEGIN;

ALTER TABLE messages
  ADD COLUMN media_url text,
  ADD COLUMN local_file_path text,
  ADD COLUMN media_archived_at timestamptz,
  ADD COLUMN media_archive_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN media_next_attempt_at timestamptz;

CREATE INDEX messages_media_archive_idx
  ON messages(media_next_attempt_at, sent_at)
  WHERE media_url IS NOT NULL AND local_file_path IS NULL;

INSERT INTO schema_migrations(version) VALUES (2);
COMMIT;
