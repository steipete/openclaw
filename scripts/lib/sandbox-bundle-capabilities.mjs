export const SANDBOX_BUNDLE_CAPABILITIES = Object.freeze([
  "admin-http-rpc-v1",
  "cron-projection-v1",
  "cron-projection-v2",
  "gateway-suspend-v1",
  "telegram-durable-ack-v1",
]);

// v1 remains the rollback contract. v2 attests the complete scheduler snapshot
// hook, so a bundle must not claim it from cron_changed or gateway_start alone.
export const SANDBOX_BUNDLE_CAPABILITY_HOOKS = Object.freeze({
  "cron-projection-v1": Object.freeze(["gateway_start"]),
  "cron-projection-v2": Object.freeze(["cron_reconciled"]),
});

export function assertSandboxBundleCapabilities(capabilities, label) {
  if (!Array.isArray(capabilities)) {
    throw new Error(
      `${label} capabilities must be exactly: ${SANDBOX_BUNDLE_CAPABILITIES.join(", ")}`,
    );
  }
  const normalized = [...new Set(capabilities ?? [])].toSorted((left, right) =>
    left.localeCompare(right),
  );
  if (
    normalized.length !== capabilities.length ||
    JSON.stringify(normalized) !== JSON.stringify(SANDBOX_BUNDLE_CAPABILITIES)
  ) {
    throw new Error(
      `${label} capabilities must be exactly: ${SANDBOX_BUNDLE_CAPABILITIES.join(", ")}`,
    );
  }
  return normalized;
}

export function assertSandboxBundleCapabilityHooks({ capabilities, bundleSource, label }) {
  for (const [capability, hookNames] of Object.entries(SANDBOX_BUNDLE_CAPABILITY_HOOKS)) {
    if (!capabilities.includes(capability)) {
      continue;
    }
    for (const hookName of hookNames) {
      if (!bundleSource.includes(hookName)) {
        throw new Error(`${label} cannot publish ${capability}: bundle lacks ${hookName}`);
      }
    }
  }
}
