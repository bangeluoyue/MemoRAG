import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { loadEpubChapters } from "../src/rag/ebook/ingestion/epub-loader.js";

const execFileAsync = promisify(execFile);
const statFile = async () => ({ isFile: () => true });

function parser(overrides = {}) {
  return {
    getSpine: () => [{ id: "chapter" }],
    loadChapter: async () => ({ html: "<p>Chapter text.</p>" }),
    destroy() {},
    ...overrides,
  };
}

async function assertRemoved(directory) {
  assert.ok(directory);
  await assert.rejects(stat(directory), { code: "ENOENT" });
}

test("EPUB resources use a private temp directory retained until async destroy completes", async () => {
  let directory;
  let destroyed = false;
  const result = await loadEpubChapters("fixture.epub", {
    statFile,
    async openEpub(filePath, resourceDirectory) {
      assert.equal(filePath, resolve("fixture.epub"));
      directory = resourceDirectory;
      assert.equal(dirname(directory), resolve(tmpdir()));
      assert.match(basename(directory), /^memorag-epub-resources-/u);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      await writeFile(join(directory, "style.css"), "fixture resource");
      return parser({
        async destroy() {
          await new Promise((done) => setImmediate(done));
          assert.equal(await readFile(join(directory, "style.css"), "utf8"), "fixture resource");
          destroyed = true;
        },
      });
    },
  });
  assert.equal(result.chapters[0].content, "Chapter text.");
  assert.equal(destroyed, true);
  await assertRemoved(directory);
});

test("concurrent EPUB parses isolate identically named resources and clean success and failure", async () => {
  const directories = [];
  const destroyed = [];
  let ready;
  const bothOpen = new Promise((done) => { ready = done; });
  const results = await Promise.allSettled([0, 1].map((index) => loadEpubChapters(`${index}.epub`, {
    statFile,
    async openEpub(_filePath, directory) {
      directories[index] = directory;
      await writeFile(join(directory, "same.css"), String(index));
      if (directories.filter(Boolean).length === 2) ready();
      await bothOpen;
      assert.equal(await readFile(join(directory, "same.css"), "utf8"), String(index));
      return parser({
        async loadChapter() {
          if (index === 0) throw new Error("chapter fixture failure");
          assert.equal(await readFile(join(directory, "same.css"), "utf8"), "1");
          return { html: "<p>Independent chapter.</p>" };
        },
        destroy() { destroyed.push(index); },
      });
    },
  })));
  assert.notEqual(directories[0], directories[1]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason.code, "EPUB_CHAPTER_READ_FAILED");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value.chapters[0].content, "Independent chapter.");
  assert.deepEqual(destroyed.sort(), [0, 1]);
  await Promise.all(directories.map(assertRemoved));
});

test("parser initialization failure cleans partial resources without removing unrelated temp files", async (t) => {
  const unrelated = await mkdtemp(join(tmpdir(), "memorag-epub-test-unrelated-"));
  t.after(() => rm(unrelated, { recursive: true, force: true }));
  await writeFile(join(unrelated, "keep"), "untouched");
  const cause = new Error("fixture parse failure");
  let directory;
  await assert.rejects(loadEpubChapters("fixture.epub", {
    statFile,
    async openEpub(_filePath, resourceDirectory) {
      directory = resourceDirectory;
      await mkdir(join(directory, "nested"));
      await writeFile(join(directory, "nested", "partial.css"), "partial");
      throw cause;
    },
  }), (error) => error.code === "EPUB_PARSE_FAILED" && error.cause === cause);
  await assertRemoved(directory);
  assert.equal(await readFile(join(unrelated, "keep"), "utf8"), "untouched");
});

