import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginId } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Bounded UI error projections" });
const pageOptions = { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" as const };

suite.define(() => {
  it("reports an ordinary initializer error on a Unicode boundary", (context) =>
    suite.runScenario(context, {
      run: () =>
        suite.withPage(pageOptions, async ({ page }) => {
          const revision = "unicode-boundary";
          const input = `${"x".repeat(511)}😀tail`;
          const gateway = await installMockGateway(page, {
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "plugins.controlUi.list",
              "plugins.controlUi.report",
            ],
            methodResponses: {
              "plugins.controlUi.list": catalog(revision),
              "plugins.controlUi.report": { ok: true },
            },
          });
          await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
            route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: `export default { id: ${JSON.stringify(pluginId)}, activate() { throw new Error(${JSON.stringify(input)}); } };`,
            }),
          );
          expect(
            (
              await page.goto(`${suite.server.baseUrl}plugin?plugin=${pluginId}&id=proof`)
            )?.status(),
          ).toBe(200);
          const report = await gateway.waitForRequest("plugins.controlUi.report");
          const params = report.params as {
            pluginId: string;
            revision: string;
            status: string;
            error: string;
          };
          expect(params.pluginId).toBe(pluginId);
          expect(params.revision).toBe(revision);
          expect(params.status).toBe("failed");
          expect(typeof params.error).toBe("string");
          expect(params.error.length).toBeLessThanOrEqual(512);
          const brokenBoundary = /\p{Surrogate}/u.test(params.error);
          writeFileSync(
            path.join(suite.artifactDir, "observation.json"),
            JSON.stringify(
              {
                surface: "plugin-report",
                input,
                params,
                brokenBoundary,
                pid: process.pid,
                browserVersion: suite.browser.version(),
                requestMethods: (await gateway.getRequests()).map((request) => request.method),
              },
              null,
              2,
            ),
          );
          await page.screenshot({ path: path.join(suite.artifactDir, "projection.png") });
          expect(brokenBoundary).toBe(false);
          expect(params.error).toBe("x".repeat(511));
        }),
    }));

  it("renders a recorded failure cause on a Unicode boundary", (context) =>
    suite.runScenario(context, {
      run: () =>
        suite.withPage(pageOptions, async ({ page }) => {
          const input = `${"x".repeat(179)}😀tail`;
          const config = { update: { auto: { enabled: false }, channel: "stable" } };
          const gateway = await installMockGateway(page, {
            featureMethods: ["config.get", "update.status"],
            methodResponses: {
              "config.get": {
                config,
                hash: "unicode-boundary",
                issues: [],
                raw: JSON.stringify(config),
                runtimeConfig: config,
                valid: true,
              },
              "update.status": {
                sentinel: {
                  kind: "update",
                  status: "error",
                  ts: 1_700_000_000_000,
                  stats: {
                    mode: "package",
                    reason: "build-failed",
                    steps: [{ name: "build", log: { exitCode: 1, stderrTail: input } }],
                  },
                },
              },
            },
            operatorScopes: ["operator.read", "operator.admin"],
          });
          expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
          await gateway.waitForRequest("update.status");
          const status = page
            .locator("#config-section-update .settings-status")
            .filter({ hasText: "x".repeat(179) });
          await status.waitFor();
          const text = (await status.textContent()) ?? "";
          const displayedCause = text.match(/x{2,}/u)?.[0] ?? "";
          expect(displayedCause).toBe("x".repeat(179));
          expect(text).not.toContain("😀tail");
          const brokenBoundary = /[\p{Surrogate}\uFFFD]/u.test(text);
          writeFileSync(
            path.join(suite.artifactDir, "observation.json"),
            JSON.stringify(
              {
                surface: "recorded-update",
                input,
                text,
                displayedCause,
                brokenBoundary,
                pid: process.pid,
                browserVersion: suite.browser.version(),
                requestMethods: (await gateway.getRequests()).map((request) => request.method),
              },
              null,
              2,
            ),
          );
          await page.screenshot({ path: path.join(suite.artifactDir, "projection.png") });
          expect(brokenBoundary).toBe(false);
        }),
    }));
});
