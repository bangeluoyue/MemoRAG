function mapUser(row) {
  if (!row) return null;
  return {
    email: String(row.email),
    role: String(row.role),
    notesUserId: String(row.notes_user_id),
    passwordHash: String(row.password_hash),
  };
}

export class PostgresAuthRepository {
  constructor({ pool }) {
    if (!pool || typeof pool.query !== "function") {
      throw new Error("PostgresAuthRepository 需要可用的 pool");
    }
    this.pool = pool;
  }

  async findUser(email) {
    const result = await this.pool.query({
      text: `
        SELECT email, role, notes_user_id, password_hash
        FROM memorag_users
        WHERE email = $1
        LIMIT 1
      `,
      values: [email],
    });
    return mapUser(result.rows[0]);
  }

  async insertUserIfMissing({ email, role, notesUserId, passwordHash }) {
    await this.pool.query({
      text: `
        INSERT INTO memorag_users (email, role, notes_user_id, password_hash)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email) DO NOTHING
      `,
      values: [email, role, notesUserId, passwordHash],
    });
    return this.findUser(email);
  }

  async updatePassword({ email, passwordHash }) {
    const result = await this.pool.query({
      text: `
        UPDATE memorag_users
        SET password_hash = $2,
            password_updated_at = NOW(),
            updated_at = NOW()
        WHERE email = $1
        RETURNING email, role, notes_user_id, password_hash
      `,
      values: [email, passwordHash],
    });
    return mapUser(result.rows[0]);
  }

  async createSession({ sessionDigest, email, expiresAt }) {
    await this.pool.query({
      text: `
        INSERT INTO memorag_sessions (session_digest, user_email, expires_at)
        VALUES ($1, $2, $3)
      `,
      values: [sessionDigest, email, expiresAt],
    });
  }

  async findSession(sessionDigest) {
    const result = await this.pool.query({
      text: `
        SELECT u.email, u.role, u.notes_user_id, u.password_hash
        FROM memorag_sessions s
        JOIN memorag_users u ON u.email = s.user_email
        WHERE s.session_digest = $1
          AND s.expires_at > NOW()
        LIMIT 1
      `,
      values: [sessionDigest],
    });
    return mapUser(result.rows[0]);
  }

  async deleteSession(sessionDigest) {
    await this.pool.query({
      text: "DELETE FROM memorag_sessions WHERE session_digest = $1",
      values: [sessionDigest],
    });
  }

  async deleteSessionsForUser(email) {
    await this.pool.query({
      text: "DELETE FROM memorag_sessions WHERE user_email = $1",
      values: [email],
    });
  }

  async deleteExpiredSessions() {
    await this.pool.query("DELETE FROM memorag_sessions WHERE expires_at <= NOW()");
  }
}

export { mapUser };
