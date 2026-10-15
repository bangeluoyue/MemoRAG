# MemoRAG Backend

后端提供两个独立 RAG 服务、EPUB 入库、生活笔记 CRUD/双索引同步，以及基于 Node 内置 HTTP Server 的演示 API。HTTP API 使用两个固定账号和 PostgreSQL 持久化的 HttpOnly Cookie 会话。

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
- 路由与轻量决策的 `reason` 仅用于流程选择和 trace，不作为事实证据传给最终生成；生成只接收原始问题、实际检索片段和可选网页证据，并要求核对人物关系、行为主客体及“人物认知/客观事实”的区别。
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
- `src/auth/`：固定账号初始化、scrypt 密码哈希、会话摘要与权限检查。
- `src/rag/ebook/library-service.js`：Milvus 书名查询和管理员上传适配。
- `src/observability/`：默认关闭的 LangSmith 追踪。
- `sql/001_create_life_notes.sql`：生活笔记最小表结构；不会自动执行。
- `sql/002_create_auth.sql`：固定账号及会话表；不会自动执行或改写生活笔记数据。

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

DATABASE_URL=
ADMIN_INITIAL_PASSWORD=
SESSION_SECRET=
AUTH_COOKIE_SECURE=
EPUB_UPLOAD_MAX_BYTES=26214400

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

生活笔记还需要 `DATABASE_URL`、`ELASTICSEARCH_NODE`、`ELASTICSEARCH_NOTES_INDEX` 和 `MILVUS_NOTES_COLLECTION`。`SESSION_SECRET` 至少 32 字符；`ADMIN_INITIAL_PASSWORD` 只在管理员尚不存在时使用，服务启动不会覆盖之后修改的密码。生产环境默认使用 Secure Cookie，也可通过 `AUTH_COOKIE_SECURE` 显式配置。

首次启用登录前手动执行最小 migration（本项目不会自动执行）：

```bash
psql "$DATABASE_URL" -f sql/002_create_auth.sql
```

固定管理员账号为 `18296262260@163.com`，其初始密码只从 `ADMIN_INITIAL_PASSWORD` 读取，文档和代码不提供默认值。固定测试员账号为 `test@123.com`，初始密码为需求约定的 `123456`；建议管理员首次登录后立即修改。生活笔记的内部范围固定映射为 `account-admin` / `account-tester`，后端忽略客户端提交的 `userId`。旧 `userId` 下的历史笔记不会被删除或自动迁移，也不会自动显示在两个账号的新个人空间中。

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

EPUB 入库的 Embedding 批次默认且最多为 10 条，与 `text-embedding-v3` 的同步接口限制一致；更大的 `--batch-size` 会在调用上游前被拒绝。

## HTTP API

服务默认只监听 `127.0.0.1:3000`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 进程健康检查 |
| `POST` | `/api/auth/login` | 固定账号登录并设置 HttpOnly Cookie |
| `GET` | `/api/auth/me` | 恢复当前会话 |
| `POST` | `/api/auth/logout` | 删除当前会话并清除 Cookie |
| `PATCH` | `/api/admin/tester-password` | 管理员修改测试员密码 |
| `GET` | `/api/ebooks/:bookId` | 从 Milvus 精确查询书名 |
| `POST` | `/api/ebooks/upload` | 管理员上传并入库 EPUB |
| `POST` | `/api/qa/ebook` | EPUB 问答，需 `question/bookId` |
| `POST` | `/api/qa/notes` | 当前登录账号的笔记问答，只需 `question` |
| `POST` | `/api/notes` | 新增笔记 |
| `GET` | `/api/notes` | 列出笔记 |
| `GET` | `/api/notes/:noteId` | 笔记详情 |
| `PATCH` | `/api/notes/:noteId` | 修改笔记并同步索引 |
| `DELETE` | `/api/notes/:noteId` | 删除笔记并清理索引 |
| `POST` | `/api/notes/:noteId/retry` | 重试索引同步 |

模型超时返回安全的 `MODEL_TIMEOUT`/HTTP 504，并保留 `stage` 与 `timeoutSource`；其他认证、限流和连接错误不会被误判为模型超时。API 不返回密钥、连接字符串、完整 Prompt 或上游原始异常。

除 `/health` 和登录所需接口外，业务接口均校验服务端会话。上传只接受 multipart 中的 `.epub` 文件，限制大小并校验 ZIP 特征；服务按文件 SHA-256 摘要生成稳定 `bookId`，调用现有 `resume` 入库策略，仅向现有兼容 Collection 追加缺失分块，不提供删除、重建、覆盖或服务器路径参数。

## 验收边界

Notes Hybrid RAG 已在本机以两条非敏感临时笔记完成真实 HTTP 验收：PostgreSQL/ES/Milvus 同步、ES+Milvus 双源召回、RRF、一次生成、引用和精确清理均通过。Rerank 在该次验收中保持关闭。

EPUB 生成证据边界和中间 reason 隔离已有 Mock 覆盖；人物关系与认知状态的通用 Prompt 约束尚未重复真实 E2，因此不能宣称已消除模型幻觉。真实 Bocha、Notes Rerank、EPUB 多跳质量及精简后完整浏览器链路仍需按需做最少量验收。15 秒决策超时只是等待控制和安全降级，不是模型服务稳定性修复。
