import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChannelsStatusSnapshot, CronJob } from "../api/types.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron recipient suggestions mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

// Account display names are free text: a saved recipient may have the same spelling.
const collisionTarget = "-1001234567890";
const savedWebhook = "https://example.test/hooks/saved";
const channels: ChannelsStatusSnapshot = {
  ts: 1,
  channelOrder: ["telegram", "discord"],
  channelLabels: { telegram: "Telegram", discord: "Discord" },
  channels: {},
  channelAccounts: {
    telegram: [
      { accountId: "default", name: "Account only" },
      { accountId: "work", name: collisionTarget },
      { accountId: "webhook-name", name: "https://example.test/account-name" },
    ],
    discord: [{ accountId: "discord-only", name: "Discord account only" }],
  },
  channelDefaultAccountId: { telegram: "default", discord: "discord-only" },
};
const telegramAccounts = [
  "default",
  "Account only",
  "work",
  collisionTarget,
  "webhook-name",
  "https://example.test/account-name",
];
const savedRecipients = [collisionTarget, "channel:123456789012345678", savedWebhook];
const collisionJob: CronJob = {
  id: "recipient-collision",
  configRevision: "recipient-proof-revision",
  name: "Synthetic recipient report",
  enabled: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Prepare a synthetic report." },
  delivery: { mode: "announce", channel: "telegram", to: collisionTarget, accountId: "work" },
  state: {},
};
const jobs: CronJob[] = [
  collisionJob,
  {
    ...collisionJob,
    id: "discord-recipient",
    name: "Synthetic Discord report",
    delivery: { mode: "announce", channel: "discord", to: "channel:123456789012345678" },
  },
  {
    ...collisionJob,
    id: "webhook-recipient",
    name: "Synthetic webhook report",
    delivery: { mode: "webhook", to: savedWebhook },
  },
];
const methodResponses = {
  "channels.status": channels,
  "cron.list": {
    jobs,
    snapshotRevision: "recipient-proof-snapshot",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  },
  "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
  "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  "cron.update": { ...collisionJob, configRevision: "recipient-proof-saved" },
};

function options(page: Page, list: "to" | "account") {
  return page
    .locator(`#cron-delivery-${list}-suggestions option`)
    .evaluateAll((elements) => elements.map((element) => (element as HTMLOptionElement).value));
}

async function choose(page: Page, id: string, value: string) {
  const picker = page.locator(`wa-select#${id}`);
  await picker.click();
  await picker.locator(`wa-option[value="${value}"]`).click();
  await expect
    .poll(() => picker.evaluate((element) => (element as HTMLElement & { value: string }).value))
    .toBe(value);
}

async function withCronProof(
  caseId: string,
  check: (page: Page, gateway: MockGatewayControls, record: Record<string, unknown>) => Promise<void>,
) {
  const artifactDir = suite.artifactDir;
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1_050, width: 1_440 },
      recordVideo: { dir: artifactDir, size: { height: 1_050, width: 1_440 } },
    },
    async ({ page }) => {
      const record: Record<string, unknown> = {
        schema: "openclaw-cron-recipient-ui-proof-v1",
        caseId,
        status: "fail",
        fixture: methodResponses,
      };
      let gateway: MockGatewayControls | undefined;
      try {
        gateway = await installMockGateway(page, { methodResponses });
        const [servedOwner, navigation] = await Promise.all([
          page.waitForResponse((response) =>
            new URL(response.url()).pathname.endsWith("/src/pages/cron/form-suggestions.ts"),
          ),
          page.goto(`${suite.server.baseUrl}cron`),
        ]);
        expect(navigation?.status()).toBe(200);
        expect(servedOwner.status()).toBe(200);
        record.servedOwner = {
          path: new URL(servedOwner.url()).pathname,
          sha256: createHash("sha256").update(await servedOwner.body()).digest("hex"),
        };
        await gateway.waitForRequest("channels.status");
        await gateway.waitForRequest("cron.list");
        await page.locator('[data-test-id="cron-row-recipient-collision"]').click();
        await page.locator("#cron-delivery-to").waitFor({ state: "visible" });
        await page.locator("details.cron-advanced > summary").click();
        await expect.poll(() => options(page, "account")).toEqual(telegramAccounts);
        record.accountInputList = await page.locator("#cron-delivery-account-id").getAttribute("list");
        record.recipientInputList = await page.locator("#cron-delivery-to").getAttribute("list");
        await check(page, gateway, record);
        expect(await gateway.getRequests("cron.run")).toEqual([]);
        record.status = "pass";
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        record.requests = gateway ? await gateway.getRequests() : [];
        await writeFile(path.join(artifactDir, "observations.json"), `${JSON.stringify(record, null, 2)}\n`);
      }
    },
  );
}

async function captureOptions(page: Page, record: Record<string, unknown>, screenshot: string) {
  record.recipientOptions = await options(page, "to");
  record.accountOptions = await options(page, "account");
  record.recipientValue = await page.locator("#cron-delivery-to").inputValue();
  record.accountValue = await page.locator("#cron-delivery-account-id").inputValue();
  record.screenshot = screenshot;
  await page.locator("#cron-delivery-to").focus();
  await page.screenshot({ path: path.join(suite.artifactDir, screenshot), fullPage: true });
}

suite.define(() => {
  for (const selected of ["telegram", "last", "webhook"] as const) {
    it(`separates saved recipients from account metadata for ${selected}`, async () => {
      await withCronProof(selected, async (page, _gateway, record) => {
        if (selected === "last") {
          await choose(page, "cron-delivery-channel", "last");
          await expect
            .poll(() => options(page, "account"))
            .toEqual([...telegramAccounts, "discord-only", "Discord account only"]);
        } else if (selected === "webhook") {
          await choose(page, "cron-delivery-mode", "webhook");
          await page.getByText("Webhook URL", { exact: true }).waitFor({ state: "visible" });
        }
        await captureOptions(page, record, `${selected}-editor.png`);
        expect(record.recipientInputList).toBe("cron-delivery-to-suggestions");
        expect(record.accountInputList).toBe("cron-delivery-account-suggestions");
        expect(record.accountOptions).toEqual(
          selected === "last"
            ? [...telegramAccounts, "discord-only", "Discord account only"]
            : telegramAccounts,
        );
        expect(record.recipientOptions).toEqual(selected === "webhook" ? [savedWebhook] : savedRecipients);
      });
    });
  }

  it("selects and saves a same-channel recipient that equals an account display name", async () => {
    await withCronProof("same-channel-collision", async (page, gateway, record) => {
      await captureOptions(page, record, "collision-options.png");
      expect(record.recipientOptions).toContain(collisionTarget);
      const recipient = page.locator("#cron-delivery-to");
      await recipient.fill("");
      await recipient.pressSequentially("-100");
      await recipient.press("ArrowDown");
      await recipient.press("Enter");
      await expect.poll(() => recipient.inputValue()).toBe(collisionTarget);
      record.selectedRecipient = await recipient.inputValue();
      expect(await page.locator("#cron-delivery-account-id").inputValue()).toBe("work");
      await page.screenshot({ path: path.join(suite.artifactDir, "collision-selected.png"), fullPage: true });
      await page.locator('[data-test-id="cron-submit"]').click();
      record.updateRequest = await gateway.waitForRequest("cron.update");
      expect(record.updateRequest).toMatchObject({
        params: {
          id: "recipient-collision",
          expectedConfigRevision: "recipient-proof-revision",
          patch: {
            delivery: { mode: "announce", channel: "telegram", to: collisionTarget, accountId: "work" },
          },
        },
      });
    });
  });
});
