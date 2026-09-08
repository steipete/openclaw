import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveGatewayPort } from "../../src/config/paths.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayUrlOverride } from "../../src/gateway/client-bootstrap.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { runQaGatewayFixture } from "./qa-gateway-cleanup.js";

type EndpointEnv = {
  OPENCLAW_GATEWAY_PORT?: string;
  OPENCLAW_GATEWAY_URL?: string;
};
const port = 19701;
const inheritedUrl = "wss://inherited.fixture.invalid";
const explicitUrl = "wss://explicit.fixture.invalid";
const cases: Array<{
  name: string;
  inherited: EndpointEnv;
  explicit?: EndpointEnv;
  expected: { port: number; override: { url?: string; source?: "env" } };
}> = [
  { name: "clean environment", inherited: {}, expected: { port, override: {} } },
  {
    name: "inherited port",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702" },
    expected: { port, override: {} },
  },
  {
    name: "inherited URL",
    inherited: { OPENCLAW_GATEWAY_URL: inheritedUrl },
    expected: { port, override: {} },
  },
  {
    name: "explicit options.env",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: "19704", OPENCLAW_GATEWAY_URL: explicitUrl },
    expected: { port: 19704, override: { url: explicitUrl, source: "env" } },
  },
  {
    name: "explicit undefined deletion",
    inherited: { OPENCLAW_GATEWAY_PORT: "19702", OPENCLAW_GATEWAY_URL: inheritedUrl },
    explicit: { OPENCLAW_GATEWAY_PORT: undefined, OPENCLAW_GATEWAY_URL: undefined },
    expected: { port, override: {} },
  },
];
const readParentEndpoints = (): EndpointEnv => ({
  OPENCLAW_GATEWAY_PORT: process.env.OPENCLAW_GATEWAY_PORT,
  OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL,
});

describe("test instance endpoint isolation", () => {
  it.each(cases)("preserves endpoint ownership with $name", async (scenario) => {
    const parent = readParentEndpoints();
    const inherited = {
      OPENCLAW_GATEWAY_PORT: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      ...scenario.inherited,
    };
    await runQaGatewayFixture(
      () =>
        withEnvAsync(inherited, async () => {
          // A supplied port skips reservation; this test never starts a child or listener.
          const instance = await createOpenClawTestInstance({
            name: "endpoint-isolation",
            port,
            env: { ...scenario.explicit, OPENCLAW_SKIP_CRON: "0" },
          });
          await runQaGatewayFixture(
            async () => {
              const config: OpenClawConfig = JSON.parse(
                await fs.readFile(instance.configPath, "utf8"),
              );
              expect(config.gateway?.port).toBe(instance.port);
              expect(instance.child).toBeUndefined();
              expect(instance.env.OPENCLAW_SKIP_CRON).toBe("0");
              for (const [key, value] of Object.entries(scenario.explicit ?? {})) {
                if (value === undefined) {
                  expect(Object.hasOwn(instance.env, key)).toBe(false);
                } else {
                  expect(instance.env[key]).toBe(value);
                }
              }
              expect(readParentEndpoints()).toEqual(inherited);
              expect(
                resolveGatewayUrlOverride({ env: instance.env, gatewayUrl: explicitUrl }),
              ).toEqual({ url: explicitUrl, source: "cli" });
              expect(
                resolveGatewayUrlOverride({ env: instance.env, localPortOverride: 19705 }),
              ).toEqual({});
              const actual = {
                port: resolveGatewayPort(config, instance.env),
                override: resolveGatewayUrlOverride({ env: instance.env }),
              };
              expect(actual, `FIXTURE_ENDPOINT_ISOLATION ${JSON.stringify(actual)}`).toEqual(
                scenario.expected,
              );
            },
            async () => {
              await instance.cleanup();
              await expect(fs.stat(instance.state.root)).rejects.toMatchObject({ code: "ENOENT" });
            },
          );
        }),
      async () => {
        expect(readParentEndpoints()).toEqual(parent);
      },
    );
  });
});
