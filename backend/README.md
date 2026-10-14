# MemoRAG backend — EPUB Agentic RAG 与生活笔记存储/检索

当前包含 EPUB 检索、入库 CLI/Service、LangGraph Agent 和终端问答，以及生活笔记 PostgreSQL CRUD、Elasticsearch + Milvus 双索引同步/混合检索和最小 Node HTTP API。EPUB 入库只向已存在且 Schema 兼容的 Collection 执行 `insert`；生活笔记 migration 和真实 CRUD 都不会被测试或默认 CLI 自动执行。

## 模块

- `src/config.js`：集中读取和校验环境变量。
- `src/observability/langsmith.js`：默认关闭、内容边界明确的 LangSmith Graph 追踪适配层。
- `src/rag/ebook/milvus-retriever.js`：只读 Milvus 检查与向量检索。
- `src/rag/ebook/agent-graph.js`：LangGraph 配置归一化、节点装配、条件边和兼容导出。
- `src/rag/ebook/nodes/`、`services/`：三态路由、受控检索、依赖改写、证据覆盖、生成、引用等节点与纯逻辑。
- `src/rag/ebook/reranking-retriever.js`：可选扩大 Milvus 候选集，并使用 Qwen Rerank 重排。
- `src/rag/shared/dashscope-reranker.js`：无副作用的 DashScope/Qwen Rerank HTTP 客户端。
- `src/rag/retrieval/`：统一检索 scope、标准文档和 RRF 融合约定。
- `src/rag/ebook/ebook-retriever.js`：EPUB Milvus/可选 Rerank 的通用接口兼容适配层。
- `src/rag/ebook/ingestion/`：EPUB 解析、章节分块、稳定 ID、Collection Schema 校验、重复检查和批量入库。
- `src/rag/notes/`：生活笔记 ES 关键词、Milvus 向量、RRF、可选 Rerank 和共享 LangGraph 的问答入口。
- `src/rag/shared/agent-response.js`：两类知识库共用的 Agent 返回值和执行 trace 映射。
- `src/notes/`：生活笔记 PostgreSQL Repository、CRUD Service、ES/Milvus 索引同步和显式重试。
- `src/http/`：Node 内置 HTTP Server、双知识库问答和笔记 CRUD 路由。
- `src/rag/ebook/index.js`：可被其他 Node.js 代码调用的 RAG 入口。
- `src/cli/chat.js`：交互式或单次终端问答。
- `src/cli/inspect-milvus.js`：只读显示 Collection Schema、行数、加载状态和索引。
- `src/cli/ingest-epub.js`：默认 dry-run 的 EPUB 入库命令。
- `src/cli/notes.js`：默认 dry-run 的生活笔记 CRUD/索引重试命令。
- `sql/001_create_life_notes.sql`：需单独授权执行的最小 PostgreSQL 表结构。

## 使用

在 `backend/` 目录中执行：

```bash
npm install
npm test
npm run inspect:milvus
npm run ingest:epub -- ./book.epub --book-id demo-book
npm run notes -- create --user-id demo-user --content "演示笔记"
npm run chat
npm run chat -- "雁门关事件的主谋是谁？"
npm start
```

复制 `.env.example` 中需要的变量名到本地 `.env`。核心变量为：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `MODEL_NAME`
- `EMBEDDINGS_MODEL_NAME`
- `LLM_TIMEOUT_MS`，单次 LLM 调用上限，默认 `60000`
- `LLM_MAX_RETRIES`，LLM SDK 自动重试次数，默认 `0`
- `MILVUS_ADDRESS`
- `MILVUS_BOOK_COLLECTION`，默认 `ebook_collection`
- `MILVUS_BOOK_ID`，默认 `1`
- `EMBEDDING_DIMENSION`，现有集合为 `1024`

整次问答另受 `AGENT_TIMEOUT_MS` 限制，默认 `120000`。路由、拆题、改写、评估、生成和引用纠正都使用同一单次 LLM 上限；拆题或改写超时会沿用既有安全回退，路由、评估、首次生成或整次 Agent 超时则由 HTTP API 返回不含内部响应的 `504`，并通过 `error.stage` 标明超时阶段。`error.timeoutSource` 区分 MemoRAG 应用计时器触发的 `application` 与 SDK/上游提前报告的 `sdk_or_upstream`；`timeoutMs` 始终表示当前配置的应用上限，不代表上游实际采用的时限。该机制用于终止不可控等待，不会放宽证据充分性规则或增加检索预算。

