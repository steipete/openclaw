import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebClient } from "@slack/web-api";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  disposeSlackTestRuntime,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  runSlackHandlerWithDispatch,
  startSlackMonitor,
  stopSlackMonitor,
} from "./monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./monitor/provider.js");
const outputDirectory = process.env.SLACK_ACK_PROOF_OUTPUT;
if (!outputDirectory) throw new Error("SLACK_ACK_PROOF_OUTPUT is required");
const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
let ownedStateDirectory: string | undefined;
let suiteBlocked = false;
type CaseClosure = {
  id: string;
  monitorJoined: boolean;
  apiJoined: boolean;
  serverClosed: boolean;
  ownersJoined: boolean;
  stateRemoved: boolean;
  observation: Record<string, unknown>;
};
let activeCase: CaseClosure | undefined;
const reactionArguments = z
  .object({ channel: z.string(), timestamp: z.string(), name: z.string() })
  .strict();
type RecordedRequest = { method: string; path: string; contentType: string; body: string };

function saveObservation() {
  if (!activeCase) return;
  const { observation, ...closure } = activeCase;
  writeFileSync(
    join(outputDirectory!, `${activeCase.id}.json`),
    JSON.stringify({ ...observation, closure, suiteBlocked }, null, 2) + "\n",
  );
}

