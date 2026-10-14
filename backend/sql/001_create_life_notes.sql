CREATE TABLE IF NOT EXISTS life_notes (
  note_id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  knowledge_base VARCHAR(32) NOT NULL DEFAULT 'life_notes',
  title VARCHAR(500) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  sync_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  sync_operation VARCHAR(16) NOT NULL DEFAULT 'upsert',
  sync_attempts INTEGER NOT NULL DEFAULT 0,
  sync_error_category VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  sync_updated_at TIMESTAMPTZ,
  CONSTRAINT life_notes_knowledge_base_check
    CHECK (knowledge_base = 'life_notes'),
  CONSTRAINT life_notes_sync_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed')),
  CONSTRAINT life_notes_sync_operation_check
    CHECK (sync_operation IN ('upsert', 'delete')),
  CONSTRAINT life_notes_sync_attempts_check
    CHECK (sync_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS life_notes_user_updated_idx
  ON life_notes (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS life_notes_sync_retry_idx
  ON life_notes (sync_status, sync_operation, sync_updated_at)
  WHERE sync_status IN ('pending', 'failed');
