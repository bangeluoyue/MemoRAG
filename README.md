# MemoRAG

MemoRAG 是一个面向 AI 全栈实习展示的双知识库 RAG 应用。项目保留两条独立、可解释的数据与问答链路，不强制共用同一套 Graph。

```text
EPUB
  EPUB → 分块 → Embedding → Milvus
  问题 → 三态路由 → 可选拆题 → 多轮 Milvus 检索
       → 轻量决策（继续检索 / Bocha / 生成）→ 回答与来源

生活笔记
  PostgreSQL CRUD → ES + Milvus 双索引同步
  问题 → ES + Milvus 并行召回 → RRF → 可选 Rerank
       → 一次生成 → 回答与笔记来源
```

## 主要能力

- EPUB Agentic RAG：`direct / single_retrieval / multi_hop` 三态路由、受控多轮检索、可选 Bocha 联网、原文引用。
- EPUB 入库：本地 EPUB 解析、章节分块、稳定 ID、Embedding 和批量 Milvus 写入；默认 dry-run。
- 生活笔记：PostgreSQL CRUD、ES/Milvus 双索引同步、失败状态与显式 retry。
- Notes Hybrid RAG：严格按 `userId + knowledgeBase` 隔离，ES/Milvus 并行召回、稳定 `note_id` 去重、RRF、可选 Qwen Rerank。
- Node HTTP API 和 React + Vite 演示页面，包含两个固定账号的 Cookie 会话认证。
- 登录用户可从 Milvus 动态书籍列表按书名选择 EPUB；管理员还可重置测试员密码，并通过网页复用安全 EPUB 入库流程。
- 模型/整次请求超时、来源编号校验、默认关闭的 LangSmith metadata-only 追踪，以及显式执行的三指标 OpenEvals 评估。

历史 coverage、依赖改写、缺口恢复和复杂 evaluate Graph 仍保留在源码与 Git 历史中，但不再是默认问答路径。

## 当前验收状态

- Notes Hybrid RAG 已完成一次本机真实验收：两条临时笔记经 HTTP 写入 PostgreSQL，并同步到 ES/Milvus；ES 与 Milvus 各召回两条，RRF 去重后只调用一次生成模型，答案和引用均受原文支持。验收数据随后按精确 `note_id` 删除，三端均无残留。
- EPUB 默认 Graph 已确认不会把 route/decision 的推测性 `reason` 注入最终生成 Prompt；生成 Prompt 进一步约束人物关系、行为主客体及“人物认知/客观事实”的区分。该修复已通过 Mock，尚未重复真实 E2，不能据此宣称已彻底消除幻觉。

## 本地开发

```bash
cd backend
npm install
npm test
# 首次启用登录前，仅执行最小认证表 migration（不会修改业务数据）
psql "$DATABASE_URL" -f sql/002_create_auth.sql
npm start
```

另一个终端：

```bash
cd frontend
npm install
npm test
npm run dev
```

前端通过 Vite proxy 将 `/api` 转发到 `127.0.0.1:3000`。生产构建：

```bash
cd frontend
npm run build
```

详细后端配置与接口见 [`backend/README.md`](backend/README.md)，前端说明见 [`frontend/README.md`](frontend/README.md)，当前规格与验收边界见 [`docs/specs/memorag-roadmap.md`](docs/specs/memorag-roadmap.md)。

## 安全边界

- `.env`、密钥、数据库数据、日志和构建产物不得提交。
- EPUB 检索始终按 `bookId` 过滤；生活笔记由后端会话绑定内部 `notes_user_id + knowledgeBase`，不信任前端 `userId`。
- 当前只有固定管理员和测试员账号，适合本地演示；不是完整公网用户管理系统。管理员初始密码与会话密钥只允许通过本地环境变量提供。
- 默认不启用联网、Rerank 或 LangSmith；真实数据库写入和付费模型调用需显式配置并单独授权。
- 旧课程脚本仅供参考，不应直接运行其中的建库、删库或 seed 逻辑。
