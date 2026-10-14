import { pathToFileURL } from "node:url";
import {
  DEFAULT_EPUB_CHUNK_OVERLAP,
  DEFAULT_EPUB_CHUNK_SIZE,
  DEFAULT_EPUB_INGEST_BATCH_SIZE,
  DUPLICATE_POLICIES,
  createEbookIngestion,
  prepareEpubIngestion,
} from "../rag/ebook/ingestion/index.js";

function integerOption(value, name, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  }
  return number;
}

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少参数值`);
  return value;
}

export function parseIngestArgs(argv) {
  const result = {
    filePath: "",
    bookId: "",
    bookName: undefined,
    chunkSize: DEFAULT_EPUB_CHUNK_SIZE,
    chunkOverlap: DEFAULT_EPUB_CHUNK_OVERLAP,
    batchSize: DEFAULT_EPUB_INGEST_BATCH_SIZE,
    onDuplicate: "skip",
    execute: false,
    help: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--execute") {
      result.execute = true;
    } else if (argument === "--dry-run") {
      result.execute = false;
    } else if (argument === "--book-id") {
      result.bookId = takeValue(args, index, "--book-id");
      index += 1;
    } else if (argument === "--book-name") {
      result.bookName = takeValue(args, index, "--book-name");
      index += 1;
    } else if (argument === "--chunk-size") {
      result.chunkSize = integerOption(
        takeValue(args, index, "--chunk-size"),
        "--chunk-size",
        { minimum: 1 },
      );
      index += 1;
    } else if (argument === "--chunk-overlap") {
      result.chunkOverlap = integerOption(
        takeValue(args, index, "--chunk-overlap"),
        "--chunk-overlap",
      );
      index += 1;
    } else if (argument === "--batch-size") {
      result.batchSize = integerOption(
        takeValue(args, index, "--batch-size"),
        "--batch-size",
        { minimum: 1 },
      );
      index += 1;
    } else if (argument === "--on-duplicate") {
      result.onDuplicate = takeValue(args, index, "--on-duplicate").toLowerCase();
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`不支持的参数：${argument}`);
    } else if (!result.filePath) {
      result.filePath = argument;
    } else {
      throw new Error("只能指定一个 EPUB 文件");
    }
  }
  if (result.help) return result;
  if (!result.filePath) throw new Error("请指定 EPUB 文件路径");
  if (!result.bookId.trim()) throw new Error("请通过 --book-id 指定稳定图书 ID");
  if (result.chunkOverlap >= result.chunkSize) {
    throw new Error("--chunk-overlap 必须小于 --chunk-size");
  }
  if (!DUPLICATE_POLICIES.includes(result.onDuplicate)) {
    throw new Error(`--on-duplicate 必须是 ${DUPLICATE_POLICIES.join("、")}`);
  }
  return result;
}

export function usage() {
  return [
    "用法：npm run ingest:epub -- <book.epub> --book-id <id> [options]",
    "",
    "默认为 dry-run：只解析和分块，不调用 Embedding，不连接或写入 Milvus。",
    "真实入库必须显式增加 --execute。",
    "",
    "Options:",
    "  --book-name <name>            默认使用 EPUB metadata title",
    `  --chunk-size <n>              默认 ${DEFAULT_EPUB_CHUNK_SIZE}`,
    `  --chunk-overlap <n>           默认 ${DEFAULT_EPUB_CHUNK_OVERLAP}`,
    `  --batch-size <n>              默认 ${DEFAULT_EPUB_INGEST_BATCH_SIZE}`,
    "  --on-duplicate skip|error|resume  默认 skip，不支持覆盖",
    "  --execute                     执行真实 Embedding 和 Milvus insert",
    "  --dry-run                     强制只解析/分块",
  ].join("\n");
}

function printPlan(plan, log) {
  log(`EPUB: ${plan.fileName}`);
  log(`bookId: ${plan.bookId}`);
  log(`bookName: ${plan.bookName}`);
  log(`spine/chapters/chunks: ${plan.spineCount}/${plan.chapterCount}/${plan.chunkCount}`);
  log(`chunkSize/overlap: ${plan.chunkSize}/${plan.chunkOverlap}`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseIngestArgs(argv);
  const log = dependencies.log ?? console.log;
  if (options.help) {
    log(usage());
    return { status: "help" };
  }

  const prepare = dependencies.prepare ?? prepareEpubIngestion;
  const plan = await prepare(options);
  printPlan(plan, log);
  if (!options.execute) {
    log("Dry-run 完成：未调用 Embedding，未连接或写入 Milvus。");
    return { status: "dry_run", plan };
  }

  let ingestion = dependencies.ingestion;
  if (!ingestion) {
    const config = dependencies.config
      ?? (await import("../config.js")).getConfig();
    ingestion = createEbookIngestion({ config });
  }
  try {
    const result = await ingestion.ingestPrepared(plan, {
      batchSize: options.batchSize,
      onDuplicate: options.onDuplicate,
    });
    log(`入库结果：${result.status}，新写入 ${result.insertedCount} 条。`);
    return result;
  } finally {
    await ingestion.close();
  }
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    const code = error?.code ? ` [${error.code}]` : "";
    console.error(`EPUB 入库失败${code}：${error.message}`);
    process.exitCode = 1;
  });
}
