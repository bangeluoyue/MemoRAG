import { config as loadDotEnv } from "dotenv";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
loadDotEnv({ path: envPath, quiet: true }); //quiet: true：关闭 dotenv 正常加载时的提示信息

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

function booleanValue(env, name, fallback) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

export function getConfig(env = process.env) {
  const bochaApiKey = env.BOCHA_API_KEY?.trim() || "";

  return {
    model: {
      apiKey: required(env, "OPENAI_API_KEY"),
      baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
      chatModel: required(env, "MODEL_NAME"),
      embeddingModel: required(env, "EMBEDDINGS_MODEL_NAME"),
      embeddingDimension: positiveInteger(env, "EMBEDDING_DIMENSION", 1024),
    },
    milvus: {
      address: required(env, "MILVUS_ADDRESS"),
      token: env.MILVUS_TOKEN?.trim() || undefined,
      collectionName: env.MILVUS_BOOK_COLLECTION?.trim() || "ebook_collection",
      bookId: env.MILVUS_BOOK_ID?.trim() || "1",
      nprobe: positiveInteger(env, "MILVUS_NPROBE", 16),
    },
    rag: {
      bookName: env.BOOK_NAME?.trim() || "天龙八部",
      retrievalK: positiveInteger(env, "RETRIEVAL_K", 8),
      maxRetrievals: positiveInteger(env, "MAX_RETRIEVALS", 8),
      maxContextDocuments: positiveInteger(env, "MAX_CONTEXT_DOCUMENTS", 24),
    },
    webSearch: {
      enabled: booleanValue(env, "ENABLE_WEB_SEARCH", false) && Boolean(bochaApiKey),
      apiKey: bochaApiKey,
      url: env.BOCHA_SEARCH_URL?.trim() || "https://api.bochaai.com/v1/web-search",
      maxSearches: positiveInteger(env, "MAX_WEB_SEARCHES", 2),
    },
  };
}
