export function createBochaWebSearch({ apiKey, url }) {
  if (!apiKey) return null;

  return async function searchWeb(query, count = 8) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(`联网搜索失败（HTTP ${response.status}）：${message}`);
    }

    const json = await response.json();
    const pages = json.data?.webPages?.value ?? [];
    const sources = pages.map((page) => ({
      title: String(page.name ?? ""),
      url: String(page.url ?? ""),
      summary: String(page.summary ?? ""),
      siteName: String(page.siteName ?? ""),
      crawledAt: String(page.dateLastCrawled ?? ""),
    }));

    return {
      text: sources.length
        ? sources.map((source, index) => [
            `[网页${index + 1}]`,
            `标题：${source.title}`,
            `URL：${source.url}`,
            `摘要：${source.summary}`,
          ].join("\n")).join("\n\n")
        : "未找到相关网页结果。",
      sources,
    };
  };
}
