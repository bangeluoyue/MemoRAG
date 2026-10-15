import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_EMAIL,
  AuthService,
  AuthServiceError,
  PostgresAuthRepository,
  TESTER_EMAIL,
  TESTER_INITIAL_PASSWORD_HASH,
  verifyPassword,
} from "../src/auth/index.js";

class MemoryAuthRepository {
  constructor() {
    this.users = new Map();
    this.sessions = new Map();
  }

  async findUser(email) { return this.users.get(email) ?? null; }
  async insertUserIfMissing(user) {
    if (!this.users.has(user.email)) this.users.set(user.email, { ...user });
    return this.findUser(user.email);
  }
  async updatePassword({ email, passwordHash }) {
    const user = this.users.get(email);
    if (!user) return null;
    const updated = { ...user, passwordHash };
    this.users.set(email, updated);
    return updated;
  }
  async createSession({ sessionDigest, email, expiresAt }) {
    this.sessions.set(sessionDigest, { email, expiresAt });
  }
  async findSession(sessionDigest) {
    const session = this.sessions.get(sessionDigest);
    if (!session || session.expiresAt <= new Date()) return null;
    return this.findUser(session.email);
  }
  async deleteSession(sessionDigest) { this.sessions.delete(sessionDigest); }
  async deleteSessionsForUser(email) {
    for (const [digest, session] of this.sessions) {
      if (session.email === email) this.sessions.delete(digest);
    }
  }
  async deleteExpiredSessions() {}
}

const passwords = {
  async hashPassword(value) { return `hash:${value}`; },
  async verifyPassword(value, encoded) {
    if (encoded === TESTER_INITIAL_PASSWORD_HASH) return value === "123456";
    return encoded === `hash:${value}`;
  },
};

function service(repository, overrides = {}) {
  return new AuthService({
    repository,
    sessionSecret: "test-session-secret-with-at-least-32-characters",
    adminInitialPassword: "admin-secret",
    passwords,
    ...overrides,
  });
}

test("fixed accounts initialize once, login via HttpOnly cookie, and logout", async () => {
  const repository = new MemoryAuthRepository();
  const auth = service(repository);
  await auth.initialize();

  assert.deepEqual(
    [...repository.users.keys()].sort(),
    [ADMIN_EMAIL, TESTER_EMAIL].sort(),
  );
  assert.notEqual(repository.users.get(ADMIN_EMAIL).passwordHash, "admin-secret");
  assert.equal(await verifyPassword("123456", TESTER_INITIAL_PASSWORD_HASH), true);

  const login = await auth.login({
    email: ADMIN_EMAIL,
    password: "admin-secret",
    clientKey: "127.0.0.1",
  });
  const cookie = auth.sessionCookie(login.token);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Lax/u);
  assert.doesNotMatch(cookie, /admin-secret/u);
  assert.deepEqual(auth.publicUser(await auth.authenticate(cookie)), {
    email: ADMIN_EMAIL,
    role: "admin",
  });
  await auth.logout(cookie);
  assert.equal(await auth.authenticate(cookie), null);
});

test("admin password reset persists across initialization and invalidates tester sessions", async () => {
  const repository = new MemoryAuthRepository();
  const auth = service(repository);
  await auth.initialize();
  const testerLogin = await auth.login({
    email: TESTER_EMAIL,
    password: "123456",
    clientKey: "tester",
  });
  const testerCookie = auth.sessionCookie(testerLogin.token);
  const admin = repository.users.get(ADMIN_EMAIL);
  const originalAdminHash = admin.passwordHash;

  await assert.rejects(
    auth.changeTesterPassword(repository.users.get(TESTER_EMAIL), "new-password"),
    (error) => error instanceof AuthServiceError && error.code === "FORBIDDEN",
  );
  await auth.changeTesterPassword(admin, "new-password");
  assert.equal(await auth.authenticate(testerCookie), null);
  await assert.rejects(
    auth.login({ email: TESTER_EMAIL, password: "123456", clientKey: "old" }),
    (error) => error.code === "INVALID_CREDENTIALS",
  );
  assert.equal((await auth.login({
    email: TESTER_EMAIL,
    password: "new-password",
    clientKey: "new",
  })).user.role, "tester");

  const restarted = service(repository, { adminInitialPassword: "different-value" });
  await restarted.initialize();
  assert.equal(repository.users.get(ADMIN_EMAIL).passwordHash, originalAdminHash);
  assert.equal(repository.users.get(TESTER_EMAIL).passwordHash, "hash:new-password");
});

test("login failures are generic and rate limited per account/client", async () => {
  const repository = new MemoryAuthRepository();
  const auth = service(repository, { loginMaxFailures: 2 });
  await auth.initialize();
  for (const email of ["unknown@example.com", ADMIN_EMAIL]) {
    await assert.rejects(
      auth.login({ email, password: "wrong", clientKey: email }),
      (error) => error.code === "INVALID_CREDENTIALS" && error.message === "账号或密码错误",
    );
  }
  await assert.rejects(
    auth.login({ email: ADMIN_EMAIL, password: "wrong", clientKey: "limited" }),
    (error) => error.code === "INVALID_CREDENTIALS",
  );
  await assert.rejects(
    auth.login({ email: ADMIN_EMAIL, password: "wrong", clientKey: "limited" }),
    (error) => error.code === "INVALID_CREDENTIALS",
  );
  await assert.rejects(
    auth.login({ email: ADMIN_EMAIL, password: "admin-secret", clientKey: "limited" }),
    (error) => error.code === "AUTH_RATE_LIMITED",
  );
});

test("PostgreSQL auth repository parameterizes users, password updates, and sessions", async () => {
  const calls = [];
  const pool = {
    async query(input) {
      calls.push(input);
      const text = typeof input === "string" ? input : input.text;
      if (/UPDATE memorag_users/u.test(text)) {
        return { rows: [{
          email: TESTER_EMAIL,
          role: "tester",
          notes_user_id: "account-tester",
          password_hash: input.values[1],
        }] };
      }
      if (/FROM memorag_sessions/u.test(text) || /FROM memorag_users/u.test(text)) {
        return { rows: [{
          email: TESTER_EMAIL,
          role: "tester",
          notes_user_id: "account-tester",
          password_hash: "hash:value",
        }] };
      }
      return { rows: [] };
    },
  };
  const repository = new PostgresAuthRepository({ pool });
  assert.equal((await repository.findUser(TESTER_EMAIL)).notesUserId, "account-tester");
  await repository.insertUserIfMissing({
    email: TESTER_EMAIL,
    role: "tester",
    notesUserId: "account-tester",
    passwordHash: "hash:value",
  });
  assert.equal((await repository.updatePassword({
    email: TESTER_EMAIL,
    passwordHash: "hash:new",
  })).passwordHash, "hash:new");
  await repository.createSession({
    sessionDigest: "a".repeat(64),
    email: TESTER_EMAIL,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  });
  assert.equal((await repository.findSession("a".repeat(64))).email, TESTER_EMAIL);
  await repository.deleteSession("a".repeat(64));
  await repository.deleteSessionsForUser(TESTER_EMAIL);
  await repository.deleteExpiredSessions();

  const parameterized = calls.filter((call) => typeof call === "object");
  assert.ok(parameterized.length >= 7);
  assert.equal(parameterized.every((call) => !call.text.includes(TESTER_EMAIL)), true);
  assert.equal(parameterized.some((call) => call.values?.includes(TESTER_EMAIL)), true);
});
