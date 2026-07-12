import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSandboxBundleCapabilities,
  assertSandboxBundleCapabilityHooks,
  SANDBOX_BUNDLE_CAPABILITIES,
  SANDBOX_BUNDLE_CAPABILITY_HOOKS,
} from "./sandbox-bundle-capabilities.mjs";

test("publishes both cron contracts in the exact sandbox capability set", () => {
  assert.deepEqual(SANDBOX_BUNDLE_CAPABILITIES, [
    "admin-http-rpc-v1",
    "cron-projection-v1",
    "cron-projection-v2",
    "gateway-suspend-v1",
    "telegram-durable-ack-v1",
  ]);
  assert.deepEqual(SANDBOX_BUNDLE_CAPABILITY_HOOKS, {
    "cron-projection-v1": ["gateway_start"],
    "cron-projection-v2": ["cron_reconciled"],
  });
  assert.deepEqual(
    assertSandboxBundleCapabilities([...SANDBOX_BUNDLE_CAPABILITIES].reverse(), "fixture"),
    SANDBOX_BUNDLE_CAPABILITIES,
  );
  assert.throws(
    () =>
      assertSandboxBundleCapabilities(
        SANDBOX_BUNDLE_CAPABILITIES.filter((entry) => entry !== "cron-projection-v2"),
        "fixture",
      ),
    /fixture capabilities must be exactly/u,
  );
  assert.throws(
    () => assertSandboxBundleCapabilities("cron-projection-v2", "fixture"),
    /fixture capabilities must be exactly/u,
  );
});

test("keeps v1 on gateway_start and requires cron_reconciled for v2", () => {
  assert.doesNotThrow(() =>
    assertSandboxBundleCapabilityHooks({
      capabilities: ["cron-projection-v1"],
      bundleSource: "gateway_start",
      label: "fixture",
    }),
  );
  assert.throws(
    () =>
      assertSandboxBundleCapabilityHooks({
        capabilities: ["cron-projection-v1"],
        bundleSource: "cron_reconciled",
        label: "fixture",
      }),
    /cannot publish cron-projection-v1: bundle lacks gateway_start/u,
  );
  assert.throws(
    () =>
      assertSandboxBundleCapabilityHooks({
        capabilities: ["cron-projection-v2"],
        bundleSource: "gateway_start cron_changed",
        label: "fixture",
      }),
    /cannot publish cron-projection-v2: bundle lacks cron_reconciled/u,
  );
  assert.doesNotThrow(() =>
    assertSandboxBundleCapabilityHooks({
      capabilities: ["cron-projection-v1", "cron-projection-v2"],
      bundleSource: "gateway_start cron_reconciled",
      label: "fixture",
    }),
  );
});
