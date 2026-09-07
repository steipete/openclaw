import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../scripts/lib/local-build-metadata-paths.mts";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionPath } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sourceHead = process.env.MODEL_AUTH_PROOF_SOURCE_HEAD;
const selectedKey = "agent:main:auth-status-observation";
const homeKey = "agent:main:main";
let instance: OpenClawTestInstance | undefined;
let config: OpenClawConfig;
const providerRequests: Array<{ method: string; path: string }> = [];

type AuthRead = {
  id: string;
  connection: number;
  invalidationGeneration: number;
  phase: string;
  agentId: string;
  refresh: boolean;
  sentMs: number;
  receivedMs?: number;
  closedMs?: number;
  overlappingIds: string[];
  ok?: boolean;
  unavailable?: boolean;
  providers?: Array<{ provider: string; status: string }>;
};

const suite = createControlUiE2eSuite({
  name: "Passive model auth observation with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "model-auth-coalescing-observation",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        OPENCLAW_TEST_FAST: undefined,
        VITEST_WORKER_ID: undefined,
        VITEST_POOL_ID: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_CHANNELS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_SKIP_GMAIL_WATCHER: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: undefined,
        OPENCLAW_SKIP_CANVAS_HOST: undefined,
      },
    });
    instance = owner;
    const sentinel = createServer((request, response) => {
      providerRequests.push({ method: request.method ?? "", path: request.url ?? "" });
      request.resume();
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"Unexpected model/provider request in metadata observation"}');
    });
    const close = async () => {
      try {
        await owner.cleanup();
      } finally {
        sentinel.closeAllConnections();
        if (sentinel.listening) {
          await new Promise<void>((resolve, reject) =>
            sentinel.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await writeFile(
          path.join(suite.artifactDir, "provider-http.json"),
          JSON.stringify(providerRequests, null, 2),
        );
      }
      expect(providerRequests).toEqual([]);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        sentinel.once("error", reject);
        sentinel.listen(0, "127.0.0.1", () => {
          sentinel.off("error", reject);
          resolve();
        });
      });
      const address = sentinel.address();
      if (!address || typeof address === "string") {
        throw new Error("Provider sentinel did not bind loopback");
      }
      const workspace = owner.state.path("workspace");
      const secondWorkspace = owner.state.path("second-workspace");
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(secondWorkspace, { recursive: true }),
      ]);
      config = {
        gateway: {
          port: owner.port,
          auth: { mode: "token", token: owner.gatewayToken },
          controlUi: { enabled: true },
        },
        agents: {
          defaults: { workspace, model: "fixture/anchor" },
          entries: {
            main: { default: true, workspace, identity: { name: "Synthetic main" } },
            second: { workspace: secondWorkspace, identity: { name: "Synthetic second" } },
          },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              models: [{ id: "anchor", name: "Synthetic anchor" }],
            },
          },
        },
      };
      await owner.state.writeConfig(config);
      ensureGatewayOwnerProfile("Synthetic Viewer", { env: owner.env });
      // The driver observes a prebuilt runtime; it must not silently switch to source startup.
      for (const stamp of [BUILD_STAMP_FILE, RUNTIME_POSTBUILD_STAMP_FILE]) {
        const built: unknown = JSON.parse(await readFile(path.join("dist", stamp), "utf8"));
        expect(isRecord(built) ? built.head : undefined).toBe(sourceHead);
      }
      const entrypoint = await owner.entrypoint();
      expect(entrypoint).toEqual(["dist/index.js"]);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("records naturally overlapping auth reads during normal chat and Settings navigation", async (testContext) => {
    await suite.runScenario(testContext, {
      retainedState: () => instance?.state.root,
      run: async (signal) => {
        signal.throwIfAborted();
        const owner = instance;
        if (!owner) {
          throw new Error("Owned Gateway did not start");
        }
        const driverSha256 = createHash("sha256")
          .update(await readFile(import.meta.filename))
          .digest("hex");
        signal.throwIfAborted();
        const cliJson = async (args: string[]) => {
          signal.throwIfAborted();
          const result = await owner.cli([...args, "--json"]);
          signal.throwIfAborted();
          expect(result.code).toBe(0);
          const value: unknown = JSON.parse(result.stdout);
          if (!isRecord(value)) {
            throw new Error("CLI returned an unexpected result shape");
          }
          return value;
        };
        for (const [key, label] of [
          [selectedKey, "Synthetic selected chat"],
          [homeKey, "Synthetic Home"],
        ]) {
          const created = await cliJson([
            "gateway",
            "call",
            "sessions.create",
            "--params",
            JSON.stringify({ key, agentId: "main", label }),
          ]);
          expect(created.ok).toBe(true);
          await appendTranscriptMessages(
            {
              agentId: "main",
              sessionKey: key,
              sessionId: String(created.sessionId),
              env: owner.env,
            },
            {
              config,
              messages: [
                {
                  message: { role: "user", content: [{ type: "text", text: label }] },
                  timestamp: 1_780_000_000_000,
                },
              ],
            },
          );
        }
        const handoff = await cliJson(["dashboard"]);
        const url = new URL(controlUiSessionPath(selectedKey), suite.server.baseUrl);
        url.hash = new URL(String(handoff.browserUrl)).hash;
        const reads: AuthRead[] = [];
        const invalidations: Array<{
          connection: number;
          generation: number;
          event: "config.changed" | "chat.metadata.changed";
          receivedMs: number;
        }> = [];
        const visible: Array<{ phase: string; mainChat: boolean; home: boolean }> = [];
        let phase = "cold-chat";
        let connection = 0;
        let flowCompleted = false;
        let contextClosed = false;
        const pendingObservations = () =>
          reads.filter((read) => read.receivedMs === undefined && read.closedMs === undefined);
        const settleObservations = () => expect.poll(() => pendingObservations().length).toBe(0);
        // Context closure settles the last socket callbacks before final observation is frozen.
        try {
          await suite.withPage(
            { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
            async ({ page }) => {
              page.on("websocket", (socket) => {
                const socketId = ++connection;
                let invalidationGeneration = 0;
                const pending = new Map<string, AuthRead>();
                socket.on("close", () => {
                  for (const read of pending.values()) {
                    read.closedMs = performance.now();
                  }
                  pending.clear();
                });
                socket.on("framesent", ({ payload }) => {
                  const frame: unknown = JSON.parse(payload.toString());
                  if (
                    !isRecord(frame) ||
                    frame.type !== "req" ||
                    frame.method !== "models.authStatus" ||
                    typeof frame.id !== "string"
                  ) {
                    return;
                  }
                  const params = isRecord(frame.params) ? frame.params : {};
                  const agentId = typeof params.agentId === "string" ? params.agentId : "";
                  const refresh = params.refresh === true;
                  const read: AuthRead = {
                    id: frame.id,
                    connection: socketId,
                    invalidationGeneration,
                    phase,
                    agentId,
                    refresh,
                    sentMs: performance.now(),
                    overlappingIds: [...pending.values()]
                      .filter((prior) => prior.agentId === agentId && prior.refresh === refresh)
                      .map((prior) => prior.id),
                  };
                  reads.push(read);
                  pending.set(frame.id, read);
                });
                socket.on("framereceived", ({ payload }) => {
                  const frame: unknown = JSON.parse(payload.toString());
                  if (
                    isRecord(frame) &&
                    frame.type === "event" &&
                    (frame.event === "config.changed" || frame.event === "chat.metadata.changed")
                  ) {
                    // These events retire the current shared metadata owner; retain names only.
                    invalidations.push({
                      connection: socketId,
                      generation: ++invalidationGeneration,
                      event: frame.event,
                      receivedMs: performance.now(),
                    });
                    return;
                  }
                  if (!isRecord(frame) || frame.type !== "res" || typeof frame.id !== "string") {
                    return;
                  }
                  const read = pending.get(frame.id);
                  if (!read) {
                    return;
                  }
                  pending.delete(frame.id);
                  const result = isRecord(frame.payload) ? frame.payload : {};
                  read.receivedMs = performance.now();
                  read.ok = frame.ok === true;
                  read.unavailable = result.unavailable !== undefined;
                  read.providers = Array.isArray(result.providers)
                    ? result.providers.filter(isRecord).map((provider) => ({
                        provider: String(provider.provider),
                        status: String(provider.status),
                      }))
                    : [];
                });
              });
              await page.goto(url.toString());
              await waitForControlUiGatewayReady(page);
              const selected = page.locator(
                "openclaw-chat-pane.chat-pane-cache__pane--active:not([inert])",
              );
              await selected
                .locator(".chat-thread")
                .getByText("Synthetic selected chat", { exact: true })
                .waitFor();
              await page.locator(".sidebar-footer-bar__home").click();
              const home = page.locator("openclaw-assistant-panel .chat-thread");
              await home.getByText("Synthetic Home", { exact: true }).waitFor();
              await settleObservations();
              for (const attempt of [1, 2]) {
                phase = `restored-chat-home-${attempt}`;
                await page.reload();
                await waitForControlUiGatewayReady(page);
                await selected
                  .locator(".chat-thread")
                  .getByText("Synthetic selected chat", { exact: true })
                  .waitFor();
                await home.getByText("Synthetic Home", { exact: true }).waitFor();
                await expect
                  .poll(() =>
                    reads
                      .filter((read) => read.phase === phase)
                      .some((read) => read.receivedMs !== undefined),
                  )
                  .toBe(true);
                await settleObservations();
                visible.push({ phase, mainChat: true, home: true });
              }
              phase = "model-providers";
              const settingsUrl = new URL("settings/model-providers", suite.server.baseUrl);
              // Pairing fragments are single-use; later documents reuse the paired browser identity.
              await page.goto(settingsUrl.toString());
              await waitForControlUiGatewayReady(page);
              const providerCard = page.locator('[data-provider-id="fixture"]');
              await providerCard.waitFor();
              await expect
                .poll(() =>
                  reads
                    .filter((read) => read.phase === phase)
                    .some((read) => read.receivedMs !== undefined),
                )
                .toBe(true);
              await settleObservations();
              const cardText = await providerCard.innerText();
              expect(cardText.length).toBeGreaterThan(0);
              const completed = reads.filter((read) => read.receivedMs !== undefined);
              expect(completed.length).toBeGreaterThan(0);
              for (const read of completed) {
                expect(read.ok).toBe(true);
                expect(read.unavailable).toBe(false);
                expect(read.providers).toContainEqual({ provider: "fixture", status: "static" });
              }
              const scriptAssets = await page.locator("script[src]").evaluateAll((scripts) =>
                scripts.map((script) => {
                  const source = new URL((script as HTMLScriptElement).src);
                  return { origin: source.origin, path: source.pathname };
                }),
              );
              expect(scriptAssets.length).toBeGreaterThan(0);
              const servedAssets: Array<{ path: string; sha256: string }> = [];
              for (const asset of scriptAssets) {
                expect(asset.origin).toBe(new URL(suite.server.baseUrl).origin);
                const assetPath = asset.path;
                const response = await page.request.get(
                  new URL(assetPath, suite.server.baseUrl).href,
                );
                expect(response.ok()).toBe(true);
                const bytes = await response.body();
                expect(assetPath.startsWith("/assets/")).toBe(true);
                expect(
                  bytes.equals(await readFile(path.join("dist/control-ui", assetPath.slice(1)))),
                ).toBe(true);
                servedAssets.push({
                  path: assetPath,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                });
              }
              expect(providerRequests).toEqual([]);
              await page.screenshot({
                path: path.join(suite.artifactDir, "model-providers-synthetic.png"),
              });
              await writeFile(
                path.join(suite.artifactDir, "visible-status.json"),
                JSON.stringify({ cardText, visible, servedAssets }, null, 2),
              );
              await settleObservations();
              flowCompleted = true;
            },
          );
          contextClosed = true;
        } finally {
          const unfinished = pendingObservations();
          const closedWithoutResponse = reads.filter((read) => read.closedMs !== undefined);
          const observationComplete =
            flowCompleted &&
            contextClosed &&
            unfinished.length === 0 &&
            closedWithoutResponse.length === 0;
          const successfulOverlap = (sameGeneration: boolean) =>
            reads.some(
              (read) =>
                read.ok &&
                !read.unavailable &&
                read.overlappingIds.some((id) =>
                  reads.some(
                    (prior) =>
                      prior.id === id &&
                      prior.connection === read.connection &&
                      prior.ok &&
                      !prior.unavailable &&
                      (!sameGeneration ||
                        prior.invalidationGeneration === read.invalidationGeneration),
                  ),
                ),
            );
          await writeFile(
            path.join(suite.artifactDir, "auth-rpc-observation.json"),
            JSON.stringify(
              {
                sourceHead,
                driverSha256,
                reads,
                flowCompleted,
                contextClosed,
                observationComplete,
                pendingFinalObservations: unfinished.map((read) => ({
                  id: read.id,
                  connection: read.connection,
                  phase: read.phase,
                })),
                closedWithoutResponse: closedWithoutResponse.map((read) => ({
                  id: read.id,
                  connection: read.connection,
                  phase: read.phase,
                })),
                naturalOverlapObserved: reads.some((read) => read.overlappingIds.length > 0),
                invalidations,
                successfulOverlapObserved: observationComplete ? successfulOverlap(false) : null,
                successfulSameGenerationOverlapObserved: observationComplete
                  ? successfulOverlap(true)
                  : null,
                interpretation:
                  "Synthetic static-provider configuration through real production-built Gateway and Chromium. Incomplete observations have no absence verdict. No provider latency or cache-hit claim.",
              },
              null,
              2,
            ),
          );
        }
      },
    });
  });
});
