import { config as loadDotEnv } from "dotenv";
import { fileURLToPath } from "node:url";

// Production/CLI can select a private file without falling back to development secrets.
const envPath = process.env.MEMORAG_ENV_FILE
  || fileURLToPath(new URL("../.env", import.meta.url));
const loadedEnv = loadDotEnv({ path: envPath, quiet: true });
if (process.env.MEMORAG_ENV_FILE && loadedEnv.error) {
  throw new Error("无法读取 MEMORAG_ENV_FILE 指定的环境变量文件");
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`缺少必要环境变量：${name}`);
  }
  return value;
}

// fallback是默认兜底值
function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function boundedInteger(env, name, fallback, { minimum, maximum }) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function booleanValue(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function enumValue(env, name, allowedValues, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!allowedValues.includes(raw)) {
    throw new Error(`${name} 必须是 ${allowedValues.join(" 或 ")}`);
  }
  return raw;
}

function firstNonEmpty(env, names) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function firstTracingEnabled(env, names) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value === "true";
  }
  return false;
}

export function getConfig(env = process.env) {
  const bochaApiKey = env.BOCHA_API_KEY?.trim() || "";
  const modelApiKey = required(env, "OPENAI_API_KEY");
  const retrievalK = positiveInteger(env, "RETRIEVAL_K", 8);
  const rerankEnabled = booleanValue(env, "ENABLE_RERANK", false);
  const noteRerankEnabled = booleanValue(env, "ENABLE_NOTE_RERANK", false);
  const rerankTopN = positiveInteger(env, "RERANK_TOP_N", retrievalK);
  const rerankCandidateK = Math.max(
    rerankTopN,
    positiveInteger(env, "RERANK_CANDIDATE_K", Math.max(20, rerankTopN)),
  );
  const rerankUrl = env.RERANK_URL?.trim() || "";
  const langsmithRequested = firstTracingEnabled(env, [
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
  ]);
  const langsmithApiKey = firstNonEmpty(env, [
    "LANGSMITH_API_KEY",
    "LANGCHAIN_API_KEY",
  ]);

  if ((rerankEnabled || noteRerankEnabled) && !rerankUrl) {
    throw new Error("启用 Rerank 时缺少必要环境变量：RERANK_URL");
  }

  return {
    http: {
      host: env.HTTP_HOST?.trim() || "127.0.0.1",
      port: boundedInteger(env, "HTTP_PORT", 3000, {
        minimum: 1,
        maximum: 65535,
      }),
    },
    auth: {
      adminInitialPassword: env.ADMIN_INITIAL_PASSWORD || "",
      sessionSecret: env.SESSION_SECRET?.trim() || "",
      secureCookie: booleanValue(
        env,
        "AUTH_COOKIE_SECURE",
        env.NODE_ENV?.trim().toLowerCase() === "production",
      ),
      sessionTtlSeconds: boundedInteger(
        env,
        "AUTH_SESSION_TTL_SECONDS",
        7 * 24 * 60 * 60,
        { minimum: 300, maximum: 30 * 24 * 60 * 60 },
      ),
      loginWindowMs: boundedInteger(
        env,
        "AUTH_LOGIN_WINDOW_MS",
        15 * 60 * 1000,
        { minimum: 1000, maximum: 24 * 60 * 60 * 1000 },
      ),
      loginMaxFailures: boundedInteger(
        env,
        "AUTH_LOGIN_MAX_FAILURES",
        5,
        { minimum: 1, maximum: 20 },
      ),
    },
    uploads: {
      epubMaxBytes: boundedInteger(
        env,
        "EPUB_UPLOAD_MAX_BYTES",
        25 * 1024 * 1024,
        { minimum: 1024, maximum: 100 * 1024 * 1024 },
      ),
    },
    model: {
      apiKey: modelApiKey,
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      chatModel: required(env, "MODEL_NAME"),
      embeddingModel: required(env, "EMBEDDINGS_MODEL_NAME"),
      embeddingDimension: positiveInteger(env, "EMBEDDING_DIMENSION", 1024),
      requestTimeoutMs: boundedInteger(env, "LLM_TIMEOUT_MS", 60000, {
        minimum: 1000,
        maximum: 300000,
      }),
      maxRetries: boundedInteger(env, "LLM_MAX_RETRIES", 0, {
        minimum: 0,
        maximum: 5,
      }),
    },
    milvus: {
      address: required(env, "MILVUS_ADDRESS"),
      token: env.MILVUS_TOKEN?.trim() || undefined,
      collectionName: env.MILVUS_BOOK_COLLECTION?.trim() || "ebook_collection",
      bookId: env.MILVUS_BOOK_ID?.trim() || "1",
      nprobe: positiveInteger(env, "MILVUS_NPROBE", 16),
    },
    notes: {
      knowledgeBase: "life_notes",
      postgres: {
        connectionString: env.DATABASE_URL?.trim() || "",
        ssl: booleanValue(env, "DATABASE_SSL", false),
      },
      elasticsearch: {
        node: env.ELASTICSEARCH_NODE?.trim() || "http://localhost:9200",
        indexName: env.ELASTICSEARCH_NOTES_INDEX?.trim() || "life_notes",
      },
      milvus: {
        collectionName: env.MILVUS_NOTES_COLLECTION?.trim() || "life_notes",
      },
      keywordK: positiveInteger(env, "NOTES_KEYWORD_K", 20),
      vectorK: positiveInteger(env, "NOTES_VECTOR_K", 20),
      rerankEnabled: noteRerankEnabled,
    },
    rag: {
      bookName: env.BOOK_NAME?.trim() || "天龙八部",
      retrievalK,
      maxRetrievals: positiveInteger(env, "MAX_RETRIEVALS", 8),
      maxContextDocuments: positiveInteger(env, "MAX_CONTEXT_DOCUMENTS", 12),
      maxSubQuestions: boundedInteger(env, "MAX_SUB_QUESTIONS", 4, {
        minimum: 1,
        maximum: 8,
      }),
      maxPlanRepairAttempts: boundedInteger(
        env,
        "MAX_PLAN_REPAIR_ATTEMPTS",
        1,
        { minimum: 0, maximum: 2 },
      ),
      maxSingleRetrievals: boundedInteger(env, "MAX_SINGLE_RETRIEVALS", 2, {
        minimum: 1,
        maximum: 3,
      }),
      maxGapRecoveryAttempts: boundedInteger(
        env,
        "MAX_GAP_RECOVERY_ATTEMPTS",
        1,
        { minimum: 0, maximum: 1 },
      ),
      agentTimeoutMs: boundedInteger(env, "AGENT_TIMEOUT_MS", 120000, {
        minimum: 1000,
        maximum: 600000,
      }),
      decisionTimeoutMs: boundedInteger(env, "DECISION_TIMEOUT_MS", 15000, {
        minimum: 1000,
        maximum: 60000,
      }),
    },
    rerank: {
      enabled: rerankEnabled,
      apiKey: env.RERANK_API_KEY?.trim()
        || env.DASHSCOPE_API_KEY?.trim()
        || modelApiKey,
      url: rerankUrl,
      model: env.RERANK_MODEL?.trim() || "qwen3-rerank",
      topN: rerankTopN,
      candidateK: rerankCandidateK,
      timeoutMs: positiveInteger(env, "RERANK_TIMEOUT_MS", 10000),
      failureMode: enumValue(
        env,
        "RERANK_FAILURE_MODE",
        ["fallback", "error"],
        "fallback",
      ),
    },
    webSearch: {
      enabled: booleanValue(env, "ENABLE_WEB_SEARCH", false) && Boolean(bochaApiKey),
      apiKey: bochaApiKey,
      url: env.BOCHA_SEARCH_URL?.trim() || "https://api.bochaai.com/v1/web-search",
      maxSearches: positiveInteger(env, "MAX_WEB_SEARCHES", 2),
    },
    langsmith: {
      requested: langsmithRequested,
      enabled: langsmithRequested && Boolean(langsmithApiKey),
      disabledReason: langsmithRequested && !langsmithApiKey
        ? "missing_api_key"
        : null,
      apiKey: langsmithApiKey,
      endpoint: firstNonEmpty(env, [
        "LANGSMITH_ENDPOINT",
        "LANGCHAIN_ENDPOINT",
      ]) || undefined,
      project: firstNonEmpty(env, [
        "LANGSMITH_PROJECT",
        "LANGCHAIN_PROJECT",
      ]) || "memorag",
      contentMode: enumValue(
        env,
        "MEMORAG_LANGSMITH_CONTENT_MODE",
        ["metadata_only", "full"],
        "metadata_only",
      ),
      noteTracingEnabled: booleanValue(
        env,
        "ENABLE_NOTE_LANGSMITH_TRACING",
        false,
      ),
    },
  };
}