生活笔记使用 `DATABASE_URL`、`DATABASE_SSL`、`ELASTICSEARCH_NODE`、`ELASTICSEARCH_NOTES_INDEX`、`MILVUS_NOTES_COLLECTION`、`NOTES_KEYWORD_K` 和 `NOTES_VECTOR_K`。这些默认值只是开发配置；仓库不声称真实表、索引、mapping 或 Collection Schema 已存在。

## HTTP API

`npm start` 默认只监听 `127.0.0.1:3000`，可通过 `HTTP_HOST` 和 `HTTP_PORT` 显式调整。当前提供以下 JSON 接口：

| 方法 | 路径 | 必要范围/用途 |
| --- | --- | --- |
| `GET` | `/health` | 进程存活检查；不主动探测外部依赖 |
| `POST` | `/api/qa/ebook` | EPUB 问答；请求需包含 `question`、`bookId` |
| `POST` | `/api/qa/notes` | 生活笔记问答；请求需包含 `question`、`userId` |
| `POST` | `/api/notes` | 新增笔记；请求需包含 `userId`、`content`，`title` 可选 |
| `GET` | `/api/notes?userId=...&limit=...` | 按用户列出笔记 |
| `GET` | `/api/notes/:noteId?userId=...` | 查询单条笔记 |
| `PATCH` | `/api/notes/:noteId` | 修改笔记；JSON 请求体包含 `userId` 和需修改字段 |
| `DELETE` | `/api/notes/:noteId?userId=...` | 删除笔记并同步清理索引 |
| `POST` | `/api/notes/:noteId/retry` | 重试同步；JSON 请求体包含 `userId` |

问答成功响应保持 `answer`、`sources`、`webSources`、`route` 和 `trace`；其中 `trace.execution` 提供演示所需的节点、LLM、检索与 Rerank 次数。EPUB API 强制使用 `ebook + bookId` 范围，生活笔记 API 强制使用 `life_notes + userId` 范围，传入不匹配的 `knowledgeBase` 会被拒绝。

`userId` 目前只是数据库和检索层的范围过滤参数，调用方可以自行填写，**不能替代身份认证或授权**。服务默认只监听本机正是为了限制这一演示阶段的暴露面；对外部署前必须增加可信身份层，并由服务端绑定 `userId`。未知内部异常只返回通用错误，不把数据库响应、连接信息或密钥发送给客户端。

## EPUB 入库

先执行默认 dry-run，它只读取本地 EPUB、按 spine 提取章节并分块，不调用 Embedding，不连接 Milvus：

```bash
npm run ingest:epub -- ./book.epub --book-id demo-book
```

检查输出的书名、章节数和分块数后，仅在获得真实 Embedding/Milvus 写入授权后使用：

```bash
npm run ingest:epub -- ./book.epub \
  --book-id demo-book \
  --book-name "Demo Book" \
  --execute
```

默认分块为 500 字符、50 字符重叠，Embedding/insert 批次为 20；可用 `--chunk-size`、`--chunk-overlap` 和 `--batch-size` 调整。写入字段为 `id/book_id/book_name/chapter_num/index/content/vector`，与 `MilvusBookRetriever` 直接兼容，向量维度必须与 `EMBEDDING_DIMENSION` 和既有 Collection Schema 同时一致。Collection 必须事先存在并可用；工具不自动创建、加载或修改它。

分块 ID 基于 `bookId + chapterNum + chunkIndex + content` 的 SHA-256 稳定生成。完整重复导入默认跳过；部分导入默认报错，可在确认是同一分块版本后使用 `--on-duplicate resume` 只补齐缺失 ID。如已存在不同 ID 集合，则视为图书版本冲突并停止；不提供 replace/upsert/delete 模式。

`ENABLE_WEB_SEARCH` 默认为 `false`。只有显式启用且配置 `BOCHA_API_KEY` 后，信息充分性评估节点才可以选择联网搜索。

