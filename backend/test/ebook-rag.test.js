import test from "node:test";
import assert from "node:assert/strict";
import { createEbookRag } from "../src/rag/ebook/index.js";

class ApiTestModel {
  constructor() {
    this.evaluations = ["retrieve", "generate"];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("strategy")) {
      return { invoke: async () => ({ strategy: "complex", reason: "需要查书" }) };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => ({
          sub_questions: ["误杀阿朱的人是谁？", "他后来经历了什么？"],
          reason: "依赖问题",
        }),
      };
    }
    if (keys.includes("needsRewrite")) {
      return {
        invoke: async () => ({
          needsRewrite: true,
          rewrittenQuery: "萧峰后来经历了什么？",
          resolvedEntities: ["萧峰"],
          supportingDocumentIds: ["doc-1"],
          hasConflictingEvidence: false,
          reason: "前序原文确认人物为萧峰",
        }),
      };
    }
    return {
      invoke: async () => ({
        nextAction: this.evaluations.shift(),
        missing: [],
        reason: "测试评估",
      }),
    };
  }

  async invoke() {
    return { content: "最终回答 [本地1]" };
  }
}

class CitationCorrectionModel {
  constructor() {
    this.prompts = [];
    this.answers = [
      "人物甲在第十四章完成了任务 [本地15]。",
      "人物甲在第十四章完成了任务 [本地14]。",
    ];
  }

  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("strategy")) {
      return { invoke: async () => ({ strategy: "complex", reason: "需要查书" }) };
    }
    if (keys.includes("sub_questions")) {
      return {
        invoke: async () => ({
          sub_questions: ["测试十四条来源"],
          reason: "单次检索",
        }),
      };
    }
    return {
      invoke: async () => ({
        nextAction: "generate",
        missing: [],
        reason: "资料充分",
      }),
    };
  }

  async invoke(prompt) {
    this.prompts.push(prompt);
    return { content: this.answers.shift() };
  }
}

function createTestConfig() {
  return {
    model: {
      apiKey: "test-key",
      baseUrl: undefined,
      chatModel: "test-chat",
      embeddingModel: "test-embedding",
      embeddingDimension: 2,
    },
    milvus: {
      address: "localhost:19530",
      token: undefined,
      collectionName: "ebook_collection",
      bookId: "1",
      nprobe: 8,
    },
    rag: {
      bookName: "天龙八部",
      retrievalK: 5,
      maxRetrievals: 4,
      maxContextDocuments: 8,
    },
    webSearch: {
      enabled: false,
      apiKey: "",
      url: "https://example.com",
      maxSearches: 2,
    },
  };
}

test("createEbookRag().ask() keeps its API and exposes rewrite trace", async () => {
  const queries = [];
  const rag = createEbookRag({
    config: createTestConfig(),
    model: new ApiTestModel(),
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search(query) {
        queries.push(query);
        return [{
          id: queries.length === 1 ? "doc-1" : "doc-2",
          score: 0.9,
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: 1,
          chunkIndex: queries.length - 1,
          content: queries.length === 1
            ? "误杀阿朱的人是萧峰。"
            : "萧峰后来经历了聚贤庄大战。",
        }];
      },
    },
  });

  const result = await rag.ask("误杀阿朱的人是谁？他后来经历了什么？");

  assert.equal(result.answer, "最终回答 [本地1]");
  assert.equal(result.route.strategy, "complex");
  assert.equal(result.sources.length, 2);
  assert.deepEqual(queries, ["误杀阿朱的人是谁？", "萧峰后来经历了什么？"]);
  assert.equal(result.trace.rewriteHistory[1].rewriteApplied, true);
  assert.equal(result.trace.retrievals[1].query, "萧峰后来经历了什么？");
  assert.equal(result.trace.retrievals[1].documentIds[0], "doc-2");
});

test("createEbookRag corrects local reference 15 when only 14 sources exist", async () => {
  const config = createTestConfig();
  config.rag.maxContextDocuments = 14;
  const model = new CitationCorrectionModel();
  const rag = createEbookRag({
    config,
    model,
    embeddings: {},
    milvusClient: {},
    retriever: {
      async search() {
        return Array.from({ length: 14 }, (_, index) => ({
          id: `doc-${index + 1}`,
          score: 1 - (index * 0.01),
          bookId: "1",
          bookName: "天龙八部",
          chapterNum: index + 1,
          chunkIndex: 0,
          content: index === 13
            ? "第十四章原文：人物甲在这一章完成了任务。"
            : `第 ${index + 1} 条测试片段`,
        }));
      },
    },
  });

  const result = await rag.ask("测试十四条来源");

  assert.equal(result.sources.length, 14);
  assert.equal(result.sources[13].reference, "本地14");
  assert.equal(result.sources[13].id, "doc-14");
  assert.equal(result.answer, "人物甲在第十四章完成了任务 [本地14]。");
  assert.doesNotMatch(result.answer, /\[本地15\]/);
  assert.equal(model.prompts.length, 2);
  assert.match(model.prompts[1], /\[本地14\][\s\S]*人物甲在这一章完成了任务/);
  assert.equal(result.trace.citationValidation.status, "corrected");
  assert.equal(result.trace.citationValidation.localSourceCount, 14);
  assert.deepEqual(
    result.trace.citationValidation.initialInvalidReferences,
    ["[本地15]"],
  );
  assert.deepEqual(result.trace.citationValidation.finalInvalidReferences, []);
  assert.equal(result.trace.citationValidation.correctionAttempts, 1);
  assert.equal(result.trace.citationValidation.contentSupportChecked, false);
});
