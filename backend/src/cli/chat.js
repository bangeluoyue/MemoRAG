import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { createEbookRag } from "../rag/ebook/index.js";

function printResult(result) {
  console.log(`\n回答：\n${result.answer}`);
  console.log(
    `\n路由：${result.route.strategy}/${result.route.mode ?? "legacy"}（${result.route.reason}）`,
  );

  if (result.trace.subQuestions.length) {
    console.log("\n检索子问题：");
    result.trace.subQuestions.forEach((question, index) => {
      console.log(`  ${index + 1}. ${question}`);
    });
  }

  if (result.trace.rewriteHistory.length) {
    console.log("\n查询改写：");
    result.trace.rewriteHistory.forEach((rewrite) => {
      const marker = rewrite.rewriteApplied ? "已改写" : "保留原问题";
      console.log(`  [${rewrite.subQuestionIndex + 1}] ${marker}：${rewrite.originalSubQuestion}`);
      if (rewrite.rewriteApplied) {
        console.log(`      → ${rewrite.rewrittenQuery}`);
      }
      console.log(`      ${rewrite.reason}`);
      if (rewrite.fallbackReason) {
        console.log(
          `      回退：${rewrite.fallbackStrategy ?? "safe_fallback"}（${rewrite.fallbackReason}）`,
        );
      }
    });
  }

  if (result.trace.coverage?.length) {
    console.log("\n证据覆盖：");
    result.trace.coverage.forEach((item) => {
      console.log(
        `  [${item.planIndex + 1}] 检索=${item.retrieved ? "是" : "否"}，相关=${item.hasRelevantEvidence ? "是" : "否"}，充分=${item.isSufficient ? "是" : "否"}，状态=${item.status}`,
      );
    });
  }

  if (result.sources.length) {
    console.log("\n本地引用：");
    result.sources.forEach((source) => {
      const preview = source.content.replace(/\s+/g, " ").slice(0, 140);
      console.log(
        `  [${source.reference}] id=${source.id}, 第${source.chapterNum}章, chunk=${source.chunkIndex}, score=${source.score.toFixed(4)}`,
      );
      console.log(`    ${preview}${source.content.length > 140 ? "..." : ""}`);
    });
  }

  if (result.webSources.length) {
    console.log("\n网页引用：");
    result.webSources.forEach((source) => {
      console.log(`  [${source.reference}] ${source.title}: ${source.url}`);
    });
  }

  const execution = result.trace.execution;
  const nodeCalls = execution
    ? Object.values(execution.nodes).reduce((total, node) => total + node.count, 0)
    : 0;
  const executionDetails = execution
    ? `，节点 ${nodeCalls} 次，LLM ${execution.llmCallCount} 次，总耗时 ${execution.totalDurationMs}ms`
    : "";
  console.log(
    `\n执行统计：本地检索 ${result.trace.retrievalCount} 次，联网搜索 ${result.trace.webSearchCount} 次${executionDetails}`,
  );
  if (execution) {
    console.log("节点耗时：");
    Object.entries(execution.nodes).forEach(([name, node]) => {
      console.log(`  ${name}: ${node.count} 次 / ${node.durationMs}ms`);
    });
    const stages = execution.retrievalStages ?? {};
    console.log(
      `检索阶段耗时：Embedding ${stages.embeddingDurationMs ?? 0}ms，向量检索 ${stages.vectorSearchDurationMs ?? 0}ms，Rerank ${stages.rerankDurationMs ?? 0}ms，检索总计 ${stages.totalDurationMs ?? 0}ms`,
    );
    const llm = execution.llmDurationMs ?? {};
    console.log(
      `生成阶段耗时：初次生成 ${llm.generate ?? 0}ms，引用纠正 ${llm.citationCorrection ?? 0}ms`,
    );
  }
  const langsmith = result.trace.langsmith;
  if (langsmith?.enabled) {
    console.log(
      `LangSmith：project=${langsmith.project}，trace=${langsmith.traceId}，内容模式=${langsmith.contentMode}`,
    );
  } else if (langsmith?.requested) {
    console.log(`LangSmith：未启用（${langsmith.disabledReason}）`);
  }
}

export async function main() {
  const rag = createEbookRag();
  const oneShotQuestion = process.argv.slice(2).join(" ").trim();

  try {
    console.log(
      `MemoRAG EPUB 问答：${rag.config.rag.bookName} / Collection=${rag.config.milvus.collectionName}`,
    );

    if (oneShotQuestion) {
      printResult(await rag.ask(oneShotQuestion));
      return;
    }

    const readline = createInterface({ input, output });
    try {
      console.log("输入问题开始问答；输入 /exit 退出。\n");
      while (true) {
        const question = (await readline.question("问题> ")).trim();
        if (!question) continue;
        if (["/exit", "/quit"].includes(question.toLowerCase())) break;

        try {
          printResult(await rag.ask(question));
        } catch (error) {
          console.error(`\n问答失败：${error.message}\n`);
        }
      }
    } finally {
      readline.close();
    }
  } finally {
    await rag.close();
  }
}
// 如果用户直接运行当前 JS 文件，就启动主函数；如果当前文件只是被其他模块导入，就不自动运行。启动失败时打印错误，并把进程退出码设置为 1。
const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