Agent 内部路由分为 `direct`、`single_retrieval` 和 `multi_hop`。书中单一人物、事件或动机问题优先走单跳路径，不执行拆题和改写；首轮证据不足时最多按 `MAX_SINGLE_RETRIEVALS` 的预算补充本地检索（默认总计 2 次），也可在已启用联网时受 `MAX_WEB_SEARCHES` 限制回退。多跳路径默认最多生成 `MAX_SUB_QUESTIONS=4` 个必要计划项；非法计划最多按 `MAX_PLAN_REPAIR_ATTEMPTS=1` 修复一次，仍失败则回退到原始问题。依赖型改写只接受当前请求证据快照内的连续序号；改写失败时使用原始完整问题安全回退，内部“第 N 项人物”等占位表达不会进入 Retriever。

`MAX_CONTEXT_DOCUMENTS` 默认 12。充分性评估从各检索轮次平衡选取最多 6 条、每条最多 600 字符的证据，并逐计划项分别记录“是否检索、是否存在相关证据、是否足以支持答案”。计划执行完仍有缺口时，`MAX_GAP_RECOVERY_ATTEMPTS` 允许 0～1 次定向恢复（默认 1），且不会突破 `MAX_RETRIEVALS` 或单跳预算。预算耗尽后允许保留未解决项；生成器只接收 coverage 判定为充分的本地证据，并明确说明其余部分无法确认。

coverage 是受限证据快照上的相关性/充分性判断，不是完整的事实蕴含证明，`contentSupportChecked` 仍为 `false`。`route.strategy` 保持 `simple|complex` 兼容，并新增 `route.mode`。`trace.coverage`、`trace.retrievals` 和 `trace.execution` 记录覆盖状态、实际查询、回退原因、节点耗时、LLM 分类调用/耗时以及 Embedding、向量检索、Rerank 分段耗时；这些 trace 不包含 prompt、正文或凭证。

`trace.evidenceSelection` 只记录文档 ID 在“Retriever 召回、评估快照、充分证据选择、最终引用快照”四个阶段的集合与差异，不记录正文。Retriever 命中但最终 `sources` 为空时，可据此区分评估快照裁剪、coverage 判定未充分和引用快照映射异常；它不会把相关文档自动提升为充分证据。

`ENABLE_RERANK` 默认为 `false`，关闭时保持原有 Milvus 检索行为且不会发起 Rerank 请求。启用时必须配置 `RERANK_URL`；Key 按 `RERANK_API_KEY`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY` 的顺序选择。`RERANK_CANDIDATE_K` 控制初始候选数，`RERANK_TOP_N` 控制默认最终文档数，而单次调用的 `askOptions.k` 优先。失败策略默认为 `RERANK_FAILURE_MODE=fallback`，会退回 Milvus 顺序；也可设为 `error` 直接抛错。

Rerank 会保留原始 `score`，并在来源对象中附加 `rerankScore`、`originalRank`、`rerankRank`、`rerankStatus` 等元数据。多轮检索按 reciprocal rank fusion 合并；重排结果不会再被原始向量分数重新排序。当前测试只覆盖 Mock 协议和排序逻辑，尚未验证真实 Rerank 端点或排序质量。

## 生活笔记混合检索

统一调用契约为 `search(query, { k, scope })`。EPUB scope 为 `{ knowledgeBase: "ebook", bookId }`，生活笔记 scope 为 `{ knowledgeBase: "life_notes", userId }`。EPUB 继续只访问 Milvus；生活笔记并行访问 ES 和 Milvus，两个请求均强制 `knowledgeBase`/`userId` 过滤，返回后再二次校验。

笔记结果依赖两个索引共享的稳定 `note_id`；缺少 ID 的结果会 fail closed。ES `_score` 和 Milvus cosine 不直接比较，而是使用 `1 / (60 + rank)` 的 RRF 融合。`scores.keyword/vector/fusion/rerank` 和 `provenance` 分开保留。`ENABLE_NOTE_RERANK=true` 时复用同一 Qwen Rerank 客户端；默认关闭。

可通过 `createNotesRetriever()` 获取只读适配器；`searchWithTrace()` 还会返回单源异常降级、双源异常、过滤数量和 Rerank 状态等安全诊断。当前仅经 Mock 验收，尚未在真实 ES/Milvus 上验证 mapping、字段一致性、租户过滤和检索质量。

## 生活笔记 CRUD 与双索引同步

PostgreSQL 是笔记原始数据真相源；`note_id` 默认使用 UUID，也可由调用方提供符合约束的稳定 ID。所有 Repository 操作都同时限定 `note_id/user_id/knowledge_base=life_notes`，ES 文档 `_id` 和 Milvus 主键字段 `note_id` 复用同一个 ID。新增和修改先将 PostgreSQL 行记为 `pending/upsert`，然后生成一次 Embedding，并行执行 ES `index` 与 Milvus `upsert`。删除先写 PostgreSQL 墓碑，使普通查询立即不可见；两个索引都清理成功后才硬删除墓碑。

单端同步失败时，原始笔记（或删除墓碑）会以 `failed` 状态保留，记录 `sync_attempts`、`sync_operation` 和不含外部响应的安全错误类别。`retry` 会幂等重放两个索引；本实现不使用消息队列、后台 worker 或分布式事务。因此失败与重试之间可能短暂存在跨存储不一致，调用方必须检查返回的 `sync.status`。

`sql/001_create_life_notes.sql` 只提供最小表结构，不会自动运行。只有获得真实数据库/Embedding/ES/Milvus 写入授权并确认三个存储的 Schema 后，才可手工执行 migration，再使用带 `--execute` 的 CLI：

```bash
# 默认仅校验参数，不连接任何外部服务
npm run notes -- create --user-id demo-user --title "标题" --content "正文"

