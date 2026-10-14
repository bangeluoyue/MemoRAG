export const NOTE_KNOWLEDGE_BASE = "life_notes";

function mapNote(row) {
  if (!row) return null;
  return {
    noteId: String(row.note_id),
    userId: String(row.user_id),
    knowledgeBase: String(row.knowledge_base),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    syncStatus: String(row.sync_status),
    syncOperation: String(row.sync_operation),
    syncAttempts: Number(row.sync_attempts ?? 0),
    syncErrorCategory: row.sync_error_category == null
      ? null
      : String(row.sync_error_category),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    deletedAt: row.deleted_at ?? null,
    syncUpdatedAt: row.sync_updated_at ?? null,
  };
}

export class PostgresNotesRepository {
  constructor({ pool }) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("PostgresNotesRepository 需要可用的 pool");
    }
    this.pool = pool;
  }

  async create({ noteId, userId, title, content }) {
    const result = await this.pool.query({
      text: `
        INSERT INTO life_notes (
          note_id, user_id, knowledge_base, title, content,
          sync_status, sync_operation
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', 'upsert')
        RETURNING *
      `,
      values: [noteId, userId, NOTE_KNOWLEDGE_BASE, title, content],
    });
    return mapNote(result.rows[0]);
  }

  async findById({ noteId, userId, includeDeleted = false }) {
    const result = await this.pool.query({
      text: `
        SELECT *
        FROM life_notes
        WHERE note_id = $1
          AND user_id = $2
          AND knowledge_base = $3
          ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        LIMIT 1
      `,
      values: [noteId, userId, NOTE_KNOWLEDGE_BASE],
    });
    return mapNote(result.rows[0]);
  }

  async list({ userId, limit }) {
    const result = await this.pool.query({
      text: `
        SELECT *
        FROM life_notes
        WHERE user_id = $1
          AND knowledge_base = $2
          AND deleted_at IS NULL
        ORDER BY updated_at DESC, note_id ASC
        LIMIT $3
      `,
      values: [userId, NOTE_KNOWLEDGE_BASE, limit],
    });
    return result.rows.map(mapNote);
  }

  async update({ noteId, userId, title, content }) {
    const result = await this.pool.query({
      text: `
        UPDATE life_notes
        SET title = $3,
            content = $4,
            sync_status = 'pending',
            sync_operation = 'upsert',
            sync_error_category = NULL,
            updated_at = NOW()
        WHERE note_id = $1
          AND user_id = $2
          AND knowledge_base = $5
          AND deleted_at IS NULL
        RETURNING *
      `,
      values: [noteId, userId, title, content, NOTE_KNOWLEDGE_BASE],
    });
    return mapNote(result.rows[0]);
  }

  async markForDelete({ noteId, userId }) {
    const result = await this.pool.query({
      text: `
        UPDATE life_notes
        SET deleted_at = COALESCE(deleted_at, NOW()),
            sync_status = 'pending',
            sync_operation = 'delete',
            sync_error_category = NULL,
            updated_at = NOW()
        WHERE note_id = $1
          AND user_id = $2
          AND knowledge_base = $3
        RETURNING *
      `,
      values: [noteId, userId, NOTE_KNOWLEDGE_BASE],
    });
    return mapNote(result.rows[0]);
  }

  async markSyncResult({ noteId, userId, status, errorCategory = null }) {
    const result = await this.pool.query({
      text: `
        UPDATE life_notes
        SET sync_status = $3,
            sync_error_category = $4,
            sync_attempts = sync_attempts + 1,
            sync_updated_at = NOW()
        WHERE note_id = $1
          AND user_id = $2
          AND knowledge_base = $5
        RETURNING *
      `,
      values: [noteId, userId, status, errorCategory, NOTE_KNOWLEDGE_BASE],
    });
    return mapNote(result.rows[0]);
  }

  async hardDelete({ noteId, userId }) {
    const result = await this.pool.query({
      text: `
        DELETE FROM life_notes
        WHERE note_id = $1
          AND user_id = $2
          AND knowledge_base = $3
          AND deleted_at IS NOT NULL
        RETURNING note_id
      `,
      values: [noteId, userId, NOTE_KNOWLEDGE_BASE],
    });
    return result.rowCount > 0;
  }
}

export { mapNote };
