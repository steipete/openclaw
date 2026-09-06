import { appendFileSync } from "node:fs";

export default {
  id: "qa-noop-compaction-proof",
  name: "QA no-op compaction proof",
  register(api) {
    const record = (event) => {
      appendFileSync(api.pluginConfig.traceFile, `${JSON.stringify(event)}\n`);
    };
    api.on("before_compaction", (event, context) => {
      record({ phase: "before", sessionKey: context.sessionKey, event });
    });
    api.on("after_compaction", (event, context) => {
      record({ phase: "after", sessionKey: context.sessionKey, event });
    });
    api.registerContextEngine("qa-noop-compaction-proof", () => ({
      info: {
        id: "qa-noop-compaction-proof",
        name: "QA no-op compaction proof",
        ownsCompaction: true,
        acceptedHostParams: ["sessionKey"],
      },
      async ingest() {
        return { ingested: true };
      },
      async assemble({ messages }) {
        return { messages, estimatedTokens: 0 };
      },
      async compact({ sessionKey }) {
        if (sessionKey.endsWith("-throw")) {
          record({ phase: "engine-throw", sessionKey });
          throw new Error("Controlled proof engine failure");
        }
        const result = {
          ok: !sessionKey.endsWith("-failure"),
          compacted: false,
          reason: sessionKey.endsWith("-failure") ? "Controlled proof rejection" : "Proof no-op",
        };
        record({ phase: "engine-result", sessionKey, result });
        return result;
      },
    }));
  },
};