afterEach(() => {
  if (suiteBlocked || !activeCase?.ownersJoined) {
    suiteBlocked = true;
    saveObservation();
    return;
  }
  try {
    closeOpenClawStateDatabaseForTest();
    if (ownedStateDirectory) {
      rmSync(ownedStateDirectory, { recursive: true, force: true });
      ownedStateDirectory = undefined;
    }
    if (previousStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
    activeCase.stateRemoved = true;
  } catch (error) {
    suiteBlocked = true;
    throw error;
  } finally {
    saveObservation();
  }
});

afterAll(() => {
  if (!suiteBlocked && activeCase?.ownersJoined) disposeSlackTestRuntime();
});

describe("Slack registered pickup acknowledgement", () => {
  it.each([
    { id: "tool-disabled", visibleReplies: "message_tool", statusEnabled: false },
    { id: "tool-default", visibleReplies: "message_tool", statusEnabled: undefined },
    { id: "automatic-disabled", visibleReplies: "automatic", statusEnabled: false },
    { id: "tool-enabled", visibleReplies: "message_tool", statusEnabled: true },
  ] as const)(
    "$id",
    async ({ id, visibleReplies, statusEnabled }) => {
      if (suiteBlocked) throw new Error("Previous Slack proof owner closure is unproven");
      const closure: CaseClosure = {
        id,
        monitorJoined: true,
        apiJoined: true,
        serverClosed: false,
        ownersJoined: false,
        stateRemoved: false,
        observation: { id },
      };
      activeCase = closure;
      const requests: RecordedRequest[] = [];
      const apiTasks: Promise<unknown>[] = [];
      const runtimeErrors: string[] = [];
      const cleanupErrors: unknown[] = [];
      let bodyFailed = false;
      let bodyError: unknown;
      let ready = false;
      let monitor: ReturnType<typeof startSlackMonitor> | undefined;
      let state: ReturnType<typeof getSlackTestState> | undefined;
      let client: ReturnType<typeof getSlackClient> | undefined;
      let monitorFailure: unknown;
      const server = createServer((request, response) => {
        const buffers: Buffer[] = [];
        request.on("data", (buffer: Buffer) => buffers.push(buffer));
        request.on("error", (error) => response.destroy(error));
        request.on("end", () => {
          requests.push({
            method: request.method ?? "",
            path: request.url ?? "",
            contentType: request.headers["content-type"] ?? "",
            body: Buffer.concat(buffers).toString("utf8"),
          });
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ ok: true }));
        });
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        if (suiteBlocked) throw new Error("Slack proof already timed out before setup completed");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing Slack mock API port");
        const api = new WebClient("synthetic-slack-token", {
          slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
        });
        resetInboundDedupe();
        resetSlackTestState({
          messages: {
            ackReaction: "eyes",
            ackReactionScope: "group-mentions",
            groupChat: { visibleReplies },
            statusReactions: statusEnabled === undefined ? undefined : { enabled: statusEnabled },
          },
          channels: { slack: { groupPolicy: "open", streaming: "off" } },
        });
        const createdStateDirectory = process.env.OPENCLAW_STATE_DIR;
        if (!createdStateDirectory || createdStateDirectory === previousStateDirectory)
          throw new Error("Slack fixture did not create its own state directory");
        ownedStateDirectory = createdStateDirectory;
        state = getSlackTestState();
        client = getSlackClient();
        client.conversations.info.mockResolvedValue({
          ok: true,
          channel: { id: "C1", name: "general", is_channel: true, is_im: false },
        });
        client.users.info.mockResolvedValue({ user: { profile: { display_name: "Ada" } } });
        state.replyMock.mockResolvedValue(undefined);
        state.reactionRemoveMock.mockImplementation(() => {
          throw new Error("Unexpected reaction removal in pickup-only proof");
        });
        state.reactMock.mockImplementation((value) => {
          const pending = api.reactions.add(reactionArguments.parse(value));
          apiTasks.push(pending);
          closure.apiJoined = false;
          return pending;
        });
        closure.monitorJoined = false;
        monitor = startSlackMonitor(monitorSlackProvider, {
          runtime: {
            log: () => {},
            error: (value) => runtimeErrors.push(String(value)),
            exit: (code) => {
              throw new Error(`Unexpected runtime exit: ${code}`);
            },
          },
        });
        void monitor.run.catch((error: unknown) => {
          monitorFailure = error;
        });
        await vi.waitFor(
          () => {
            if (monitorFailure !== undefined) throw monitorFailure;
            expect(state?.appStartMock).toHaveBeenCalledTimes(1);
          },
          { timeout: 5_000 },
        );
        const startResult = state.appStartMock.mock.results[0];
        if (!startResult || startResult.type !== "return")
          throw new Error("Slack app start did not return successfully");
        await startResult.value;
        ready = true;
        const handler = await getSlackHandlerOrThrow("message");
        await runSlackHandlerWithDispatch(handler, {
          event: {
            type: "message",
            channel: "C1",
            channel_type: "channel",
            user: "U1",
            text: "<@bot-user> hello",
            ts: "456",
          },
          body: { api_app_id: "A_TEST", event_id: `Ev-ack-${id}` },
        });
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
      } finally {
        if (monitor) {
          try {
            await stopSlackMonitor(monitor);
            closure.monitorJoined = true;
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        let drained = 0;
        let apiFailed = false;
        while (drained < apiTasks.length) {
          const next = apiTasks.length;
          const outcomes = await Promise.allSettled(apiTasks.slice(drained, next));
          for (const outcome of outcomes) {
            if (outcome.status === "rejected") {
              apiFailed = true;
              cleanupErrors.push(outcome.reason);
            }
          }
          drained = next;
        }
        closure.apiJoined = !apiFailed;
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            server.closeIdleConnections();
          });
          closure.serverClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
        closure.ownersJoined = closure.monitorJoined && closure.apiJoined && closure.serverClosed;
      }
      const observation = {
        id,
        visibleReplies,
        statusEnabled: statusEnabled ?? null,
        ready,
        requests,
        reactionAdds: state?.reactionAddMock.mock.calls ?? [],
        reactionRemoves: state?.reactionRemoveMock.mock.calls ?? [],
        userLookups: client?.users.info.mock.calls ?? [],
        channelLookups: client?.conversations.info.mock.calls ?? [],
        replyCalls: state?.replyMock.mock.calls.length ?? 0,
        visibleSends: state?.sendMock.mock.calls.length ?? 0,
        runtimeErrors,
        monitorStarts: state?.appStartMock.mock.calls.length ?? 0,
        monitorStopCalls: state?.appStopMock.mock.calls.length ?? 0,
        cleanupErrors: cleanupErrors.map(String),
      };
      closure.observation = observation;
      saveObservation();
      if (cleanupErrors.length)
        throw new AggregateError(
          bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
          "Slack proof cleanup failed",
        );
      if (bodyFailed) throw bodyError;
      expect(ready).toBe(true);
      expect(runtimeErrors).toEqual([]);
      expect(observation.monitorStarts).toBe(1);
      expect(observation.monitorStopCalls).toBe(2);
      expect(observation.replyCalls).toBe(1);
      expect(observation.visibleSends).toBe(0);
      expect(observation.channelLookups.length).toBeGreaterThan(0);
      expect(observation.userLookups.length).toBeGreaterThan(0);
      expect(observation.reactionRemoves).toEqual([]);
      expect(requests, "SLACK_PICKUP_ACK").toHaveLength(1);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.path).toBe("/api/reactions.add");
      expect(requests[0]?.contentType).toBe("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
        channel: "C1",
        timestamp: "456",
        name: "eyes",
      });
    },
    30_000,
  );
});