# 以下命令会真实写入，必须事先取得授权
npm run notes -- create --user-id demo-user --title "标题" --content "正文" --execute
npm run notes -- update --user-id demo-user --note-id <note-id> --content "新正文" --execute
npm run notes -- get --user-id demo-user --note-id <note-id> --execute
npm run notes -- list --user-id demo-user --execute
npm run notes -- delete --user-id demo-user --note-id <note-id> --execute
npm run notes -- retry --user-id demo-user --note-id <note-id> --execute
```

当前只完成 Mock 验收；PostgreSQL migration、真实索引字段/主键、向量维度、真实写入可见性以及部分失败恢复均待授权联调。没有自动建 ES index 或 Milvus Collection，也不会修改 EPUB 数据结构。

## LangSmith 链路追踪

LangSmith 默认关闭。启用 EPUB Graph 追踪时，在本地 `.env` 设置：

```dotenv
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your-langsmith-key
LANGSMITH_PROJECT=memorag
MEMORAG_LANGSMITH_CONTENT_MODE=metadata_only
```

然后正常执行 `npm run chat`。终端会显示本次运行的 project 和 trace ID；在 LangSmith Web 控制台进入同名 Project，并按 trace ID 定位调用，即可查看 `routeQuestion`、`decomposeQuestion`、`rewriteSubQuestion`、`retrieve`、`rerank`、`evaluate`、`webSearch` 和 `generate` 等 span。配置缺少 Key 时追踪会安全关闭，不影响问答。

兼容旧变量 `LANGSMITH_TRACING_V2`、`LANGCHAIN_TRACING`、`LANGCHAIN_TRACING_V2`、`LANGCHAIN_API_KEY`、`LANGCHAIN_PROJECT` 和 `LANGCHAIN_ENDPOINT`；同类变量同时存在时优先使用 `LANGSMITH_*`。应用会显式控制追踪作用域，不再让开发机的全局开关隐式影响 Mock 测试。

默认的 `metadata_only` 不上传 Graph inputs/outputs、prompt、完整原始文档、联网正文或最终答案，只保留节点名、耗时、实际检索查询、文档 ID、coverage 状态、次数、Rerank 前后 rank 和错误类别等白名单元数据。任何模式都会递归屏蔽 API Key、Token、Authorization、Secret、Password 和 Credential 字段。

`MEMORAG_LANGSMITH_CONTENT_MODE=full` 会上传问题、prompt、上下文和模型输出，只应在明确知情且没有私人内容的环境使用。生活笔记作用域另由 `ENABLE_NOTE_LANGSMITH_TRACING=false` 默认阻断，即使全局追踪已开启也不会上传；只有显式授权后才会观察笔记检索 span，且仍应保持 `metadata_only`。

LangSmith Client 失败不会改变问答结果；安全错误类别会出现在 `trace.langsmith.errors`，不会包含服务响应、payload 或凭证。Mock 测试通过预加载隔离文件强制关闭新旧追踪开关，不访问 LangSmith 云端。

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
