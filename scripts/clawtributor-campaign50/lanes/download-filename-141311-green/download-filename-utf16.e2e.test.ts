import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Download } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI download filename UTF16 boundary",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});
const boundaryPrefix = "a".repeat(119);
const cases = [
  { id: "short", title: "Quarterly 📊", widget: "Quarterly-📊", image: "Quarterly 📊" },
  { id: "ascii120", title: "a".repeat(120), widget: "a".repeat(120), image: "a".repeat(120) },
  {
    id: "pair-fit",
    title: `${"a".repeat(118)}📊`,
    widget: `${"a".repeat(118)}📊`,
    image: `${"a".repeat(118)}📊`,
  },
  { id: "pair-split", title: `${boundaryPrefix}📊`, widget: boundaryPrefix, image: boundaryPrefix },
  {
    id: "sanitize",
    title: "Quarterly / status: Q3?",
    widget: "Quarterly-status-Q3",
    image: "Quarterly - status- Q3",
  },
  { id: "fallback", title: "... <>", widget: "widget", image: "generated-image" },
  { id: "extension", title: "report.jpg", widget: "report.jpg", image: "report" },
];
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function retainDownload(download: Download, destination: string) {
  await download.saveAs(destination);
  const failure = await download.failure();
  const bytes = await readFile(destination);
  const receipt = {
    suggestedFilename: download.suggestedFilename(),
    failure,
    bytes: bytes.length,
    sha256: sha256(bytes),
    path: destination,
    signature: bytes.subarray(0, 8).toString("hex"),
    width: bytes.length >= 24 ? bytes.readUInt32BE(16) : 0,
    height: bytes.length >= 24 ? bytes.readUInt32BE(20) : 0,
  };
  return receipt;
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  for (const flow of ["widget", "image"] as const) {
    it(`downloads ${flow} filenames without splitting UTF16 characters`, async () => {
      const proofDir = path.join(suite.artifactDir, flow);
      await mkdir(path.join(proofDir, "downloads"), { recursive: true });
      const receipts: unknown[] = [];
      const actualNames: string[] = [];
      const expectedNames: string[] = [];
      const imageBytes = await readFile(
        path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
      );
      try {
        for (const fixture of cases) {
          const context = await suite.newBrowserContext({
            ...createControlUiE2eContextOptions(),
            acceptDownloads: true,
            viewport: { height: 900, width: 1440 },
          });
          const page = await context.newPage();
          try {
            const imageUrl = `/api/chat/media/outgoing/agent%3Amain%3Amain/${randomUUID()}/full`;
            const artifactId = `artifact_filename_${fixture.id}`;
            const requestedVariants: string[] = [];
            if (flow === "image") {
              await page.route("**/api/chat/media/outgoing/**", async (route) => {
                const url = new URL(route.request().url());
                expect(url.searchParams.get("mediaTicket")).toBe("ticket-filename-proof");
                expect(route.request().headers().authorization).toBeUndefined();
                requestedVariants.push(url.pathname.split("/").at(-1) ?? "");
                await route.fulfill({ body: imageBytes, contentType: "image/png" });
              });
            }
            const gateway = await installMockGateway(page, {
              historyMessages: [
                {
                  role: "assistant",
                  content:
                    flow === "widget"
                      ? [
                          {
                            type: "canvas",
                            preview: {
                              kind: "canvas",
                              surface: "assistant_message",
                              render: "url",
                              title: fixture.title,
                              viewId: "cv_filename",
                              url: "/__openclaw__/canvas/documents/cv_filename/index.html",
                              preferredHeight: 240,
                              sandbox: "scripts",
                            },
                          },
                        ]
                      : [
                          {
                            type: "image",
                            artifactId,
                            url: imageUrl,
                            alt: fixture.title,
                            mimeType: "image/png",
                            width: 1280,
                            height: 358,
                          },
                        ],
                  timestamp: 1,
                },
              ],
              methodResponses:
                flow === "widget"
                  ? {
                      "canvas.document.view": canvasView(
                        buildWidgetDocument(
                          fixture.title,
                          "<main><h1>Widget export proof</h1><p>Synthetic quarterly chart</p></main>",
                        ),
                      ),
                    }
                  : {
                      "artifacts.download": {
                        artifact: {
                          id: artifactId,
                          type: "image",
                          title: fixture.title,
                          mimeType: "image/png",
                          download: { mode: "url" },
                        },
                        url: `${imageUrl}?mediaTicket=ticket-filename-proof`,
                        expiresAt: "2099-01-01T00:00:00.000Z",
                      },
                    },
            });
            const response = await page.goto(`${suite.server.baseUrl}chat`);
            expect(response?.status()).toBe(200);
            let download: Download;
            if (flow === "widget") {
              const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
              await preview.waitFor({ state: "visible" });
              await preview
                .frameLocator(".chat-tool-card__preview-frame")
                .frameLocator("iframe")
                .getByText("Widget export proof", { exact: true })
                .waitFor();
              await preview.hover();
              await preview.getByRole("button", { name: "Widget actions", exact: true }).click();
              const action = preview.getByRole("menuitem", {
                name: "Download as image",
                exact: true,
              });
              await action.waitFor({ state: "visible" });
              await page.screenshot({ path: path.join(proofDir, `${fixture.id}.png`) });
              const pendingDownload = page.waitForEvent("download", { timeout: 15_000 });
              await action.click();
              download = await pendingDownload;
            } else {
              const image = page.getByAltText(fixture.title, { exact: true });
              await image.waitFor({ state: "visible" });
              await expect
                .poll(() =>
                  image.evaluate((element) =>
                    element instanceof HTMLImageElement && element.complete
                      ? element.naturalWidth
                      : 0,
                  ),
                )
                .toBe(1280);
              const frame = page.locator(".chat-image-frame--managed").filter({ has: image });
              await frame.hover();
              const action = frame.getByRole("button", { name: "Download image", exact: true });
              await action.waitFor({ state: "visible" });
              await page.screenshot({ path: path.join(proofDir, `${fixture.id}.png`) });
              const pendingDownload = page.waitForEvent("download", { timeout: 15_000 });
              await action.click();
              download = await pendingDownload;
            }
            const retained = await retainDownload(
              download,
              path.join(proofDir, "downloads", `${fixture.id}.png`),
            );
            const chatRequests = (await gateway.getRequests("chat.send")).length;
            const artifactRequests = (await gateway.getRequests("artifacts.download")).length;
            const canvasRequests = (await gateway.getRequests("canvas.document.view")).length;
            receipts.push({
              flow,
              id: fixture.id,
              title: fixture.title,
              expectedFilename: `${fixture[flow]}.png`,
              ...retained,
              requestedVariants,
              chatRequests,
              artifactRequests,
              canvasRequests,
              screenshot: path.join(proofDir, `${fixture.id}.png`),
            });
            await writeFile(
              path.join(proofDir, "receipts.json"),
              JSON.stringify(receipts, null, 2),
            );
            expect(retained.failure).toBeNull();
            expect(retained.signature).toBe("89504e470d0a1a0a");
            expect(retained.bytes).toBeGreaterThan(32);
            expect(retained.width).toBeGreaterThan(0);
            expect(retained.height).toBeGreaterThan(0);
            expect(chatRequests).toBe(0);
            if (flow === "image") {
              expect(retained.sha256).toBe(sha256(imageBytes));
              expect(requestedVariants).toEqual(["thumbnail", "full"]);
              expect(artifactRequests).toBe(2);
            } else {
              expect(canvasRequests).toBeGreaterThan(0);
            }
            actualNames.push(retained.suggestedFilename);
            expectedNames.push(`${fixture[flow]}.png`);
            if (fixture.id !== "pair-split") {
              expect(retained.suggestedFilename).toBe(`${fixture[flow]}.png`);
            }
          } finally {
            await suite.closeBrowserContext(context);
          }
        }
      } finally {
        await writeFile(path.join(proofDir, "receipts.json"), JSON.stringify(receipts, null, 2));
      }
      expect(actualNames, `${flow} download filenames preserve the UTF16 boundary`).toEqual(
        expectedNames,
      );
    }, 120_000);
  }
});
