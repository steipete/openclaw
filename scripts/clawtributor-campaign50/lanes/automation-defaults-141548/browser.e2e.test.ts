import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
import dataJson from "./fixtures/automation-141548/data.json";
import type { Callback, ProofData, Snapshot } from "./fixtures/automation-141548/types.ts";

const data: ProofData = dataJson;
const suite = createControlUiE2eSuite({
  name: "Automation defaults 141548",
  startServerBeforeBrowser: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
type Display =
  | { kind: "select"; label: string; options: string[] }
  | { kind: "switch"; checked: boolean };
function rows(page: Page): [Locator, Locator] {
  const trigger = page.locator("details.cfg-object").filter({
    has: page.locator(":scope > summary .settings-row__title").filter({ hasText: /^Triggers$/ }),
  });
  return [
    page.locator(".settings-row").filter({
      has: page
        .locator(":scope > .settings-row__text > .settings-row__title")
        .filter({ hasText: /^Automations Enabled$/ }),
    }),
    trigger
      .locator(".settings-subrows > .settings-row")
      .filter({ has: page.locator(".settings-row__title").filter({ hasText: /^Enabled$/ }) }),
  ];
}
async function display(row: Locator): Promise<Display> {
  expect(await row.count()).toBe(1);
  await row.waitFor({ state: "visible" });
  return await row.evaluate((element) => {
    const select = element.querySelector("select");
    if (select) {
      return {
        kind: "select" as const,
        label: select.selectedOptions[0].textContent?.trim() ?? "",
        options: [...select.options].map((option) => option.textContent?.trim() ?? ""),
      };
    }
    const toggle = element.querySelector("wa-switch");
    if (!toggle || !("checked" in toggle) || typeof toggle.checked !== "boolean") {
      throw new Error("Expected an initialized boolean form control");
    }
    return { kind: "switch" as const, checked: toggle.checked };
  });
}
function assertUnchanged(snapshot: Snapshot, config: Record<string, unknown>) {
  expect(snapshot.callbacks).toEqual([]);
  expect(snapshot.dirty).toBe(false);
  expect(snapshot.form).toEqual(config);
  expect(snapshot.original).toEqual(config);
  expect(snapshot.sourceConfig).toEqual(config);
  expect(JSON.parse(snapshot.serialized)).toEqual(config);
  for (const raw of [
    snapshot.raw,
    snapshot.rawOriginal,
    snapshot.snapshotRaw,
    snapshot.serialized,
  ]) {
    expect(raw).toBe(JSON.stringify(config));
  }
}
const inherited = { kind: "select", label: "Default: On", options: ["Default: On", "On", "Off"] };

suite.define(() => {
  for (const fixture of data.fixtures) {
    it(
      fixture.id,
      async (testContext) => {
        await suite.runScenario(testContext, {
          run: async () => {
            const artifactDir = suite.artifactDir;
            const browserErrors: string[] = [];
            const nonReadRequests: string[] = [];
            const stages: Array<{ name: string; snapshot: Snapshot; displays: Display[] }> = [];
            await suite.withPage(
              {
                ...createControlUiE2eContextOptions(),
                recordVideo: { dir: artifactDir, size: { width: 1280, height: 900 } },
              },
              async ({ page }) => {
                page.on("pageerror", (error) => browserErrors.push(String(error)));
                page.on("console", (message) => {
                  if (message.type() === "error") browserErrors.push(message.text());
                });
                page.on("request", (request) => {
                  if (!["GET", "HEAD"].includes(request.method()))
                    nonReadRequests.push(`${request.method()} ${request.url()}`);
                });
                try {
                  await page.goto(
                    `${suite.server.baseUrl}automation-defaults-141548.html?case=${fixture.id}`,
                  );
                  await page.waitForFunction(() => window.automationDefaultsProof?.ready === true);
                  await page.evaluate(() => customElements.whenDefined("wa-switch"));
                  const controls = rows(page);
                  const initial = await page.evaluate(() =>
                    window.automationDefaultsProof.snapshot(),
                  );
                  const initialDisplays = await Promise.all(controls.map(display));
                  stages.push({ name: "initial", snapshot: initial, displays: initialDisplays });
                  for (const [index, control] of controls.entries()) {
                    await control.scrollIntoViewIfNeeded();
                    await page.screenshot({
                      path: path.join(artifactDir, `initial-${index}.png`),
                      fullPage: false,
                    });
                  }
                  assertUnchanged(initial, fixture.config);
                  expect(browserErrors).toEqual([]);
                  expect(nonReadRequests).toEqual([]);
                  if (fixture.expected === "On" || fixture.expected === "Off") {
                    const wanted = fixture.expected === "On";
                    expect(
                      initialDisplays.map((value) =>
                        value.kind === "switch"
                          ? value.checked
                          : value.label === "On"
                            ? true
                            : value.label === "Off"
                              ? false
                              : null,
                      ),
                    ).toEqual([wanted, wanted]);
                    return;
                  }
                  expect(initialDisplays, `C141548_DEFAULT_DISPLAY:${fixture.id}`).toEqual([
                    inherited,
                    inherited,
                  ]);
                  if (fixture.id !== "roundtrip") return;
                  const expectedConfig: {
                    cron: {
                      skipMissedJobs: boolean;
                      sessionRetention: string;
                      triggers: { enabled?: boolean };
                      enabled?: boolean;
                    };
                  } = { cron: { skipMissedJobs: true, sessionRetention: "36h", triggers: {} } };
                  const expectedCallbacks: Callback[] = [];
                  for (const field of [0, 1] as const) {
                    for (const label of ["On", "Off", "Default: On"]) {
                      const fieldPath =
                        field === 0 ? ["cron", "enabled"] : ["cron", "triggers", "enabled"];
                      const holder =
                        field === 0 ? expectedConfig.cron : expectedConfig.cron.triggers;
                      if (label === "Default: On") {
                        delete holder.enabled;
                        expectedCallbacks.push({ kind: "remove", path: fieldPath });
                      } else {
                        holder.enabled = label === "On";
                        expectedCallbacks.push({
                          kind: "patch",
                          path: fieldPath,
                          value: holder.enabled,
                        });
                      }
                      await rows(page)[field].locator("select").selectOption({ label });
                      await expect
                        .poll(
                          async () =>
                            (await page.evaluate(() => window.automationDefaultsProof.snapshot()))
                              .callbacks.length,
                        )
                        .toBe(expectedCallbacks.length);
                      const current = await page.evaluate(() =>
                        window.automationDefaultsProof.snapshot(),
                      );
                      const currentDisplays = await Promise.all(rows(page).map(display));
                      stages.push({
                        name: `${field}-${label}`,
                        snapshot: current,
                        displays: currentDisplays,
                      });
                      expect(current.callbacks).toEqual(expectedCallbacks);
                      expect(current.form).toEqual(expectedConfig);
                      expect(JSON.parse(current.serialized)).toEqual(expectedConfig);
                      expect(current.original).toEqual(fixture.config);
                      expect(current.sourceConfig).toEqual(fixture.config);
                      expect(current.dirty).toBe(label !== "Default: On");
                      expect(currentDisplays[field]).toEqual({ ...inherited, label });
                      await rows(page)[field].scrollIntoViewIfNeeded();
                      await page.screenshot({
                        path: path.join(
                          artifactDir,
                          `choice-${field}-${expectedCallbacks.length}.png`,
                        ),
                        fullPage: false,
                      });
                    }
                  }
                  const reloaded = await page.evaluate(() =>
                    window.automationDefaultsProof.reloadSerialized(),
                  );
                  const reloadedDisplays = await Promise.all(rows(page).map(display));
                  stages.push({ name: "reloaded", snapshot: reloaded, displays: reloadedDisplays });
                  expect(reloaded.callbacks).toEqual(expectedCallbacks);
                  expect(reloaded.dirty).toBe(false);
                  expect(reloaded.form).toEqual(fixture.config);
                  expect(reloaded.original).toEqual(fixture.config);
                  expect(reloaded.sourceConfig).toEqual(fixture.config);
                  expect(JSON.parse(reloaded.serialized)).toEqual(fixture.config);
                  expect(reloadedDisplays).toEqual([inherited, inherited]);
                  await rows(page)[1].scrollIntoViewIfNeeded();
                  await page.screenshot({
                    path: path.join(artifactDir, "reloaded.png"),
                    fullPage: false,
                  });
                } finally {
                  const final = await page.evaluate(() =>
                    window.automationDefaultsProof.snapshot(),
                  );
                  await writeFile(
                    path.join(artifactDir, "receipt.json"),
                    `${JSON.stringify({ source: data.source, id: fixture.id, fixture: fixture.config, browserErrors, nonReadRequests, stages, final }, null, 2)}\n`,
                  );
                  if (stages.length === 1) assertUnchanged(final, fixture.config);
                  else expect(final).toEqual(stages.at(-1)?.snapshot);
                  expect(browserErrors).toEqual([]);
                  expect(nonReadRequests).toEqual([]);
                }
              },
            );
          },
        });
      },
      60_000,
    );
  }
});
