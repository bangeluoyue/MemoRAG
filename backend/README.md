# MemoRAG Backend

后端提供两个独立 RAG 服务、EPUB 入库、生活笔记 CRUD/双索引同步，以及基于 Node 内置 HTTP Server 的演示 API。

## 当前问答架构

### EPUB Agentic RAG

默认入口为 `createEbookRag().ask(question, { bookId })`：

```text
routeQuestion
  ├─ direct → directAnswer
  ├─ single_retrieval → retrieve
  └─ multi_hop → decomposeQuestion → retrieve

retrieve → decision
  ├─ retrieve（仍有计划项和预算）
  ├─ webSearch（显式启用且仍有预算）
  └─ generate

webSearch → generate
```

- EPUB 只使用 Milvus 向量检索，不创建 Elasticsearch 索引。
- 检索强制使用 `knowledgeBase=ebook + bookId` 范围。
- 多跳计划最多执行 `MAX_SUB_QUESTIONS` 项，并受 `MAX_RETRIEVALS` 硬上限限制。
- 依赖实体未确认的子问题不会把占位符或模型猜测的实体交给 Retriever，而是回退到原始完整问题。
- 默认轻量决策只返回 `retrieve / web_search / generate`。`DECISION_TIMEOUT_MS` 默认 15000 ms；超时或格式异常时不重试，而是按剩余预算安全回退。这个等待上限不代表模型端点的延迟问题已经解决。
- 当前复杂 coverage/evaluate/依赖改写 Graph 保留在 `src/rag/ebook/agent-graph.js`，但不是默认入口。

### 生活笔记 Hybrid RAG

默认入口为 `createNotesRag().ask(question, { userId })`：

```text
ES 关键词检索 ─┐
                ├─ 并行召回 → note_id 去重 → RRF → 可选 Rerank → 一次生成
Milvus 向量检索 ┘
```

- ES 和 Milvus 查询均强制 `knowledgeBase=life_notes + userId`，返回后再次校验。
- `ENABLE_NOTE_RERANK=false` 时只使用 RRF；启用后成功、失败回退状态都会出现在 `route.reason` 和 `trace.retrievals[].rerank`。
- NotesRag 不创建 LangGraph、不拆题、不联网，也不初始化 Bocha。
- 检索为空时直接返回资料不足，不调用生成模型。

两条路径均返回兼容的 `answer`、`route`、`sources`、`webSources` 和 `trace`，来源只来自本次实际召回快照。

## 目录

- `src/rag/ebook/core-agent-graph.js`：默认 EPUB 核心 Agent Graph。
- `src/rag/ebook/agent-graph.js`：非默认的历史复杂 Graph。
- `src/rag/ebook/ingestion/`：EPUB 解析、分块、稳定 ID、Schema 检查和批量写入。
- `src/rag/notes/`：ES/Milvus Retriever、RRF、Rerank 和 NotesRag 编排。
- `src/notes/`：PostgreSQL Repository、CRUD、双索引同步和 retry。
- `src/http/`：HTTP 服务与安全错误映射。
- `src/observability/`：默认关闭的 LangSmith 追踪。
- `sql/001_create_life_notes.sql`：生活笔记最小表结构；不会自动执行。

## 配置

复制 `.env.example` 为本地 `.env`，不要提交真实值。主要变量：

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=
MODEL_NAME=
EMBEDDINGS_MODEL_NAME=
EMBEDDING_DIMENSION=1024

MILVUS_ADDRESS=
MILVUS_BOOK_COLLECTION=ebook_collection
MILVUS_BOOK_ID=1

LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=0
AGENT_TIMEOUT_MS=120000
DECISION_TIMEOUT_MS=15000

ENABLE_WEB_SEARCH=false
BOCHA_API_KEY=
MAX_WEB_SEARCHES=2

ENABLE_RERANK=false
ENABLE_NOTE_RERANK=false
RERANK_FAILURE_MODE=fallback

LANGSMITH_TRACING=false
MEMORAG_LANGSMITH_CONTENT_MODE=metadata_only
```

生活笔记还需要 `DATABASE_URL`、`ELASTICSEARCH_NODE`、`ELASTICSEARCH_NOTES_INDEX` 和 `MILVUS_NOTES_COLLECTION`。`userId` 只用于演示范围隔离，不能替代身份认证。

## 命令

```bash
npm test
npm start
npm run chat -- "问题"
npm run inspect:milvus

# 默认 dry-run，不调用 Embedding 或写 Milvus
npm run ingest:epub -- ./book.epub --book-id demo-book

# 默认 dry-run，不连接三处存储
npm run notes -- create --user-id demo-user --content "演示笔记"
```

只有在明确授权真实写入后才能对入库或笔记命令增加 `--execute`。入库工具不会删除、重建或覆盖现有 EPUB Collection；禁止直接运行旧课程脚本中的 `dropCollection` 或 seed 逻辑。

## HTTP API

服务默认只监听 `127.0.0.1:3000`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 进程健康检查 |
| `POST` | `/api/qa/ebook` | EPUB 问答，需 `question/bookId` |
| `POST` | `/api/qa/notes` | 笔记问答，需 `question/userId` |
| `POST` | `/api/notes` | 新增笔记 |
| `GET` | `/api/notes` | 列出笔记 |
| `GET` | `/api/notes/:noteId` | 笔记详情 |
| `PATCH` | `/api/notes/:noteId` | 修改笔记并同步索引 |
| `DELETE` | `/api/notes/:noteId` | 删除笔记并清理索引 |
| `POST` | `/api/notes/:noteId/retry` | 重试索引同步 |

模型超时返回安全的 `MODEL_TIMEOUT`/HTTP 504，并保留 `stage` 与 `timeoutSource`；其他认证、限流和连接错误不会被误判为模型超时。API 不返回密钥、连接字符串、完整 Prompt 或上游原始异常。

## 未验证边界

本次精简仅使用 Mock 验证。真实 EPUB 路由/轻量决策、Bocha、Notes Rerank 质量及精简后浏览器全链路均需另行授权做最少量验收。15 秒决策超时只是等待控制和安全降级，不是模型服务稳定性修复。
