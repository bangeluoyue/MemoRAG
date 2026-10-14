export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_AGENT_TIMEOUT_MS = 120_000;
export const TIMEOUT_SOURCES = Object.freeze({
  APPLICATION: "application",
  SDK_OR_UPSTREAM: "sdk_or_upstream",
});

class RagTimeoutError extends Error {
  constructor(name, code, stage, timeoutMs, {
    timeoutSource = TIMEOUT_SOURCES.APPLICATION,
  } = {}) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = name;
    this.code = code;
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.timeoutSource = timeoutSource;
  }
}

export class ModelInvocationTimeoutError extends RagTimeoutError {
  constructor(stage, timeoutMs, options) {
    super(
      "ModelInvocationTimeoutError",
      "MODEL_TIMEOUT",
      stage,
      timeoutMs,
      options,
    );
  }
}

export class AgentInvocationTimeoutError extends RagTimeoutError {
  constructor(timeoutMs) {
    super("AgentInvocationTimeoutError", "AGENT_TIMEOUT", "agent", timeoutMs);
  }
}

export function isRagTimeoutError(error) {
  return error instanceof ModelInvocationTimeoutError
    || error instanceof AgentInvocationTimeoutError;
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.floor(number)
    : fallback;
}

function isSdkOrUpstreamModelTimeout(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return false;
  }

  // @langchain/openai 1.6.x converts OpenAI's APIConnectionTimeoutError into
  // an Error named TimeoutError. Keep the raw SDK class name too so this
  // wrapper remains correct when used around an unwrapped OpenAI runnable.
  return error.name === "TimeoutError"
    || error.constructor?.name === "APIConnectionTimeoutError";
}

async function runWithTimeout(task, {
  timeoutMs,
  fallbackTimeoutMs,
  createError,
  parentSignal,
}) {
  const limit = positiveTimeout(timeoutMs, fallbackTimeoutMs);
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  const timeoutError = createError(limit);
  let timer;
  let abortListener;
  let timedOut = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, limit);
  });
  const parentAbortPromise = parentSignal
    ? new Promise((_, reject) => {
      abortListener = () => reject(
        parentSignal.reason ?? new Error("Invocation aborted"),
      );
      if (parentSignal.aborted) abortListener();
      else parentSignal.addEventListener("abort", abortListener, { once: true });
    })
    : null;

  try {
    return await Promise.race([
      Promise.resolve().then(() => task(signal)),
      timeoutPromise,
      ...(parentAbortPromise ? [parentAbortPromise] : []),
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    if (parentSignal?.aborted) {
      throw parentSignal.reason ?? error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortListener) parentSignal.removeEventListener("abort", abortListener);
  }
}

export async function invokeModelWithTimeout(runnable, input, {
  stage,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  signal,
} = {}) {
  const resolvedStage = stage ?? "model";
  const limit = positiveTimeout(timeoutMs, DEFAULT_LLM_TIMEOUT_MS);

  try {
    return await runWithTimeout(
      (invocationSignal) => runnable.invoke(input, { signal: invocationSignal }),
      {
        timeoutMs: limit,
        fallbackTimeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        createError: (applicationLimit) => new ModelInvocationTimeoutError(
          resolvedStage,
          applicationLimit,
        ),
        parentSignal: signal,
      },
    );
  } catch (error) {
    if (isRagTimeoutError(error) || !isSdkOrUpstreamModelTimeout(error)) {
      throw error;
    }
    throw new ModelInvocationTimeoutError(resolvedStage, limit, {
      timeoutSource: TIMEOUT_SOURCES.SDK_OR_UPSTREAM,
    });
  }
}

export function invokeAgentWithTimeout(graph, input, invocationConfig, {
  timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
} = {}) {
  return runWithTimeout(
    (signal) => graph.invoke(input, { ...invocationConfig, signal }),
    {
      timeoutMs,
      fallbackTimeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      createError: (limit) => new AgentInvocationTimeoutError(limit),
    },
  );
}