test("EPUB error mappings remain unchanged and always destroy and clean resources", async (t) => {
  const cases = [
    { name: "empty spine", code: "EPUB_SPINE_EMPTY", overrides: { getSpine: () => [] } },
    { name: "chapter failure", code: "EPUB_CHAPTER_READ_FAILED", overrides: { loadChapter() { throw new Error("fixture"); } } },
    { name: "empty text", code: "EPUB_TEXT_EMPTY", overrides: { loadChapter: async () => ({ html: "" }) } },
    { name: "spine exception", code: "EPUB_PARSE_FAILED", overrides: { getSpine() { throw new Error("fixture"); } } },
    { name: "text conversion failure", code: "EPUB_PARSE_FAILED", htmlToText() { throw new Error("fixture"); } },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      let directory;
      let destroyed = false;
      await assert.rejects(loadEpubChapters("fixture.epub", {
        statFile,
        ...(item.htmlToText ? { htmlToText: item.htmlToText } : {}),
        async openEpub(_filePath, resourceDirectory) {
          directory = resourceDirectory;
          return parser({ ...item.overrides, destroy() { destroyed = true; } });
        },
      }), (error) => error.code === item.code);
      assert.equal(destroyed, true);
      await assertRemoved(directory);
    });
  }
});

test("resource directory is removed even if parser destroy rejects", async () => {
  const failure = new Error("fixture destroy failure");
  let directory;
  await assert.rejects(loadEpubChapters("fixture.epub", {
    statFile,
    async openEpub(_filePath, resourceDirectory) {
      directory = resourceDirectory;
      return parser({ async destroy() { throw failure; } });
    },
  }), (error) => error === failure);
  await assertRemoved(directory);
});

async function epubFixture({ invalidSpine = false } = {}) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Offline resource fixture</dc:title><dc:identifier id="book">fixture</dc:identifier><dc:language>en</dc:language>
      </metadata>
      <manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
        <item id="style" href="style.css" media-type="text/css"/>
        <item id="cover" href="cover.png" media-type="image/png"/>
      </manifest>
      <spine><itemref idref="${invalidSpine ? "missing" : "chapter"}"/></spine>
    </package>`);
  zip.file("OEBPS/chapter.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml">
    <head><link href="style.css" rel="stylesheet" type="text/css"/></head>
    <body><p>Offline fixture text.</p><img src="cover.png"/></body></html>`);
  zip.file("OEBPS/style.css", "p { color: black; }");
  zip.file("OEBPS/cover.png", Buffer.from([137, 80, 78, 71]));
  return zip.generateAsync({ type: "nodebuffer" });
}

test("real parser reads image/CSS EPUB from a read-only cwd and leaves no temp resources", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires POSIX directory permissions enforced for a non-root user");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "memorag-epub-test-readonly-"));
  const cwd = join(root, "readonly");
  const scratch = join(root, "temporary");
  t.after(async () => {
    await chmod(cwd, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd);
  await mkdir(scratch);
  await writeFile(join(root, "fixture.epub"), await epubFixture());
  // Fail after the real parser has extracted image/CSS resources from a valid ZIP.
  await writeFile(join(root, "invalid.epub"), await epubFixture({ invalidSpine: true }));
  await chmod(cwd, 0o555);
  const script = `
    import assert from 'node:assert/strict';
    import { readdir, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    const { loadEpubChapters } = await import(process.argv[1]);
    await assert.rejects(writeFile('must-not-be-created', ''), { code: 'EACCES' });
    const parsed = await loadEpubChapters(process.argv[2]);
    assert.equal(parsed.chapters[0].content, 'Offline fixture text.');
    assert.deepEqual(await readdir(tmpdir()), []);
    await assert.rejects(loadEpubChapters(process.argv[3]), { code: 'EPUB_PARSE_FAILED' });
    assert.deepEqual(await readdir(tmpdir()), []);
    assert.deepEqual(await readdir('.'), []);
    console.log(JSON.stringify({ parsed: true, readonly: true, cleanedAfterSuccessAndFailure: true }));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", script,
    new URL("../src/rag/ebook/ingestion/epub-loader.js", import.meta.url).href,
    join(root, "fixture.epub"), join(root, "invalid.epub"),
  ], { cwd, env: { ...process.env, TMPDIR: scratch }, timeout: 30_000 });
  assert.ok(stdout, stderr || "read-only parser subprocess did not report completion");
  assert.deepEqual(JSON.parse(stdout), { parsed: true, readonly: true, cleanedAfterSuccessAndFailure: true });
});
