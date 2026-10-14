import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export const DEFAULT_EPUB_CHUNK_SIZE = 500;
export const DEFAULT_EPUB_CHUNK_OVERLAP = 50;

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return number;
}

export function validateChunkOptions({ chunkSize, chunkOverlap }) {
  const size = positiveInteger(chunkSize, "chunkSize");
  const overlap = Number(chunkOverlap);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("chunkOverlap 必须是小于 chunkSize 的非负整数");
  }
  return { chunkSize: size, chunkOverlap: overlap };
}

export function createEbookChunkId({ bookId, chapterNum, chunkIndex, content }) {
  const digest = createHash("sha256")
    .update(String(bookId))
    .update("\0")
    .update(String(chapterNum))
    .update("\0")
    .update(String(chunkIndex))
    .update("\0")
    .update(String(content))
    .digest("hex");
  return `ebook_${digest}`;
}

export async function chunkEpubChapters(chapters, {
  bookId,
  chunkSize = DEFAULT_EPUB_CHUNK_SIZE,
  chunkOverlap = DEFAULT_EPUB_CHUNK_OVERLAP,
  splitter,
} = {}) {
  const id = String(bookId ?? "").trim();
  if (!id) throw new Error("bookId 不能为空");
  const options = validateChunkOptions({ chunkSize, chunkOverlap });
  const textSplitter = splitter ?? new RecursiveCharacterTextSplitter(options);
  const records = [];

  for (const chapter of chapters ?? []) {
    const chapterNum = positiveInteger(chapter?.chapterNum, "chapterNum");
    const chunks = await textSplitter.splitText(String(chapter?.content ?? ""));
    chunks.forEach((value, chunkIndex) => {
      const content = String(value ?? "").trim();
      if (!content) return;
      records.push({
        id: createEbookChunkId({ bookId: id, chapterNum, chunkIndex, content }),
        bookId: id,
        chapterNum,
        chunkIndex,
        content,
      });
    });
  }
  if (!records.length) throw new Error("EPUB 分块后没有可入库内容");
  return records;
}
