import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "avatar owner graphemes",
  startServerBeforeBrowser: true,
});
const locales = ["en-US", "tr-TR"] as const;
const englishCases = [
  { id: "emoji", name: "😀Alice", dashboard: "😀", shell: "😀", defect: true },
  { id: "flag", name: "🇺🇸Team", dashboard: "🇺🇸", shell: "🇺🇸", defect: true },
  { id: "joined", name: "👨‍👩‍👧‍👦Family", dashboard: "👨‍👩‍👧‍👦", shell: "👨‍👩‍👧‍👦", defect: true },
  { id: "letter", name: "𐐨Name", dashboard: "𐐀", shell: "𐐨", defect: true },
  { id: "lower", name: "alice", dashboard: "A", shell: "a", defect: false },
  { id: "expansion", name: "ßeta", dashboard: "SS", shell: "ß", defect: false },
  { id: "locale", name: "ilker", dashboard: "I", shell: "i", defect: false },
  { id: "default", name: undefined, dashboard: "M", shell: "A", defect: false },
];
const casesFor = (locale: string) =>
  locale === "en-US"
    ? englishCases
    : [
        { id: "locale", name: "ilker", dashboard: "İ", shell: "i", defect: false },
        englishCases[5]!,
      ];
type Receipt = {
  id: string;
  name?: string;
  expected: string | null;
  actual: string | null;
  computed?: string;
  defect: boolean;
  locale: string;
  flow: string;
  screenshot: string;
  video?: string;
  chatSends: number;
  bootstrap?: {
    path: string;
    status: number;
    assistantName: string | null;
    environment: { label: string; color: string } | null;
  };
};
async function verifyLocale(page: Page, locale: string) {
  const observed = await page.evaluate(() => ({
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    segmenter: typeof Intl.Segmenter,
  }));
  expect(observed).toEqual({ locale, segmenter: "function" });
}
function save(dir: string, rows: Receipt[]) {
  writeFileSync(path.join(dir, "receipts.json"), JSON.stringify(rows, null, 2));
}
suite.define(() => {
  for (const locale of locales) {
    it(`dashboard initials preserve graphemes and casing ${locale}`, async () => {
      const dir = createControlUiE2eArtifactDir(`dashboard-${locale}`);
      const rows: Receipt[] = [];
      const cases = casesFor(locale);
      const sessions = cases.map((item, index) => ({
        key: `agent:main:dashboard:${String(index + 1).padStart(8, "0")}-90ab-cdef-1234-567890abcdef`,
        kind: "direct",
        boardFace: "dashboard",
        displayName: `Avatar ${item.id}`,
        updatedAt: 1,
        createdActor: {
          type: "human",
          id: item.name === undefined ? "main" : `person-${item.id}`,
          ...(item.name ? { label: item.name } : {}),
        },
      }));
      const first = sessions[0]!;
      const resolution = {
        ok: true,
        key: first.key,
        agentId: "main",
        displayName: first.displayName,
        boardFace: "dashboard",
      };
      await suite.withPage(
        {
          locale,
          viewport: { width: 1440, height: 900 },
          recordVideo: { dir, size: { width: 1440, height: 900 } },
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessions,
            methodResponses: {
              "sessions.resolve": resolution,
              "chat.startup": { resolution, messages: [], sessionInfo: first },
            },
          });
          await page.goto(`${suite.server.baseUrl}dashboards`);
          await verifyLocale(page, locale);
          await gateway.waitForRequest("sessions.list");
          const gallery = page.locator("openclaw-dashboards-page");
          await expect
            .poll(() => gallery.locator("[data-dashboard-session]").count())
            .toBe(cases.length);
          const screenshot = path.join(dir, "gallery.png");
          await page.screenshot({ path: screenshot });
          for (const [index, item] of cases.entries()) {
            const card = gallery.locator(`[data-dashboard-session="${sessions[index]!.key}"]`);
            const actual = await card.locator(".dashboard-card__avatar").textContent();
            const row = {
              id: item.id,
              name: item.name,
              expected: item.dashboard,
              actual,
              defect: item.defect,
              locale,
              flow: "dashboard",
              screenshot,
              video: await page.video()?.path(),
              chatSends: (await gateway.getRequests("chat.send")).length,
            };
            rows.push(row);
            save(dir, rows);
            if (!item.defect) expect(actual).toBe(item.dashboard);
          }
          const card = gallery.locator(`[data-dashboard-session="${first.key}"]`);
          const href = await card.locator(".dashboard-card__main").getAttribute("href");
          expect(href).toContain("?dashboard=expanded");
          await card.locator(".dashboard-card__main").click();
          await expect
            .poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
            .toBe(href);
          await page.locator(".chat-thread, .board-session-surface").first().waitFor();
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
      save(dir, rows);
      writeFileSync(
        path.join(dir, "joined.json"),
        JSON.stringify({ closed: true, locale, flow: "dashboard" }),
      );
      expect(
        rows.map(({ actual }) => actual),
        "dashboard first graphemes",
      ).toEqual(cases.map(({ dashboard }) => dashboard));
    });
    it(`shell initials preserve graphemes and casing ${locale}`, async () => {
      const dir = createControlUiE2eArtifactDir(`shell-${locale}`);
      const rows: Receipt[] = [];
      const cases = [
        ...casesFor(locale).map((item) => ({ ...item, environment: true })),
        {
          id: "no-environment",
          name: "😀Alice",
          shell: null,
          dashboard: "😀",
          defect: false,
          environment: false,
        },
      ];
      for (const item of cases) {
        const caseDir = path.join(dir, item.id);
        mkdirSync(caseDir);
        await suite.withPage(
          {
            locale,
            viewport: { width: 1440, height: 900 },
            recordVideo: { dir: caseDir, size: { width: 1440, height: 900 } },
          },
          async ({ page }) => {
            const gateway = await installMockGateway(page, { assistantName: item.name });
            await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
              route.fulfill({
                json: {
                  ...createControlUiMockBootstrapConfig({ assistantName: item.name }),
                  assistantName: item.name,
                  ...(item.environment ? { environment: { label: "edge", color: "amber" } } : {}),
                },
              }),
            );
            const pendingBootstrap = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === CONTROL_UI_BOOTSTRAP_CONFIG_PATH &&
                response.request().method() === "GET",
            );
            const [, bootstrapResponse] = await Promise.all([
              page.goto(`${suite.server.baseUrl}dashboards`),
              pendingBootstrap,
            ]);
            expect(bootstrapResponse.status()).toBe(200);
            const bootstrapBody = await bootstrapResponse.json();
            expect(bootstrapBody.assistantName).toBe(item.name);
            expect(bootstrapBody.environment ?? null).toEqual(
              item.environment ? { label: "edge", color: "amber" } : null,
            );
            const bootstrap = {
              path: new URL(bootstrapResponse.url()).pathname,
              status: bootstrapResponse.status(),
              assistantName: bootstrapBody.assistantName ?? null,
              environment: bootstrapBody.environment ?? null,
            };
            await verifyLocale(page, locale);
            await page.locator(".sidebar-brand__collapse").click();
            const toggle = page.locator(".shell-chrome-controls__nav-toggle");
            await toggle.waitFor();
            if (item.environment)
              await page.locator(".shell-chrome-controls__nav-toggle[data-env-avatar]").waitFor();
            const actual = await toggle.getAttribute("data-env-avatar");
            const computed = await toggle.evaluate(
              (element) => getComputedStyle(element, "::before").content,
            );
            const screenshot = path.join(caseDir, "collapsed.png");
            await page.screenshot({ path: screenshot });
            const row = {
              id: item.id,
              name: item.name,
              expected: item.shell,
              actual,
              computed,
              bootstrap,
              defect: item.defect,
              locale,
              flow: "shell",
              screenshot,
              video: await page.video()?.path(),
              chatSends: (await gateway.getRequests("chat.send")).length,
            };
            rows.push(row);
            save(dir, rows);
            if (!item.defect) {
              expect(actual).toBe(item.shell);
              if (item.shell !== null) expect(computed).toContain(item.shell);
            }
            await toggle.click();
            await page.locator(".sidebar-brand__collapse").waitFor();
            await expect
              .poll(() => page.locator(".shell-chrome-controls__nav-toggle").count())
              .toBe(0);
            expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          },
        );
      }
      save(dir, rows);
      writeFileSync(
        path.join(dir, "joined.json"),
        JSON.stringify({ closed: true, locale, flow: "shell" }),
      );
      expect(
        rows.map(({ actual }) => actual),
        "shell first graphemes",
      ).toEqual(cases.map(({ shell }) => shell));
    });
  }
});
