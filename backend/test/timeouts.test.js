import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentInvocationTimeoutError,
  invokeRagWithTimeout,
  invokeModelWithTimeout,
  ModelInvocationTimeoutError,
  TIMEOUT_SOURCES,
} from "../src/rag/shared/timeouts.js";

test("invokeRagWithTimeout returns successful operations unchanged", async () => {
  const result = await invokeRagWithTimeout(async (signal) => {
    assert.equal(signal.aborted, false);
    return { ok: true };
  }, { timeoutMs: 50 });
  assert.deepEqual(result, { ok: true });
});

test("invokeRagWithTimeout aborts and classifies the whole request deadline", async () => {
  let operationSignal;
  await assert.rejects(
    () => invokeRagWithTimeout(
      async (signal) => new Promise((_, reject) => {
        operationSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
      { timeoutMs: 10 },
    ),
    (error) => error instanceof AgentInvocationTimeoutError
      && error.code === "AGENT_TIMEOUT"
      && error.timeoutMs === 10,
  );
  assert.equal(operationSignal.aborted, true);
});

function rejectingRunnable(error) {
  return {
    async invoke() {
      throw error;
    },
  };
}

test("raw OpenAI APIConnectionTimeoutError is normalized without its message", async () => {
  class APIConnectionTimeoutError extends Error {}
  const upstreamError = new APIConnectionTimeoutError(
    "sensitive endpoint timed out",
  );

  await assert.rejects(
    () => invokeModelWithTimeout(rejectingRunnable(upstreamError), "input", {
      stage: "route",
      timeoutMs: 60_000,
    }),
    (error) => error instanceof ModelInvocationTimeoutError
      && error.stage === "route"
      && error.timeoutSource === TIMEOUT_SOURCES.SDK_OR_UPSTREAM
      && !error.message.includes("sensitive"),
  );
});

for (const name of [
  "APIConnectionError",
  "AuthenticationError",
  "RateLimitError",
]) {
  test(`${name} is not misclassified as a model timeout`, async () => {
    const upstreamError = new Error("sensitive non-timeout failure");
    upstreamError.name = name;

    await assert.rejects(
      () => invokeModelWithTimeout(rejectingRunnable(upstreamError), "input", {
        stage: "generate",
        timeoutMs: 60_000,
      }),
      (error) => error === upstreamError,
    );
  });
}
