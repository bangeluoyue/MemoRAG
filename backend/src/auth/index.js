import { Pool } from "pg";
import { getConfig } from "../config.js";
import { PostgresAuthRepository } from "./repository.js";
import { AuthService } from "./service.js";

export function createAuthService(options = {}) {
  const config = options.config ?? getConfig();
  const ownsPool = !options.repository && !options.pool;
  if (!options.repository && !config.notes.postgres.connectionString) {
    throw new Error("认证存储缺少必要环境变量：DATABASE_URL");
  }
  const pool = options.pool ?? (options.repository ? null : new Pool({
    connectionString: config.notes.postgres.connectionString,
    ssl: config.notes.postgres.ssl || undefined,
  }));
  const repository = options.repository ?? new PostgresAuthRepository({ pool });
  return new AuthService({
    repository,
    sessionSecret: config.auth.sessionSecret,
    adminInitialPassword: config.auth.adminInitialPassword,
    secureCookie: config.auth.secureCookie,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    loginWindowMs: config.auth.loginWindowMs,
    loginMaxFailures: config.auth.loginMaxFailures,
    ...(options.passwords ? { passwords: options.passwords } : {}),
    ...(options.now ? { now: options.now } : {}),
    async closeResources() {
      if (ownsPool) await pool.end();
    },
  });
}

export { PostgresAuthRepository } from "./repository.js";
export {
  ADMIN_EMAIL,
  AuthService,
  AuthServiceError,
  SESSION_COOKIE_NAME,
  TESTER_EMAIL,
} from "./service.js";
export {
  TESTER_INITIAL_PASSWORD_HASH,
  hashPassword,
  validateNewPassword,
  verifyPassword,
} from "./passwords.js";
