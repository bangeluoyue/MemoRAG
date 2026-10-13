# MemoRAG backend — EPUB Agentic RAG

第一阶段只包含电子书只读检索、LangGraph Agent 和终端问答。它不会创建、删除、重建或写入 Milvus Collection。

## 模块

- `src/config.js`：集中读取和校验环境变量。
- `src/observability/langsmith.js`：默认关闭、内容边界明确的 LangSmith Graph 追踪适配层。
- `src/rag/ebook/milvus-retriever.js`：只读 Milvus 检查与向量检索。
- `src/rag/ebook/agent-graph.js`：LangGraph 配置归一化、节点装配、条件边和兼容导出。
- `src/rag/ebook/nodes/`、`services/`：三态路由、受控检索、依赖改写、证据覆盖、生成、引用等节点与纯逻辑。
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

Agent 内部路由分为 `direct`、`single_retrieval` 和 `multi_hop`。书中单一人物、事件或动机问题优先走单跳路径，不执行拆题和改写；首轮证据不足时最多按 `MAX_SINGLE_RETRIEVALS` 的预算补充本地检索（默认总计 2 次），也可在已启用联网时受 `MAX_WEB_SEARCHES` 限制回退。多跳路径默认最多生成 `MAX_SUB_QUESTIONS=4` 个必要计划项；非法计划最多按 `MAX_PLAN_REPAIR_ATTEMPTS=1` 修复一次，仍失败则回退到原始问题。依赖型改写只接受当前请求证据快照内的连续序号；改写失败时使用原始完整问题安全回退，内部“第 N 项人物”等占位表达不会进入 Retriever。

`MAX_CONTEXT_DOCUMENTS` 默认 12。充分性评估从各检索轮次平衡选取最多 6 条、每条最多 600 字符的证据，并逐计划项分别记录“是否检索、是否存在相关证据、是否足以支持答案”。计划执行完仍有缺口时，`MAX_GAP_RECOVERY_ATTEMPTS` 允许 0～1 次定向恢复（默认 1），且不会突破 `MAX_RETRIEVALS` 或单跳预算。预算耗尽后允许保留未解决项；生成器只接收 coverage 判定为充分的本地证据，并明确说明其余部分无法确认。

coverage 是受限证据快照上的相关性/充分性判断，不是完整的事实蕴含证明，`contentSupportChecked` 仍为 `false`。`route.strategy` 保持 `simple|complex` 兼容，并新增 `route.mode`。`trace.coverage`、`trace.retrievals` 和 `trace.execution` 记录覆盖状态、实际查询、回退原因、节点耗时、LLM 分类调用/耗时以及 Embedding、向量检索、Rerank 分段耗时；这些 trace 不包含 prompt、正文或凭证。

`ENABLE_RERANK` 默认为 `false`，关闭时保持原有 Milvus 检索行为且不会发起 Rerank 请求。启用时必须配置 `RERANK_URL`；Key 按 `RERANK_API_KEY`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY` 的顺序选择。`RERANK_CANDIDATE_K` 控制初始候选数，`RERANK_TOP_N` 控制默认最终文档数，而单次调用的 `askOptions.k` 优先。失败策略默认为 `RERANK_FAILURE_MODE=fallback`，会退回 Milvus 顺序；也可设为 `error` 直接抛错。

Rerank 会保留原始 `score`，并在来源对象中附加 `rerankScore`、`originalRank`、`rerankRank`、`rerankStatus` 等元数据。多轮检索按 reciprocal rank fusion 合并；重排结果不会再被原始向量分数重新排序。当前测试只覆盖 Mock 协议和排序逻辑，尚未验证真实 Rerank 端点或排序质量。

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

`MEMORAG_LANGSMITH_CONTENT_MODE=full` 会上传问题、prompt、上下文和模型输出，只应在明确知情且没有私人内容的环境使用。生活笔记作用域另由 `ENABLE_NOTE_LANGSMITH_TRACING=false` 默认阻断，即使全局追踪已开启也不会上传；P3-3 尚未实现生活笔记业务本身。

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
