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
- Node HTTP API 和 React + Vite 演示页面。
- 模型/整次请求超时、来源编号校验、默认关闭的 LangSmith metadata-only 追踪。

历史 coverage、依赖改写、缺口恢复和复杂 evaluate Graph 仍保留在源码与 Git 历史中，但不再是默认问答路径。

## 本地开发

```bash
cd backend
npm install
npm test
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
- EPUB 检索始终按 `bookId` 过滤；生活笔记始终按 `userId + knowledgeBase` 过滤。
- `userId` 是演示环境的数据范围参数，不是公网身份认证。
- 默认不启用联网、Rerank 或 LangSmith；真实数据库写入和付费模型调用需显式配置并单独授权。
- 旧课程脚本仅供参考，不应直接运行其中的建库、删库或 seed 逻辑。
