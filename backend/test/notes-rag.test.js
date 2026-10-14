import test from "node:test";
import assert from "node:assert/strict";
import { createNotesRag } from "../src/rag/notes/agent.js";

class NotesAgentModel {
  withStructuredOutput(schema) {
    const keys = Object.keys(schema.shape);
    if (keys.includes("mode")) {
      return {
        invoke: async () => ({
          mode: "single_retrieval",
          reason: "一个生活笔记检索问题即可回答",
        }),
      };
    }
    return {
      invoke: async () => ({
        isSufficient: true,
        coverage: [{
          planIndex: 1,
          hasRelevantEvidence: true,
          isSufficient: true,
          hasConflictingEvidence: false,
          supportingEvidenceIndexes: [1],
          missing: "",
          reason: "笔记直接记录了答案",
        }],
        nextAction: "generate",
        missing: [],
        nextPlanItemAddressesGap: false,
        reason: "证据充分",
      }),
    };
  }

  async invoke() {
    return { content: "体检安排在周五上午 [本地1]。" };
  }
}

function config() {
  return {
    model: {
      apiKey: "test-key",
      baseUrl: undefined,
      chatModel: "test-chat",
      embeddingModel: "test-embedding",
      embeddingDimension: 2,
    },
    milvus: { address: "localhost:19530", nprobe: 8 },
    notes: {
      knowledgeBase: "life_notes",
      keywordK: 5,
      vectorK: 5,
      rerankEnabled: false,
    },
    rag: {
      retrievalK: 4,
      maxRetrievals: 4,
      maxContextDocuments: 8,
      maxSubQuestions: 4,
      maxPlanRepairAttempts: 1,
      maxSingleRetrievals: 2,
      maxGapRecoveryAttempts: 1,
    },
    rerank: { topN: 4 },
    webSearch: { enabled: false, maxSearches: 2 },
    langsmith: {
      requested: false,
      enabled: false,
      noteTracingEnabled: false,
      contentMode: "metadata_only",
    },
  };
}

test("createNotesRag reuses the Agent graph with a strict life-notes scope", async () => {
  const calls = [];
  const rag = createNotesRag({
    config: config(),
    model: new NotesAgentModel(),
    retriever: {
      async searchWithTrace(query, options) {
        calls.push({ query, options });
        return {
          documents: [
            {
              id: "cross-scope-note",
              knowledgeBase: "life_notes",
              userId: "other-user",
              content: "其他用户的笔记不得进入 Agent。",
              metadata: { title: "越权数据" },
              scores: { fusion: 0.05 },
            },
            {
              id: "note-1",
              knowledgeBase: "life_notes",
              userId: "user-1",
              content: "体检安排在周五上午。",
              metadata: { title: "体检安排" },
              scores: {
                keyword: 3.5,
                vector: 0.88,
                fusion: 0.032,
                rerank: null,
              },
              provenance: [{ source: "elasticsearch", rank: 1 }],
            },
          ],
          trace: {
            status: "success",
            totalDurationMs: 7,
            rerank: { enabled: false, status: "disabled" },
          },
        };
      },
    },
  });

  try {
    const result = await rag.ask("我的体检安排在什么时候？", {
      userId: "user-1",
    });

    assert.equal(result.answer, "体检安排在周五上午 [本地1]。");
    assert.equal(result.route.mode, "single_retrieval");
    assert.equal(result.sources[0].reference, "本地1");
    assert.equal(result.sources[0].noteId, "note-1");
    assert.equal(result.sources[0].title, "体检安排");
    assert.equal(result.sources[0].knowledgeBase, "life_notes");
    assert.equal(result.sources[0].userId, "user-1");
    assert.equal(result.sources.some((source) => source.id === "cross-scope-note"), false);
    assert.equal(result.trace.retrievalCount, 1);
    assert.equal(result.trace.retrievals[0].timing.totalDurationMs, 7);
    assert.deepEqual(calls, [{
      query: "我的体检安排在什么时候？",
      options: {
        k: 4,
        scope: { knowledgeBase: "life_notes", userId: "user-1" },
      },
    }]);
  } finally {
    await rag.close();
  }
});

test("createNotesRag requires userId before invoking the Agent", async () => {
  const rag = createNotesRag({
    config: config(),
    model: new NotesAgentModel(),
    retriever: { async search() { return []; } },
  });
  try {
    await assert.rejects(
      () => rag.ask("测试问题"),
      /scope\.userId 不能为空/u,
    );
  } finally {
    await rag.close();
  }
});
