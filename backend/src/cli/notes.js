import { pathToFileURL } from "node:url";
import { validateNotesCommandInput } from "../notes/service.js";

const COMMANDS = new Set(["create", "get", "list", "update", "delete", "retry"]);

function takeValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} 缺少参数值`);
  }
  return value;
}

function requireOption(value, name) {
  if (!String(value ?? "").trim()) throw new Error(`缺少必要参数：${name}`);
}

export function parseNotesArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (command === "--help" || command === "-h") {
    return { help: true, execute: false };
  }
  if (!COMMANDS.has(command)) {
    throw new Error("命令必须是 create、get、list、update、delete 或 retry");
  }
  const result = {
    command,
    userId: "",
    noteId: undefined,
    title: undefined,
    content: undefined,
    limit: 50,
    execute: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else if (argument === "--execute") {
      result.execute = true;
    } else if (argument === "--dry-run") {
      result.execute = false;
    } else if (argument === "--user-id") {
      result.userId = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--note-id") {
      result.noteId = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--title") {
      result.title = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--content") {
      result.content = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--limit") {
      result.limit = Number(takeValue(args, index, argument));
      index += 1;
    } else {
      throw new Error(`不支持的参数：${argument}`);
    }
  }
  if (result.help) return result;
  requireOption(result.userId, "--user-id");
  if (["get", "update", "delete", "retry"].includes(command)) {
    requireOption(result.noteId, "--note-id");
  }
  if (command === "create") requireOption(result.content, "--content");
  if (command === "update" && result.title === undefined && result.content === undefined) {
    throw new Error("update 至少需要 --title 或 --content");
  }
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100) {
    throw new Error("--limit 必须是 1 到 100 的整数");
  }
  return result;
}

export function usage() {
  return [
    "用法：npm run notes -- <command> --user-id <id> [options]",
    "",
    "Commands:",
    "  create  --content <text> [--title <text>] [--note-id <id>]",
    "  get     --note-id <id>",
    "  list    [--limit <1-100>]",
    "  update  --note-id <id> [--title <text>] [--content <text>]",
    "  delete  --note-id <id>",
    "  retry   --note-id <id>",
    "",
    "默认 dry-run：只校验命令，不连接 PostgreSQL、ES、Milvus 或 Embedding。",
    "只有获得真实写入授权后才可增加 --execute。",
  ].join("\n");
}

function operationInput(options) {
  const common = { userId: options.userId };
  if (options.noteId !== undefined) common.noteId = options.noteId;
  if (options.title !== undefined) common.title = options.title;
  if (options.content !== undefined) common.content = options.content;
  if (options.command === "list") common.limit = options.limit;
  return common;
}

function printResult(command, result, log) {
  if (command === "list") {
    log(`查询完成：${result.length} 条笔记。`);
    return;
  }
  if (command === "get") {
    log(result ? `查询完成：${result.noteId}` : "未找到笔记。");
    return;
  }
  const sync = result.sync?.status ? `，索引同步 ${result.sync.status}` : "";
  log(`${command} 完成${sync}。`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseNotesArgs(argv);
  const log = dependencies.log ?? console.log;
  if (options.help) {
    log(usage());
    return { status: "help" };
  }
  const input = validateNotesCommandInput(options.command, operationInput(options));
  if (!options.execute) {
    log(`Dry-run 完成：${options.command} 参数有效；未连接或修改任何外部服务。`);
    return { status: "dry_run", command: options.command };
  }

  let service = dependencies.service;
  if (!service) {
    const { createNotesService } = await import("../notes/index.js");
    service = createNotesService({ config: dependencies.config });
  }
  try {
    const result = await service[options.command](input);
    printResult(options.command, result, log);
    return result;
  } finally {
    await service.close();
  }
}

const isEntryPoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((error) => {
    const code = error?.code ? ` [${error.code}]` : "";
    console.error(`生活笔记操作失败${code}：${error.message}`);
    process.exitCode = 1;
  });
}
