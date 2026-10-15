# MemoRAG 最小 LangSmith 评估

这里保留课程 Demo 的三个入口，但只评估一条已经完成的 EPUB 问答，不会重新执行 RAG：

- `build_dataset.mjs`：校验本地样本，并在显式 `--execute` 时创建/复用 LangSmith Dataset。
- `evaluators.mjs`：使用 OpenEvals 标准 Prompt 提供 Groundedness、Helpfulness、Retrieval Relevance 三个 Judge。
- `run_eval.mjs`：回放样本中记录的 answer/context，串行执行三个 Judge，并保存评分摘要。

## 准备真实样本

当前仓库没有保存《阿Q正传》真实问答的完整回答和原文来源。将 `sample.example.json` 复制到被 Git 忽略的 `legacy/eval/local/`，从一次实际 MemoRAG HTTP 响应填写：

- `answer`：MemoRAG 原样返回的回答，至少包含一个合法 `[本地N]`。
- `sources`：按返回顺序完整保存 `id/reference/bookId/bookName/chapterNum/chunkIndex/content`。
- `capturedAt`：捕获时间的 ISO 字符串。
- `traceId`：可选，填写对应 `trace.langsmith.traceId`。

不要手工补写答案、文档 ID 或原文。脚本会拒绝空来源、重复 ID、乱序引用、跨 `bookId` 来源及越界引用。Dataset 将实际生成答案标记为 `recorded_answer`，不会把它伪装成参考答案。

## Dry-run

在 `backend/` 下执行：

```bash
npm run eval:dataset -- --sample legacy/eval/local/aq.json
npm run eval:run -- --sample legacy/eval/local/aq.json
```

默认只读本地 JSON 并打印计划，不创建 Dataset、不访问 LangSmith，也不调用 Judge、RAG 或 Embedding。

## 一次真实评估

确认 `.env` 已安全配置 `LANGSMITH_API_KEY`、模型 Key/Base URL 后执行：

```bash
npm run eval:run -- --sample legacy/eval/local/aq.json --execute
```

该命令会幂等创建/复用 `memorag-epub-eval-v1` Dataset，回放记录结果并串行调用三个 Judge，各一次、零自动重试；不会再次调用完整 RAG 或 Embedding。终端会输出评分、解释、LangSmith 实验链接和本地结果路径。

评估会将这条公开文学问题、实际回答及来源原文上传到 LangSmith Experiment，`metadata_only` 业务 Trace 策略不能替代对此次显式上传的知情确认。脚本拒绝 Notes 样本；生活笔记追踪仍保持默认关闭。本地样本和结果目录不会提交 Git。
