export class RerankError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RerankError";
    this.code = code;
  }
}

function documentText(document) {
  return String(document?.content ?? document?.pageContent ?? "");
}

function validateResults(payload, documentCount, maximumResults) {
  if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) {
    throw new RerankError("RERANK_INVALID_RESPONSE", "Rerank 响应缺少 results 数组");
  }
  if (payload.results.length > maximumResults) {
    throw new RerankError("RERANK_INVALID_RESPONSE", "Rerank 响应返回了过多结果");
  }

  const seenIndices = new Set();
  return payload.results.map((result, rankIndex) => {
    const index = Number(result?.index);
    const score = Number(result?.relevance_score);
    if (!Number.isInteger(index) || index < 0 || index >= documentCount) {
      throw new RerankError("RERANK_INVALID_RESPONSE", "Rerank 响应包含越界文档索引");
    }
    if (seenIndices.has(index)) {
      throw new RerankError("RERANK_INVALID_RESPONSE", "Rerank 响应包含重复文档索引");
    }
    if (!Number.isFinite(score)) {
      throw new RerankError("RERANK_INVALID_RESPONSE", "Rerank 响应包含无效相关性分数");
    }
    seenIndices.add(index);
    return { index, score, rank: rankIndex + 1 };
  });
}

export class DashScopeReranker {
  constructor({
    apiKey,
    model = "qwen3-rerank",
    baseUrl,
    timeoutMs = 10000,
    fetchImpl = globalThis.fetch,
  }) {
    if (!apiKey) throw new RerankError("RERANK_CONFIG_ERROR", "Rerank API Key 未配置");
    if (!baseUrl) throw new RerankError("RERANK_CONFIG_ERROR", "Rerank URL 未配置");
    if (typeof fetchImpl !== "function") {
      throw new RerankError("RERANK_CONFIG_ERROR", "当前环境不支持 fetch");
    }

    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async rerank(query, documents, { topN = documents.length } = {}) {
    if (!documents.length || topN <= 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: documents.map(documentText),
          top_n: Math.min(topN, documents.length),
        }),
        signal: controller.signal,
      });

      if (!response?.ok) {
        throw new RerankError(
          "RERANK_HTTP_ERROR",
          `Rerank 服务返回非成功状态（HTTP ${response?.status ?? "unknown"}）`,
        );
      }

      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new RerankError("RERANK_INVALID_JSON", "Rerank 响应不是有效 JSON", {
          cause: error,
        });
      }
      return validateResults(payload, documents.length, Math.min(topN, documents.length));
    } catch (error) {
      if (error instanceof RerankError) throw error;
      if (error?.name === "AbortError" || controller.signal.aborted) {
        throw new RerankError("RERANK_TIMEOUT", "Rerank 请求超时", { cause: error });
      }
      throw new RerankError("RERANK_NETWORK_ERROR", "Rerank 请求失败", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}
