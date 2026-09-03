import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import copy from "./memory-import-copy.proof.json";

const suite = createControlUiE2eSuite({
  name: "Cold Memory Import translation proof",
  startServerBeforeBrowser: true,
});

type Locale = "en" | "de";
type CopyKey = keyof typeof copy.en;

function text(locale: Locale, key: CopyKey, params: Record<string, string> = {}) {
  return copy[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}

const plan = {
  agentId: "research",
  workspace: "/tmp/openclaw-research",
  providers: [
    {
      providerId: "codex",
      label: "Codex",
      description: "Import Codex memory.",
      planFingerprint: "a".repeat(64),
      found: true,
      source: "/tmp/codex",
      target: "/tmp/openclaw-research",
      summary: {
        total: 1,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "memory:codex:MEMORY.md",
          status: "planned",
          source: "/tmp/codex/MEMORY.md",
          target: "/tmp/openclaw-research/memory/imports/codex/MEMORY.md",
          details: { collectionId: "codex", collectionLabel: "Codex", relativePath: "MEMORY.md" },
        },
      ],
    },
  ],
};

async function visible(locator: Locator) {
  await expect.poll(() => locator.isVisible()).toBe(true);
}

async function visibleCopy(locator: Locator, expected: string) {
  await visible(locator);
  await expect.poll(async () => (await locator.textContent())?.trim()).toBe(expected);
}

async function prove(
  name: string,
  locale: Locale,
  route: string,
  admin: boolean,
  scenario: (
    page: Page,
    gateway: MockGatewayControls,
    screenshot: (name: string) => Promise<void>,
  ) => Promise<void>,
) {
  const artifactDir = suite.artifactDir;
  const pageErrors: string[] = [];
  const loadedAssets: Array<{ path: string; status: number }> = [];
  const captures: Array<{ file: string; sha256: string }> = [];
  const report: Record<string, unknown> = {
    name,
    locale,
    route,
    admin,
    completed: false,
    contextClosed: false,
    evidenceKind: "mocked Gateway, existing bundled UI E2E server",
    pageErrors,
    loadedAssets,
    captures,
  };
  try {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: locale === "de" ? "de-DE" : "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page, context }) => {
        context.on("close", () => {
          report.contextClosed = true;
        });
        page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 2000)));
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (
            url.origin === new URL(suite.server.baseUrl).origin &&
            url.pathname.includes("/assets/")
          ) {
            loadedAssets.push({ path: url.pathname, status: response.status() });
          }
        });
        await page.addInitScript((selectedLocale) => {
          localStorage.setItem("openclaw.i18n.locale", selectedLocale);
        }, locale);
        const config = { plugins: { slots: { memory: "memory-core" } } };
        const gateway = await installMockGateway(page, {
          defaultAgentId: "research",
          assistantAgentId: "research",
          operatorScopes: admin
            ? ["operator.admin", "operator.read", "operator.write"]
            : ["operator.read", "operator.write"],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "migrations.memory.plan",
            "migrations.memory.apply",
            "memory.sessionBackfill.preview",
          ],
          methodResponses: {
            "config.get": {
              config,
              hash: "memory-copy-proof",
              appliedConfigHash: "memory-copy-proof",
              issues: [],
              raw: JSON.stringify(config),
              valid: true,
            },
            "plugins.list": {
              plugins: [
                {
                  id: "memory-core",
                  name: "memory-core",
                  installed: true,
                  enabled: true,
                  state: "enabled",
                  kind: ["memory"],
                },
              ],
              diagnostics: [],
              mutationAllowed: admin,
            },
            "migrations.memory.plan": plan,
          },
        });
        report.phase = "navigate";
        const response = await page.goto(`${suite.server.baseUrl}${route}`);
        expect(response?.status()).toBe(200);
        if (!response) {
          throw new Error("Expected the bundled UI document response");
        }
        const index = await response.body();
        writeFileSync(path.join(artifactDir, "served-index.html"), index);
        report.indexSha256 = createHash("sha256").update(index).digest("hex");
        await expect.poll(() => page.locator("html").getAttribute("lang")).toBe(locale);
        const screenshot = async (file: string) => {
          report.phase = file;
          const bytes = await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(artifactDir, file),
          });
          captures.push({ file, sha256: createHash("sha256").update(bytes).digest("hex") });
        };
        report.phase = "visible-contract";
        try {
          await scenario(page, gateway, screenshot);
          for (const method of [
            "migrations.memory.apply",
            "memory.sessionBackfill.apply",
            "memory.sessionBackfill.rollback",
            "config.set",
            "plugins.setEnabled",
          ]) {
            expect(
              await gateway.getRequests(method),
              `${name}: unexpected mutation ${method}`,
            ).toHaveLength(0);
          }
          expect(pageErrors).toEqual([]);
          expect(loadedAssets.length).toBeGreaterThan(0);
          expect(loadedAssets.every((asset) => asset.status === 200)).toBe(true);
        } finally {
          const requests = await gateway.getRequests();
          expect(requests.length).toBeLessThan(1000);
          report.requestCounts = Object.fromEntries(
            [...new Set(requests.map((request) => request.method))].map((method) => [
              method,
              requests.filter((request) => request.method === method).length,
            ]),
          );
          report.memoryRequests = requests.filter(
            (request) =>
              request.method.startsWith("migrations.memory.") ||
              request.method.startsWith("memory.sessionBackfill."),
          );
        }
      },
    );
    report.contextClosed = true;
    report.completed = true;
    report.phase = "complete";
  } catch (error) {
    report.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    writeFileSync(path.join(artifactDir, "verdict.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
}

async function importFlow(
  page: Page,
  gateway: MockGatewayControls,
  screenshot: (name: string) => Promise<void>,
  locale: Locale,
) {
  const body = page.locator('[data-test-id="memory-import-page"]');
  for (const key of [
    "memoryImport.title",
    "memoryImport.subtitle",
    "memoryImport.backfill.title",
  ] as const) {
    await visible(body.getByText(text(locale, key), { exact: true }));
  }
  await visibleCopy(
    body
      .locator(".settings-row__title")
      .filter({ hasText: text(locale, "memoryImport.replaceExisting") }),
    text(locale, "memoryImport.replaceExisting"),
  );
  await visible(
    body.getByRole("switch", { name: text(locale, "memoryImport.replaceExisting"), exact: true }),
  );
  const dates = body.locator(".memory-import__backfill-dates");
  await visible(dates.getByLabel(text(locale, "memoryImport.backfill.from"), { exact: true }));
  await visible(dates.getByLabel(text(locale, "memoryImport.backfill.to"), { exact: true }));
  await visible(
    body.getByText(text(locale, "memoryImport.selectedCount", { count: "1" }), { exact: true }),
  );
  const requests = await gateway.getRequests("migrations.memory.plan");
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.params).toEqual({ agentId: "research", overwrite: false });
  }
  await screenshot("01-import-ready.png");
  await body
    .getByRole("button", { name: text(locale, "memoryImport.importSelected"), exact: true })
    .click();
  const dialog = page.locator("openclaw-modal-dialog");
  await visibleCopy(
    dialog.locator(".exec-approval-title"),
    text(locale, "memoryImport.confirmTitle", { provider: "Codex" }),
  );
  await visibleCopy(
    dialog.locator(".exec-approval-sub"),
    text(locale, "memoryImport.confirmDescription", { count: "1" }),
  );
  await visible(dialog.getByText(text(locale, "memoryImport.confirmBackup"), { exact: true }));
  await visible(
    dialog.getByRole("button", { name: text(locale, "memoryImport.confirmImport"), exact: true }),
  );
  await screenshot("02-import-confirmation.png");
  await dialog.getByRole("button", { name: text(locale, "common.cancel"), exact: true }).click();
  await expect.poll(() => dialog.count()).toBe(0);
}

