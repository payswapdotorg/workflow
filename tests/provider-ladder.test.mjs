/**
 * Unit tests for the provider ladder (src/lib/provider-ladder.ts) — M8.
 * Run: node --test tests/provider-ladder.test.mjs
 *
 * Pure precedence rules: DB (Settings UI) -> environment (the self-hosted
 * deployment channel) -> built-in Z.ai fallback. A half-configured layer is
 * skipped, never mixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProvider } from "../src/lib/provider-ladder.ts";

const ENV_MODAL = {
  PROVIDER_ENDPOINT: "https://workspace--glm.modal.run/v1",
  PROVIDER_API_KEY: "sk-modal-1",
  PROVIDER_MODEL: "glm-4.7-flash",
};

test("nothing configured -> the built-in fallback (backwards compatible)", () => {
  const r = resolveProvider({}, {});
  assert.deepEqual(r, { custom: false, source: "fallback", endpoint: "", apiKey: "", model: "" });
});

test("env alone (the Modal deployment channel) -> custom, source env", () => {
  const r = resolveProvider({}, ENV_MODAL);
  assert.equal(r.custom, true);
  assert.equal(r.source, "env");
  assert.equal(r.endpoint, "https://workspace--glm.modal.run/v1");
  assert.equal(r.apiKey, "sk-modal-1");
  assert.equal(r.model, "glm-4.7-flash");
});

test("a fully-configured DB row wins over env (the operator's explicit UI choice)", () => {
  const r = resolveProvider(
    { endpoint: "https://api.openai.com/v1", apiKey: "sk-db", model: "gpt-4o-mini" },
    ENV_MODAL
  );
  assert.equal(r.source, "db");
  assert.equal(r.endpoint, "https://api.openai.com/v1");
  assert.equal(r.apiKey, "sk-db");
});

test("a half-configured DB row (endpoint without key) is skipped, not mixed", () => {
  const r = resolveProvider({ endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" }, ENV_MODAL);
  assert.equal(r.source, "env", "must fall through to env, never send unauthenticated requests");
  assert.equal(r.apiKey, "sk-modal-1");
});

test("a half-configured env (key without endpoint) falls back, not half-custom", () => {
  const r = resolveProvider({}, { PROVIDER_API_KEY: "sk-orphan" });
  assert.equal(r.source, "fallback");
  assert.equal(r.custom, false);
});

test("blank/whitespace values count as absent", () => {
  const r = resolveProvider(
    { endpoint: "   ", apiKey: "  " },
    { PROVIDER_ENDPOINT: " ", PROVIDER_API_KEY: "" }
  );
  assert.equal(r.source, "fallback");
});

test("env provider without PROVIDER_MODEL keeps an empty model (client applies its default)", () => {
  const r = resolveProvider({}, { PROVIDER_ENDPOINT: "https://x/v1", PROVIDER_API_KEY: "k" });
  assert.equal(r.source, "env");
  assert.equal(r.model, "");
});

test("DB row model is carried through when DB wins", () => {
  const r = resolveProvider({ endpoint: "https://a/v1", apiKey: "k", model: " my-model " }, ENV_MODAL);
  assert.equal(r.source, "db");
  assert.equal(r.model, "my-model", "trimmed");
});
