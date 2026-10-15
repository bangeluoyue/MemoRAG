import {
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const ALGORITHM = "scrypt";
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

export const TESTER_INITIAL_PASSWORD_HASH = "scrypt$16384$8$1$jQG364TqJ6PdTP0LvtrdsA$vZs3EPGRLhPx7DPia4IpFxfwQJPILFVYFB_NG0j-eSmRhgRfWI2OWPhf4oDe1ut2N9sN0yfCupzF5IjyhnAr1A";

function passwordText(value) {
  const password = String(value ?? "");
  if (!password || password.length > 256) return null;
  return password;
}

export function validateNewPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128 || !password.trim()) {
    throw new Error("新密码长度必须为 8 到 128 个字符");
  }
  return password;
}

export async function hashPassword(value) {
  const password = passwordText(value);
  if (!password) throw new Error("密码不能为空或过长");
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return [
    ALGORITHM,
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString("base64url"),
    Buffer.from(derived).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(value, encoded) {
  const password = passwordText(value);
  if (!password) return false;
  const parts = String(encoded ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
  const [, nText, rText, pText, saltText, digestText] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (![N, r, p].every(Number.isInteger) || N < 2 || r < 1 || p < 1) {
    return false;
  }
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltText, "base64url");
    expected = Buffer.from(digestText, "base64url");
  } catch {
    return false;
  }
  if (!salt.length || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = Buffer.from(await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_OPTIONS.maxmem,
    }));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
