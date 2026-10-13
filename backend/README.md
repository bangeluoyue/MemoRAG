# MemoRAG backend — EPUB Agentic RAG

第一阶段只包含电子书只读检索、LangGraph Agent 和终端问答。它不会创建、删除、重建或写入 Milvus Collection。

## 模块

- `src/config.js`：集中读取和校验环境变量。
- `src/rag/ebook/milvus-retriever.js`：只读 Milvus 检查与向量检索。
- `src/rag/ebook/agent-graph.js`：三态路由、受控单跳检索、有界多跳计划、依赖型子问题改写、充分性评估、可选联网和回答生成。
- `src/rag/ebook/reranking-retriever.js`：可选扩大 Milvus 候选集，并使用 Qwen Rerank 重排。
- `src/rag/shared/dashscope-reranker.js`：无副作用的 DashScope/Qwen Rerank HTTP 客户端。
- `src/rag/ebook/index.js`：可被其他 Node.js 代码调用的 RAG 入口。
- `src/cli/chat.js`：交互式或单次终端问答。
- `src/cli/inspect-milvus.js`：只读显示 Collection Schema、行数、加载状态和索引。

## 使用

在 `backend/` 目录中执行：

```bash
npm install
npm test
npm run inspect:milvus
npm run chat
npm run chat -- "雁门关事件的主谋是谁？"
```

复制 `.env.example` 中需要的变量名到本地 `.env`。核心变量为：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `MODEL_NAME`
- `EMBEDDINGS_MODEL_NAME`
- `MILVUS_ADDRESS`
- `MILVUS_BOOK_COLLECTION`，默认 `ebook_collection`
- `MILVUS_BOOK_ID`，默认 `1`
- `EMBEDDING_DIMENSION`，现有集合为 `1024`

`ENABLE_WEB_SEARCH` 默认为 `false`。只有显式启用且配置 `BOCHA_API_KEY` 后，信息充分性评估节点才可以选择联网搜索。

Agent 内部路由分为 `direct`、`single_retrieval` 和 `multi_hop`。书中单一人物、事件或动机问题优先走单跳路径，不执行拆题和改写；首轮证据不足时最多按 `MAX_SINGLE_RETRIEVALS` 的预算补充本地检索（默认总计 2 次），也可在已启用联网时受 `MAX_WEB_SEARCHES` 限制回退。多跳路径默认最多生成 `MAX_SUB_QUESTIONS=4` 个必要计划项；非法计划最多按 `MAX_PLAN_REPAIR_ATTEMPTS=1` 修复一次，仍失败则回退到原始问题。

`MAX_CONTEXT_DOCUMENTS` 默认 12。充分性评估只接收排序前 6 条、每条最多 600 字符的紧凑视图；最终回答和引用仍使用同一份完整引用快照。`route.strategy` 保持 `simple|complex` 兼容，并新增 `route.mode`。`trace.execution` 记录请求内节点耗时、LLM 调用数、本地检索数、Rerank 请求/回退数、联网数和最终上下文文档数，不包含 prompt、正文或凭证。

`ENABLE_RERANK` 默认为 `false`，关闭时保持原有 Milvus 检索行为且不会发起 Rerank 请求。启用时必须配置 `RERANK_URL`；Key 按 `RERANK_API_KEY`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY` 的顺序选择。`RERANK_CANDIDATE_K` 控制初始候选数，`RERANK_TOP_N` 控制默认最终文档数，而单次调用的 `askOptions.k` 优先。失败策略默认为 `RERANK_FAILURE_MODE=fallback`，会退回 Milvus 顺序；也可设为 `error` 直接抛错。

Rerank 会保留原始 `score`，并在来源对象中附加 `rerankScore`、`originalRank`、`rerankRank`、`rerankStatus` 等元数据。多轮检索按 reciprocal rank fusion 合并；重排结果不会再被原始向量分数重新排序。当前测试只覆盖 Mock 协议和排序逻辑，尚未验证真实 Rerank 端点或排序质量。

模块调用示例：

```js
import { createEbookRag } from "./src/rag/ebook/index.js";

const rag = createEbookRag();
try {
  const result = await rag.ask("萧峰的身世是什么？");
  console.log(result.answer);
  console.log(result.sources);
  console.log(result.trace.rewriteHistory);
  console.log(result.trace.execution);
} finally {
  await rag.close();
}
```
