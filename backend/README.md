# MemoRAG backend — EPUB Agentic RAG

第一阶段只包含电子书只读检索、LangGraph Agent 和终端问答。它不会创建、删除、重建或写入 Milvus Collection。

## 模块

- `src/config.js`：集中读取和校验环境变量。
- `src/rag/ebook/milvus-retriever.js`：只读 Milvus 检查与向量检索。
- `src/rag/ebook/agent-graph.js`：路由、拆题、依赖型子问题改写、检索、充分性评估、可选联网和回答生成。
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
} finally {
  await rag.close();
}
```
