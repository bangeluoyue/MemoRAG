# MemoRAG backend — EPUB Agentic RAG

第一阶段只包含电子书只读检索、LangGraph Agent 和终端问答。它不会创建、删除、重建或写入 Milvus Collection。

## 模块

- `src/config.js`：集中读取和校验环境变量。
- `src/rag/ebook/milvus-retriever.js`：只读 Milvus 检查与向量检索。
- `src/rag/ebook/agent-graph.js`：路由、拆题、依赖型子问题改写、检索、充分性评估、可选联网和回答生成。
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
