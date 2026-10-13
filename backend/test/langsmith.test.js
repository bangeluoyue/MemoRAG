import test from "node:test";
import assert from "node:assert/strict";
import {
  createLangSmithObservability,
  langSmithSanitizers,
} from "../src/observability/langsmith.js";

class MemoryTracingClient {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.calls = [];
  }

  async createRun(run) {
    if (this.fail) throw new TypeError("PRIVATE_CLIENT_FAILURE_DETAIL");
    this.calls.push({ operation: "create", run });
  }

  async updateRun(runId, run) {
    if (this.fail) throw new TypeError("PRIVATE_CLIENT_FAILURE_DETAIL");
    this.calls.push({ operation: "update", runId, run });
  }
}

function enabledConfig(overrides = {}) {
  return {
    requested: true,
    enabled: true,
    apiKey: "PRIVATE_LANGSMITH_KEY",
    project: "memorag-test",
    contentMode: "metadata_only",
    noteTracingEnabled: false,
    ...overrides,
  };
}

test("metadata_only traces contain only safe metadata", async () => {
  const client = new MemoryTracingClient();
  const observability = createLangSmithObservability(
    enabledConfig(),
    { client },
  );
  const invocation = observability.createInvocation({
    metadata: { knowledge_base: "ebook" },
  });

  const result = await invocation.run(async () => ({
    content: "PRIVATE_DOCUMENT_SENTINEL",
    apiKey: "PRIVATE_PAYLOAD_KEY",
  }));

  assert.equal(result.content, "PRIVATE_DOCUMENT_SENTINEL");
  assert.ok(client.calls.length >= 2);
  assert.equal(
    JSON.stringify(client.calls).includes("PRIVATE_DOCUMENT_SENTINEL"),
    false,
  );
  assert.equal(JSON.stringify(client.calls).includes("PRIVATE_PAYLOAD_KEY"), false);
  assert.equal(JSON.stringify(client.calls).includes("PRIVATE_LANGSMITH_KEY"), false);
  for (const { run } of client.calls) {
    assert.deepEqual(run.inputs, {});
    if (Object.hasOwn(run, "outputs")) assert.deepEqual(run.outputs, {});
    assert.equal("content" in (run.extra?.metadata ?? {}), false);
  }
  assert.equal(invocation.summary().enabled, true);
  assert.ok(invocation.summary().traceId);
});

test("disabled application tracing overrides externally enabled tracing flags", async () => {
  const names = [
    "LANGSMITH_TRACING",
    "LANGSMITH_TRACING_V2",
    "LANGCHAIN_TRACING",
    "LANGCHAIN_TRACING_V2",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "true";

  try {
    const client = new MemoryTracingClient();
    const observability = createLangSmithObservability(
      { requested: false, enabled: false },
      { client },
    );
    const invocation = observability.createInvocation();
    const result = await invocation.run(async () => "ok");

    assert.equal(result, "ok");
    assert.equal(client.calls.length, 0);
    assert.equal(invocation.summary().enabled, false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("notes tracing stays disabled without its independent opt-in", async () => {
  const client = new MemoryTracingClient();
  const observability = createLangSmithObservability(
    enabledConfig({ noteTracingEnabled: false }),
    { client },
  );
  const invocation = observability.createInvocation({ scope: "notes" });

  assert.equal(await invocation.run(async () => "notes-ok"), "notes-ok");
  assert.equal(client.calls.length, 0);
  assert.equal(invocation.summary().disabledReason, "scope_disabled");

  const optedInClient = new MemoryTracingClient();
  const optedIn = createLangSmithObservability(
    enabledConfig({ noteTracingEnabled: true }),
    { client: optedInClient },
  ).createInvocation({ scope: "notes" });
  assert.equal(await optedIn.run(async () => "notes-opted-in"), "notes-opted-in");
  assert.ok(optedInClient.calls.length >= 2);
  assert.equal(optedIn.summary().enabled, true);
});

test("LangSmith client failures do not affect the wrapped operation", async () => {
  const client = new MemoryTracingClient({ fail: true });
  const observability = createLangSmithObservability(
    enabledConfig(),
    { client },
  );
  const invocation = observability.createInvocation();

  assert.deepEqual(
    await invocation.run(async () => ({ answer: "normal-result" })),
    { answer: "normal-result" },
  );
  assert.ok(invocation.summary().errorCount >= 1);
  assert.deepEqual(
    [...new Set(invocation.summary().errors.map((item) => item.category))],
    ["TypeError"],
  );
  assert.equal(
    JSON.stringify(invocation.summary()).includes("PRIVATE_CLIENT_FAILURE_DETAIL"),
    false,
  );
});

test("full mode keeps content but recursively redacts secret-bearing fields", () => {
  const sanitized = langSmithSanitizers.redactSensitiveFields({
    content: "visible-in-explicit-full-mode",
    apiKey: "PRIVATE_API_KEY",
    nested: {
      Authorization: "Bearer PRIVATE_TOKEN",
      value: "safe",
    },
  });

  assert.equal(sanitized.content, "visible-in-explicit-full-mode");
  assert.equal(sanitized.apiKey, "[REDACTED]");
  assert.equal(sanitized.nested.Authorization, "[REDACTED]");
  assert.equal(sanitized.nested.value, "safe");
});
