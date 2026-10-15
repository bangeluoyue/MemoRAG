import {
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  TESTER_INITIAL_PASSWORD_HASH,
  hashPassword,
  validateNewPassword,
  verifyPassword,
} from "./passwords.js";

export const ADMIN_EMAIL = "18296262260@163.com";
export const TESTER_EMAIL = "test@123.com";
export const SESSION_COOKIE_NAME = "memorag_session";

const FIXED_USERS = Object.freeze({
  admin: {
    email: ADMIN_EMAIL,
    role: "admin",
    notesUserId: "account-admin",
  },
  tester: {
    email: TESTER_EMAIL,
    role: "tester",
    notesUserId: "account-tester",
  },
});

export class AuthServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthServiceError";
    this.code = code;
  }
}

function normalizedEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function publicUser(user) {
  return user ? { email: user.email, role: user.role } : null;
}

function cookieValue(cookieHeader, name) {
  for (const part of String(cookieHeader ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function assertFixedUser(user, expected) {
  if (!user || user.role !== expected.role || user.notesUserId !== expected.notesUserId) {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      `固定账号 ${expected.email} 的角色或笔记范围不兼容`,
    );
  }
  return user;
}

export class AuthService {
  constructor({
    repository,
    sessionSecret,
    adminInitialPassword = "",
    secureCookie = false,
    sessionTtlSeconds = 7 * 24 * 60 * 60,
    loginWindowMs = 15 * 60 * 1000,
    loginMaxFailures = 5,
    now = () => Date.now(),
    passwords = { hashPassword, verifyPassword },
    closeResources = async () => {},
  }) {
    if (!repository) throw new Error("AuthService 缺少 repository");
    if (String(sessionSecret ?? "").length < 32) {
      throw new AuthServiceError(
        "AUTH_CONFIG_INVALID",
        "SESSION_SECRET 至少需要 32 个字符",
      );
    }
    this.repository = repository;
    this.sessionSecret = String(sessionSecret);
    this.adminInitialPassword = String(adminInitialPassword ?? "");
    this.secureCookie = Boolean(secureCookie);
    this.sessionTtlSeconds = Number(sessionTtlSeconds);
    this.loginWindowMs = Number(loginWindowMs);
    this.loginMaxFailures = Number(loginMaxFailures);
    this.now = now;
    this.passwords = passwords;
    this.closeResources = closeResources;
    this.failures = new Map();
  }

  async initialize() {
    await this.repository.deleteExpiredSessions();
    const existingAdmin = await this.repository.findUser(ADMIN_EMAIL);
    if (!existingAdmin) {
      if (!this.adminInitialPassword) {
        throw new AuthServiceError(
          "AUTH_CONFIG_INVALID",
          "首次启动缺少 ADMIN_INITIAL_PASSWORD",
        );
      }
      let initialPassword;
      try {
        initialPassword = validateNewPassword(this.adminInitialPassword);
      } catch {
        throw new AuthServiceError(
          "AUTH_CONFIG_INVALID",
          "ADMIN_INITIAL_PASSWORD 长度必须为 8 到 128 个字符",
        );
      }
      const created = await this.repository.insertUserIfMissing({
        ...FIXED_USERS.admin,
        passwordHash: await this.passwords.hashPassword(initialPassword),
      });
      assertFixedUser(created, FIXED_USERS.admin);
    } else {
      assertFixedUser(existingAdmin, FIXED_USERS.admin);
    }
    const existingTester = await this.repository.findUser(TESTER_EMAIL);
    if (!existingTester) {
      const created = await this.repository.insertUserIfMissing({
        ...FIXED_USERS.tester,
        passwordHash: TESTER_INITIAL_PASSWORD_HASH,
      });
      assertFixedUser(created, FIXED_USERS.tester);
    } else {
      assertFixedUser(existingTester, FIXED_USERS.tester);
    }
  }

  #digest(token) {
    return createHmac("sha256", this.sessionSecret).update(token).digest("hex");
  }

  #failureKey(email, clientKey) {
    return `${String(clientKey ?? "local").slice(0, 128)}\0${email}`;
  }

  #activeFailures(key) {
    const cutoff = this.now() - this.loginWindowMs;
    const values = (this.failures.get(key) ?? []).filter((value) => value >= cutoff);
    if (values.length) this.failures.set(key, values);
    else this.failures.delete(key);
    return values;
  }

  #recordFailure(key) {
    const values = this.#activeFailures(key);
    values.push(this.now());
    this.failures.set(key, values);
  }

  async login({ email, password, clientKey }) {
    const normalized = normalizedEmail(email);
    const fixedEmail = [ADMIN_EMAIL, TESTER_EMAIL].includes(normalized);
    const key = this.#failureKey(fixedEmail ? normalized : "unknown", clientKey);
    if (this.#activeFailures(key).length >= this.loginMaxFailures) {
      throw new AuthServiceError(
        "AUTH_RATE_LIMITED",
        "登录失败次数过多，请稍后再试",
      );
    }
    const user = fixedEmail
      ? await this.repository.findUser(normalized)
      : null;
    const validHash = await this.passwords.verifyPassword(
      password,
      user?.passwordHash ?? TESTER_INITIAL_PASSWORD_HASH,
    );
    const valid = Boolean(user) && validHash;
    if (!valid) {
      this.#recordFailure(key);
      throw new AuthServiceError("INVALID_CREDENTIALS", "账号或密码错误");
    }
    this.failures.delete(key);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now() + (this.sessionTtlSeconds * 1000));
    await this.repository.createSession({
      sessionDigest: this.#digest(token),
      email: user.email,
      expiresAt,
    });
    return { token, user: publicUser(user) };
  }

  async authenticate(cookieHeader) {
    const token = cookieValue(cookieHeader, SESSION_COOKIE_NAME);
    if (!token) return null;
    return this.repository.findSession(this.#digest(token));
  }

  async logout(cookieHeader) {
    const token = cookieValue(cookieHeader, SESSION_COOKIE_NAME);
    if (token) await this.repository.deleteSession(this.#digest(token));
  }

  async changeTesterPassword(actor, value) {
    if (actor?.role !== "admin" || actor?.email !== ADMIN_EMAIL) {
      throw new AuthServiceError("FORBIDDEN", "仅管理员可以修改测试员密码");
    }
    let password;
    try {
      password = validateNewPassword(value);
    } catch (error) {
      throw new AuthServiceError("INPUT_INVALID", error.message);
    }
    const passwordHash = await this.passwords.hashPassword(password);
    const updated = await this.repository.updatePassword({
      email: TESTER_EMAIL,
      passwordHash,
    });
    if (!updated) {
      throw new AuthServiceError("AUTH_CONFIG_INVALID", "测试员账号尚未初始化");
    }
    await this.repository.deleteSessionsForUser(TESTER_EMAIL);
    return { user: publicUser(updated) };
  }

  sessionCookie(token) {
    return [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${this.sessionTtlSeconds}`,
      ...(this.secureCookie ? ["Secure"] : []),
    ].join("; ");
  }

  clearSessionCookie() {
    return [
      `${SESSION_COOKIE_NAME}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=0",
      ...(this.secureCookie ? ["Secure"] : []),
    ].join("; ");
  }

  publicUser(user) {
    return publicUser(user);
  }

  async close() {
    await this.closeResources();
  }
}
