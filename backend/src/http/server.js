import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getConfig } from "../config.js";
import { createNotesService } from "../notes/index.js";
import { createEbookRag } from "../rag/ebook/index.js";
import { createNotesRag } from "../rag/notes/agent.js";
import { createHttpHandler } from "./app.js";

function listen(server, { host, port }) {
  return new Promise((resolveListen, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

export function createApiRuntime(options = {}) {
  const config = options.config ?? getConfig();
  const ebookRag = options.ebookRag ?? createEbookRag({ config });
  const notesRag = options.notesRag ?? createNotesRag({ config });
  const notesService = options.notesService ?? createNotesService({ config });
  const server = createServer(createHttpHandler({
    ebookRag,
    notesRag,
    notesService,
    logger: options.logger,
  }));

  return {
    server,
    async start() {
      await listen(server, config.http);
      return server.address();
    },
    async close() {
      await closeServer(server);
      await Promise.allSettled([
        ebookRag.close?.(),
        notesRag.close?.(),
        notesService.close?.(),
      ]);
    },
  };
}

async function main() {
  const runtime = createApiRuntime();
  const address = await runtime.start();
  console.log(`MemoRAG API listening on http://${address.address}:${address.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`MemoRAG API 启动失败：${error?.name ?? "Error"}`);
    process.exitCode = 1;
  });
}
