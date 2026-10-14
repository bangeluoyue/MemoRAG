function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function scoreLabel(source) {
  const score = source?.scores?.rerank
    ?? source?.scores?.fusion
    ?? source?.rerankScore
    ?? source?.score;
  return Number.isFinite(Number(score)) ? Number(score).toFixed(4) : null;
}

function SourceDetails({ source, type = "local" }) {
  const isNote = source.knowledgeBase === "life_notes" || source.noteId;
  const title = type === "web"
    ? (source.title || source.name || source.url || "网页来源")
    : isNote
      ? (source.title || source.metadata?.title || "未命名笔记")
      : (source.bookName || "电子书片段");
  const content = source.content
    || source.snippet
    || source.summary
    || source.text
    || "该来源未返回可展示的正文片段。";

  return (
    <details className="source-card">
      <summary>
        <span className="source-reference">{source.reference || "来源"}</span>
        <span className="source-title">{title}</span>
        <span className="source-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="source-body">
        <dl className="source-meta">
          {isNote && <><dt>笔记 ID</dt><dd>{source.noteId || source.id}</dd></>}
          {!isNote && source.id && <><dt>文档 ID</dt><dd>{source.id}</dd></>}
          {!isNote && source.chapterNum != null && (
            <><dt>章节</dt><dd>第 {source.chapterNum} 章 · 片段 {source.chunkIndex ?? "—"}</dd></>
          )}
          {scoreLabel(source) && <><dt>相关度</dt><dd>{scoreLabel(source)}</dd></>}
          {type === "web" && source.url && (
            <><dt>链接</dt><dd><a href={source.url} target="_blank" rel="noreferrer">查看原网页</a></dd></>
          )}
        </dl>
        <p className="source-content">{content}</p>
      </div>
    </details>
  );
}

function ExecutionSummary({ trace }) {
  const execution = trace?.execution;
  if (!execution) return null;
  const items = [
    ["总耗时", formatDuration(execution.totalDurationMs)],
    ["模型调用", execution.llmCallCount ?? 0],
    ["本地检索", execution.localRetrievalCount ?? trace.retrievalCount ?? 0],
    ["Rerank", execution.rerankRequestCount ?? 0],
    ["联网搜索", execution.webSearchCount ?? trace.webSearchCount ?? 0],
  ];

  return (
    <section className="execution-panel" aria-label="执行摘要">
      <div className="section-heading compact">
        <div>
          <span className="eyebrow">Execution</span>
          <h3>执行摘要</h3>
        </div>
      </div>
      <div className="metric-grid">
        {items.map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AnswerPanel({ result }) {
  if (!result) return null;
  const sources = result.sources ?? [];
  const webSources = result.webSources ?? [];

  return (
    <div className="answer-stack" aria-live="polite">
      <article className="answer-card">
        <div className="answer-heading">
          <div>
            <span className="eyebrow">Answer</span>
            <h2>回答</h2>
          </div>
          {result.route?.mode && (
            <span className={`route-badge route-${result.route.mode}`}>
              {result.route.mode.replace("_", " ")}
            </span>
          )}
        </div>
        <p className="answer-copy">{result.answer || "没有生成回答。"}</p>
        {result.route?.reason && (
          <p className="route-reason">路由判断：{result.route.reason}</p>
        )}
      </article>

      <ExecutionSummary trace={result.trace} />

      <section className="sources-panel">
        <div className="section-heading compact">
          <div>
            <span className="eyebrow">Evidence</span>
            <h3>引用来源</h3>
          </div>
          <span className="count-badge">{sources.length + webSources.length}</span>
        </div>
        {!sources.length && !webSources.length ? (
          <p className="muted-state">本次回答没有返回引用来源。</p>
        ) : (
          <div className="source-list">
            {sources.map((source, index) => (
              <SourceDetails key={`${source.id || "local"}-${index}`} source={source} />
            ))}
            {webSources.map((source, index) => (
              <SourceDetails
                key={`${source.url || "web"}-${index}`}
                source={source}
                type="web"
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
