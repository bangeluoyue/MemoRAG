import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

const SENSITIVE_KEY_PATTERN = /(?:authorization|api[_-]?key|access[_-]?token|secret|password|credential|cookie)/i;
const SAFE_METADATA_KEYS = new Set([
  "langgraph_node",
  "langgraph_step",
  "ls_model_name",
  "ls_model_type",
  "ls_provider",
  "memorag_scope",
  "memorag_content_mode",
  "knowledge_base",
  "query",
  "document_ids",
  "candidate_count",
  "requested_top_n",
  "top_n",
  "rerank_status",
  "failure_category",
  "span_name",
  "span_type",
  "plan_item_count",
  "sub_question_count",
  "citation_document_count",
  "retrieval_count",
  "web_search_count",
  "gap_recovery_count",
  "returned_count",
  "route_mode",
  "strategy",
  "status",
  "fallback_reason",
  "fallback_strategy",
  "error_category",
  "llm_calls",
  "rank_changes",
  "coverage",
  "duration_ms",
  "run_error_category",
]);

function safeString(value, maximum = 500) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, maximum);
}

function safeStringArray(values, maximum = 50) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => safeString(value, 200)).filter(Boolean))]
    .slice(0, maximum);
}

function safeErrorCategory(error) {
  const name = safeString(error?.name || "LANGSMITH_CLIENT_ERROR", 80);
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : "LANGSMITH_CLIENT_ERROR";
}

function timestampMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function redactSensitiveFields(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, key, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      childKey === "error"
        ? (childValue ? "LANGSMITH_RUN_ERROR" : childValue)
        : redactSensitiveFields(childValue, childKey, seen),
    ]),
  );
}

function pickSafeMetadata(metadata = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (key === "rank_changes" && Array.isArray(value)) {
      safe[key] = value.slice(0, 50).map((change) => ({
        documentId: safeString(change?.documentId, 200),
        originalRank: Number(change?.originalRank) || null,
        rerankRank: Number(change?.rerankRank) || null,
      }));
    } else if (key === "coverage" && Array.isArray(value)) {
      safe[key] = value.slice(0, 8).map((item) => ({
        planIndex: Number(item?.planIndex),
        status: safeString(item?.status, 80),
        retrieved: Boolean(item?.retrieved),
        hasRelevantEvidence: Boolean(item?.hasRelevantEvidence),
        isSufficient: Boolean(item?.isSufficient),
        hasConflictingEvidence: Boolean(item?.hasConflictingEvidence),
      }));
    } else if (key === "llm_calls" && value && typeof value === "object") {
      safe[key] = Object.fromEntries(
        Object.entries(value).map(([category, count]) => [
          safeString(category, 50),
          Number(count) || 0,
        ]),
      );
    } else if (Array.isArray(value)) safe[key] = safeStringArray(value);
    else if (["number", "boolean"].includes(typeof value)) safe[key] = value;
    else if (value != null) safe[key] = safeString(value);
  }
  return safe;
}

