import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { initEpubFile } from "@lingo-reader/epub-parser";
import { convert } from "html-to-text";

export class EpubInputError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EpubInputError";
    this.code = code;
  }
}

function normalizeChapterText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function defaultHtmlToText(html) {
  return convert(String(html ?? ""), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  });
}

export async function validateEpubPath(filePath, { statFile = stat } = {}) {
  const input = String(filePath ?? "").trim();
  if (!input) throw new EpubInputError("EPUB_PATH_REQUIRED", "EPUB 文件路径不能为空");
  if (extname(input).toLowerCase() !== ".epub") {
    throw new EpubInputError("EPUB_EXTENSION_INVALID", "输入文件必须使用 .epub 扩展名");
  }

  const absolutePath = resolve(input);
  let fileStat;
  try {
    fileStat = await statFile(absolutePath);
  } catch (error) {
    throw new EpubInputError("EPUB_FILE_NOT_FOUND", "EPUB 文件不存在或无法读取", {
      cause: error,
    });
  }
  if (!fileStat.isFile()) {
    throw new EpubInputError("EPUB_PATH_NOT_FILE", "EPUB 路径不是普通文件");
  }
  return absolutePath;
}

export async function loadEpubChapters(filePath, {
  openEpub = initEpubFile,
  htmlToText = defaultHtmlToText,
  statFile = stat,
} = {}) {
  const absolutePath = await validateEpubPath(filePath, { statFile });
  let epub;
  let resourceDirectory;
  try {
    // The parser extracts images/CSS even for text-only ingestion. Keep these
    // resources out of the read-only application directory and isolate each job.
    resourceDirectory = await mkdtemp(join(tmpdir(), "memorag-epub-resources-"));
    epub = await openEpub(absolutePath, resourceDirectory);
    const spine = epub.getSpine();
    if (!Array.isArray(spine) || !spine.length) {
      throw new EpubInputError("EPUB_SPINE_EMPTY", "EPUB 不包含可处理的 spine 章节");
    }

    const chapters = [];
    let emptyChapterCount = 0;
    for (let index = 0; index < spine.length; index += 1) {
      const spineItem = spine[index];
      let chapter;
      try {
        chapter = await epub.loadChapter(spineItem.id);
      } catch (error) {
        throw new EpubInputError(
          "EPUB_CHAPTER_READ_FAILED",
          `EPUB 第 ${index + 1} 个 spine 章节读取失败`,
          { cause: error },
        );
      }
      const content = normalizeChapterText(htmlToText(chapter?.html ?? ""));
      if (!content) {
        emptyChapterCount += 1;
        continue;
      }
      chapters.push({
        chapterNum: index + 1,
        sourceId: String(spineItem.id ?? ""),
        content,
      });
    }
    if (!chapters.length) {
      throw new EpubInputError("EPUB_TEXT_EMPTY", "EPUB 中没有可入库的文本内容");
    }

    const metadata = epub.getMetadata?.() ?? {};
    return {
      filePath: absolutePath,
      fileName: basename(absolutePath),
      metadata: {
        title: String(metadata.title ?? "").trim(),
      },
      spineCount: spine.length,
      emptyChapterCount,
      chapters,
    };
  } catch (error) {
    if (error instanceof EpubInputError) throw error;
    throw new EpubInputError("EPUB_PARSE_FAILED", "EPUB 解析失败", { cause: error });
  } finally {
    try {
      await epub?.destroy?.();
    } finally {
      if (resourceDirectory) {
        await rm(resourceDirectory, { recursive: true, force: true });
      }
    }
  }
}
