import { pathToFileURL } from "node:url";

export async function main(argv = process.argv.slice(2)) {
  const [target, ...flags] = argv;
  if (!["postgres", "milvus", "elasticsearch", "accounts"].includes(target)
    || flags.some(f => !["--check", "--execute"].includes(f))
    || (flags.includes("--check") && flags.includes("--execute"))) {
    throw new Error("USAGE: init-deployment <postgres|milvus|elasticsearch|accounts> [--check|--execute]");
  }
  const execute = flags.includes("--execute");
  if (!execute && !flags.includes("--check")) {
    console.log(`Dry-run: ${target}; no connections, writes, embeddings or model calls.`);
    return;
  }
  if (!process.env.MEMORAG_ENV_FILE) throw new Error("PRIVATE_ENV_FILE_REQUIRED");
  const { getConfig } = await import("../config.js");
  const config = getConfig();
  if (config.model.embeddingDimension !== 1024) throw new Error("DEPLOY_DIMENSION_MUST_BE_1024");
  const { initializeMilvus, initializeElasticsearch, migratePostgres } = await import("../deploy/initialize.js");
  if (target === "postgres") {
    const { Client } = await import("pg");
    const connectionString = process.env.DATABASE_MIGRATION_URL?.trim() || config.notes.postgres.connectionString;
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") !== "verify-full") throw new Error("DATABASE_VERIFY_FULL_REQUIRED");
    const client = new Client({ connectionString, ssl: true, connectionTimeoutMillis: 15000, query_timeout: 30000 });
    try {
      await client.connect();
      if (execute) await migratePostgres(client);
      else {
        const result = await client.query("SELECT to_regclass('public.life_notes') IS NOT NULL AS notes, to_regclass('public.memorag_users') IS NOT NULL AS users, to_regclass('public.memorag_sessions') IS NOT NULL AS sessions");
        console.log(JSON.stringify(result.rows[0]));
      }
      console.log(execute ? "PostgreSQL migrations complete." : "PostgreSQL read-only check complete.");
    } finally { await client.end(); }
  } else if (target === "milvus") {
    if (!config.milvus.address.startsWith("https://") || !config.milvus.token) throw new Error("ZILLIZ_HTTPS_TOKEN_REQUIRED");
    const { createMilvusClient } = await import("../rag/ebook/milvus-retriever.js");
    const client = createMilvusClient(config.milvus);
    try { console.log(JSON.stringify(await initializeMilvus(client, config, { execute }))); }
    finally { await client.closeConnection(); }
  } else if (target === "elasticsearch") {
    if (config.notes.elasticsearch.node !== "http://127.0.0.1:9200") throw new Error("ES_LOOPBACK_REQUIRED");
    const { createElasticsearchClient } = await import("../rag/notes/elasticsearch-retriever.js");
    const client = createElasticsearchClient(config.notes.elasticsearch);
    try { console.log(JSON.stringify(await initializeElasticsearch(client, config.notes.elasticsearch.indexName, { execute }))); }
    finally { await client.close(); }
  } else {
    if (!execute) throw new Error("ACCOUNTS_CHECK_UNSUPPORTED_USE_POSTGRES_CHECK");
    // Same initialization and password reset used by the existing HTTP application.
    // Explicit execution resets tester password and invalidates tester sessions.
    const password = process.env.DEPLOY_TESTER_PASSWORD;
    if (!password || password.length < 12 || password.length > 128) throw new Error("DEPLOY_TESTER_PASSWORD_REQUIRED_12_TO_128");
    const { createAuthService, ADMIN_EMAIL } = await import("../auth/index.js");
    const auth = createAuthService({ config });
    try {
      await auth.initialize();
      await auth.changeTesterPassword({ role: "admin", email: ADMIN_EMAIL }, password);
      console.log("Accounts initialized; tester password reset and tester sessions invalidated.");
    } finally { await auth.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Do not print upstream errors: pg/Milvus may include connection credentials.
    const safeCode = /^(?:COLLECTION_[A-Z_]+(?::[a-z_]+)?|COLLECTIONS_MUST_BE_SEPARATE|EXISTING_COLLECTION_NOT_LOADED|MILVUS_OPERATION_FAILED|ES_[A-Z_]+(?::[a-z_]+)?|DATABASE_VERIFY_FULL_REQUIRED|PRIVATE_ENV_FILE_REQUIRED|ZILLIZ_HTTPS_TOKEN_REQUIRED|DEPLOY_[A-Z_]+|ACCOUNTS_CHECK_UNSUPPORTED_USE_POSTGRES_CHECK)$/u.test(error?.message ?? "")
      ? error.message : "UPSTREAM_OR_CONFIGURATION_ERROR";
    console.error(`Deployment initialization failed [${safeCode}]; stopped. No automatic retry.`);
    process.exitCode = 1;
  });
}