function collectRunMetadata(run) {
  const metadata = {
    ...pickSafeMetadata(run?.extra?.metadata),
    span_name: safeString(run?.name, 120),
    span_type: safeString(run?.run_type, 40),
  };
  const documentIds = new Set(safeStringArray(metadata.document_ids));
  let rankChanges = [];
  let coverage = [];
  const rerankResults = [];

  const visit = (value, depth = 0) => {
    if (depth > 7 || value == null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 60)) visit(item, depth + 1);
      return;
    }

    if (safeString(run?.name, 120) === "rerank"
      && Number.isInteger(Number(value.index))
      && Number.isInteger(Number(value.rank))) {
      rerankResults.push({
        index: Number(value.index),
        rank: Number(value.rank),
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if ((key === "query" || key === "currentQuery")
        && typeof child === "string" && child.trim()) {
        metadata.query = safeString(child);
      } else if (key === "documentIds") {
        for (const id of safeStringArray(child)) documentIds.add(id);
      } else if (key === "rankChanges" && Array.isArray(child)) {
        rankChanges = child.slice(0, 50).map((change) => ({
          documentId: safeString(change?.documentId, 200),
          originalRank: Number(change?.originalRank) || null,
          rerankRank: Number(change?.rerankRank) || null,
        }));
      } else if (key === "coverage" && Array.isArray(child)) {
        coverage = child.slice(0, 8).map((item) => ({
          planIndex: Number(item?.planIndex),
          status: safeString(item?.status, 80),
          retrieved: Boolean(item?.retrieved),
          hasRelevantEvidence: Boolean(item?.hasRelevantEvidence),
          isSufficient: Boolean(item?.isSufficient),
          hasConflictingEvidence: Boolean(item?.hasConflictingEvidence),
        }));
      } else if (key === "planItems" && Array.isArray(child)) {
        metadata.plan_item_count = child.length;
      } else if (key === "subQuestions" && Array.isArray(child)) {
        metadata.sub_question_count = child.length;
      } else if (key === "citationDocuments" && Array.isArray(child)) {
        metadata.citation_document_count = child.length;
      } else if ([
        "retrievalCount",
        "webSearchCount",
        "gapRecoveryCount",
        "candidateCount",
        "requestedTopN",
        "returnedCount",
      ].includes(key)) {
        const number = Number(child);
        if (Number.isFinite(number)) {
          metadata[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = number;
        }
      } else if ([
        "routeMode",
        "strategy",
        "status",
        "fallbackReason",
        "fallbackStrategy",
        "failureCategory",
        "errorCategory",
      ].includes(key) && child != null) {
        metadata[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] = safeString(child, 120);
      } else if (key === "llmCalls" && child && typeof child === "object") {
        metadata.llm_calls = Object.fromEntries(
          Object.entries(child).map(([category, count]) => [
            safeString(category, 50),
            Number(count) || 0,
          ]),
        );
      }
      visit(child, depth + 1);
    }
  };

  visit(run?.inputs);
  visit(run?.outputs);
  if (!rankChanges.length && rerankResults.length) {
    const originalDocumentIds = [...documentIds];
    rankChanges = rerankResults.slice(0, 50).map((result) => ({
      documentId: originalDocumentIds[result.index] ?? "",
      originalRank: result.index + 1,
      rerankRank: result.rank,
    }));
  }
  if (documentIds.size) metadata.document_ids = [...documentIds].slice(0, 50);
  if (rankChanges.length) metadata.rank_changes = rankChanges;
  if (coverage.length) metadata.coverage = coverage;
  const startTimeMs = timestampMilliseconds(run?.start_time);
  const endTimeMs = timestampMilliseconds(run?.end_time);
  if (startTimeMs != null && endTimeMs != null) {
    metadata.duration_ms = Math.max(
      0,
      Math.round(endTimeMs - startTimeMs),
    );
  }
  if (run?.error) metadata.run_error_category = "LANGSMITH_RUN_ERROR";
  return metadata;
}

function metadataOnlyRun(run) {
  const safe = {
    id: run.id,
    name: safeString(run.name, 120),
    run_type: safeString(run.run_type, 40),
    start_time: run.start_time,
    end_time: run.end_time,
    parent_run_id: run.parent_run_id,
    trace_id: run.trace_id,
    dotted_order: run.dotted_order,
    session_name: safeString(run.session_name, 120),
    reference_example_id: run.reference_example_id,
    inputs: {},
    extra: { metadata: collectRunMetadata(run) },
    tags: ["memorag"],
  };
  if (Object.hasOwn(run, "outputs")) safe.outputs = {};
  if (run.error) safe.error = "LANGSMITH_RUN_ERROR";
  return Object.fromEntries(
    Object.entries(safe).filter(([, value]) => value !== undefined),
  );
}

function sanitizeRun(run, contentMode) {
  if (contentMode === "metadata_only") return metadataOnlyRun(run);
  const sanitized = redactSensitiveFields(run);
  if (run?.error) sanitized.error = "LANGSMITH_RUN_ERROR";
  return sanitized;
}

class SafeTracingClient {
  constructor(client, contentMode, recordError) {
    this.client = client;
    this.contentMode = contentMode;
    this.recordError = recordError;
  }

  async createRun(run) {
    try {
      await this.client.createRun(sanitizeRun(run, this.contentMode));
    } catch (error) {
      this.recordError("create_run", error);
    }
  }

  async updateRun(runId, run) {
    try {
      await this.client.updateRun(runId, sanitizeRun(run, this.contentMode));
    } catch (error) {
      this.recordError("update_run", error);
    }
  }
}

function normalizeConfig(config = {}) {
  const requested = Boolean(config.requested ?? config.enabled);
  const enabled = Boolean(config.enabled && config.apiKey);
  return {
    requested,
    enabled,
    disabledReason: config.disabledReason
      ?? (requested && !config.apiKey ? "missing_api_key" : null),
    apiKey: String(config.apiKey ?? ""),
    endpoint: config.endpoint || undefined,
    project: String(config.project || "memorag"),
    contentMode: config.contentMode === "full" ? "full" : "metadata_only",
    noteTracingEnabled: Boolean(config.noteTracingEnabled),
  };
}

export function createLangSmithObservability(config = {}, options = {}) {
  const resolved = normalizeConfig(config);
  const errors = [];
  const recordError = (stage, error) => {
    errors.push({
      stage,
      category: safeErrorCategory(error),
    });
  };

  let rawClient = null;
  let client = null;
  let runtimeEnabled = resolved.enabled;
  let runtimeDisabledReason = resolved.disabledReason;
  if (resolved.enabled) {
    try {
      rawClient = options.client ?? new Client({
        apiKey: resolved.apiKey,
        apiUrl: resolved.endpoint,
        hideInputs: resolved.contentMode === "metadata_only",
        hideOutputs: resolved.contentMode === "metadata_only",
        hideMetadata: resolved.contentMode === "metadata_only"
          ? pickSafeMetadata
          : (metadata) => redactSensitiveFields(metadata),
        omitTracedRuntimeInfo: true,
      });
      client = new SafeTracingClient(rawClient, resolved.contentMode, recordError);
    } catch (error) {
      recordError("client_initialization", error);
      runtimeEnabled = false;
      runtimeDisabledReason = "client_initialization_failed";
    }
  }

  const scopeEnabled = (scope) => (
    runtimeEnabled && (scope !== "notes" || resolved.noteTracingEnabled)
  );

  const createInvocation = ({
    scope = "ebook",
    name = "memorag-ebook-rag",
    metadata = {},
  } = {}) => {
    const enabled = scopeEnabled(scope);
    const errorOffset = runtimeDisabledReason === "client_initialization_failed"
      ? 0
      : errors.length;
    let traceId = null;

    return {
      async run(operation) {
        const wrapped = traceable(operation, {
          name,
          run_type: "chain",
          tracingEnabled: enabled,
          ...(enabled ? {
            client,
            project_name: resolved.project,
            metadata: {
              ...pickSafeMetadata(metadata),
              memorag_scope: scope,
              memorag_content_mode: resolved.contentMode,
            },
          } : {}),
          ...(resolved.contentMode === "metadata_only" ? {
            processInputs: () => ({}),
            processOutputs: () => ({}),
          } : {}),
          on_start(runTree) {
            traceId = runTree?.trace_id ?? runTree?.id ?? null;
          },
        });
        return wrapped();
      },

      summary() {
        const invocationErrors = errors.slice(errorOffset);
        return {
          requested: resolved.requested,
          enabled,
          scope,
          contentMode: resolved.contentMode,
          project: enabled ? resolved.project : null,
          traceId: enabled ? traceId : null,
          disabledReason: enabled
            ? null
            : (scope === "notes" && !resolved.noteTracingEnabled
              ? "scope_disabled"
              : runtimeDisabledReason ?? "disabled"),
          errorCount: invocationErrors.length,
          errors: invocationErrors,
        };
      },
    };
  };

  const traceOperation = async (name, operation, metadata = {}, options = {}) => {
    const scope = typeof options === "string"
      ? options
      : String(options.scope ?? "ebook");
    const enabled = scopeEnabled(scope);
    const wrapped = traceable(operation, {
      name,
      run_type: "tool",
      tracingEnabled: enabled,
      ...(enabled ? {
        client,
        project_name: resolved.project,
        metadata: {
          ...pickSafeMetadata(metadata),
          memorag_scope: scope,
          memorag_content_mode: resolved.contentMode,
        },
      } : {}),
    });
    return wrapped();
  };

  return {
    config: {
      requested: resolved.requested,
      enabled: runtimeEnabled,
      project: resolved.project,
      contentMode: resolved.contentMode,
      noteTracingEnabled: resolved.noteTracingEnabled,
      disabledReason: runtimeDisabledReason,
    },
    createInvocation,
    traceOperation,
    async close() {
      if (!runtimeEnabled || typeof rawClient?.awaitPendingTraceBatches !== "function") {
        return;
      }
      try {
        await rawClient.awaitPendingTraceBatches();
      } catch (error) {
        recordError("flush", error);
      }
    },
  };
}

export const langSmithSanitizers = {
  metadataOnlyRun,
  pickSafeMetadata,
  redactSensitiveFields,
};
