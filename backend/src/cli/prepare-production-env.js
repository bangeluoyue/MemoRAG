import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";

// Local only; never imports application config or constructs service clients.
async function main() {
  const destination = new URL("../../.env.production", import.meta.url);
  const source = parse(await readFile(new URL("../../.env", import.meta.url), "utf8"));
  const template = parse(await readFile(new URL("../../../deploy/production.env.example", import.meta.url), "utf8"));
  for (const name of ["DATABASE_URL", "MILVUS_ADDRESS", "MILVUS_TOKEN", "OPENAI_API_KEY", "MODEL_NAME", "EMBEDDINGS_MODEL_NAME"]) {
    if (!source[name]?.trim()) throw new Error("REQUIRED_SOURCE_VARIABLE_MISSING");
  }
  for (const name of ["DATABASE_URL", "MILVUS_ADDRESS", "MILVUS_TOKEN", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_NAME", "EMBEDDINGS_MODEL_NAME"]) {
    template[name] = source[name] || "";
  }
  const url = new URL(template.DATABASE_URL);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("uselibpqcompat");
  template.DATABASE_URL = url.toString();
  const endpoint = new URL(template.MILVUS_ADDRESS);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("ZILLIZ_HTTPS_REQUIRED");
  // gRPC's TLS default is 443; make it explicit to avoid SDK warnings.
  template.MILVUS_ADDRESS = `https://${endpoint.hostname}:${endpoint.port || 443}`;
  template.SESSION_SECRET = randomBytes(48).toString("hex");
  template.ADMIN_INITIAL_PASSWORD = randomBytes(24).toString("base64url");
  template.DEPLOY_TESTER_PASSWORD = randomBytes(24).toString("base64url");
  const lines = Object.entries(template).map(([key, value]) => {
    if (/[\r\n"`]/u.test(value)) throw new Error("UNSUPPORTED_ENV_VALUE_ENCODING");
    return `${key}="${value}"`;
  });
  await writeFile(destination, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
  console.log("Private backend/.env.production created (0600); development .env unchanged. No connections or API calls.");
}
main().catch(() => {
  console.error("Private environment preparation failed; source/destination unchanged. Check required variables or an existing destination; never print credentials.");
  process.exitCode = 1;
});