suite.define(() => {
  it("cold Settings Memory renders its import section", async () => {
    await prove(
      "settings-en",
      "en",
      "settings/memory/settings",
      true,
      async (page, gateway, screenshot) => {
        const link = page.getByRole("link", { name: "Open Memory Import", exact: true });
        await visible(link);
        expect(await link.getAttribute("href")).toBe("/memory-import");
        const section = page.locator(".settings-section").filter({ has: link });
        await visible(section.getByText("Import Memory", { exact: true }));
        await visible(
          section.getByText("Bring Codex and Claude Code memory into an agent workspace.", {
            exact: true,
          }),
        );
        expect(await gateway.getRequests("migrations.memory.plan")).toHaveLength(0);
        await link.scrollIntoViewIfNeeded();
        await screenshot("01-settings-memory-import.png");
      },
    );
  });

  it("cold Memory Import renders English planning and confirmation copy", async () => {
    await prove("import-en", "en", "memory-import", true, (page, gateway, screenshot) =>
      importFlow(page, gateway, screenshot, "en"),
    );
  });

  it("cold Memory Import renders the non-admin denial", async () => {
    await prove("denial-en", "en", "memory-import", false, async (page, gateway, screenshot) => {
      await visible(page.getByText(text("en", "memoryImport.adminRequired"), { exact: true }));
      expect(await gateway.getRequests("migrations.memory.plan")).toHaveLength(0);
      await screenshot("01-import-admin-required.png");
    });
  });

  it("cold Memory Import renders shipped German planning and confirmation copy", async () => {
    await prove("import-de", "de", "memory-import", true, (page, gateway, screenshot) =>
      importFlow(page, gateway, screenshot, "de"),
    );
  });
});
