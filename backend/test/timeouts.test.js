import test from "node:test";
import assert from "node:assert/strict";
import {
  invokeModelWithTimeout,
  ModelInvocationTimeoutError,
  TIMEOUT_SOURCES,
} from "../src/rag/shared/timeouts.js";

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
