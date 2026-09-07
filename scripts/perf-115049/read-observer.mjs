// Authored inertly for an observed CI pass only; never used for paired native timing/RSS.
import { isMainThread } from "node:worker_threads";

// Workers and CLI subprocesses inherit preload arguments. Only the owned Gateway writes counters.
if (isMainThread && process.argv[2] === "gateway" && process.argv[3] === "run") {
  const [{ default: assert }, fs, path, url] = await Promise.all([
    import("node:assert/strict"),
    import("node:fs"),
    import("node:path"),
    import("node:url"),
  ]);
  assert.equal(process.env.CI, "true");
  const configPath = new URL(import.meta.url).searchParams.get("config");
  assert.ok(configPath && path.isAbsolute(configPath));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(config.sessionKey, "agent:qa:snapshot-reuse");
  assert.ok(path.isAbsolute(config.repoRoot) && path.isAbsolute(config.outputFile));
  assert.equal(path.resolve(process.argv[1]), path.join(config.repoRoot, "dist/index.js"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(config.repoRoot, "dist/build-info.json"), "utf8")).commit,
    config.commit,
  );
  const { SessionManager } = await import(
    url.pathToFileURL(path.join(config.repoRoot, "dist/plugin-sdk/agent-sessions.js")).href
  );
  const descriptor = Object.getOwnPropertyDescriptor(SessionManager, "openModelContextAsync");
  assert.ok(descriptor && typeof descriptor.value === "function");
  const original = descriptor.value;
  const counts = { commit: config.commit, calls: 0, completed: 0, failed: 0, overflow: false };
  let writeFailed = false;
  const write = () => {
    try {
      fs.writeFileSync(config.outputFile, JSON.stringify(counts) + "\n", { mode: 0o600 });
    } catch {
      if (!writeFailed) {
        process.stderr.write("[snapshot-read-observer] artifact write failed\n");
      }
      writeFailed = true;
    }
  };
  write();
  Object.defineProperty(SessionManager, "openModelContextAsync", {
    ...descriptor,
    value: function (...args) {
      if (args[0]?.sessionKey !== config.sessionKey) {
        return Reflect.apply(original, this, args);
      }
      counts.calls += 1;
      counts.overflow ||= counts.calls > 100;
      write();
      const result = Reflect.apply(original, this, args);
      // Return the original Promise. Observation must not replace its result, receiver or error.
      void result.then(
        () => {
          counts.completed += 1;
          write();
        },
        () => {
          counts.failed += 1;
          write();
        },
      );
      return result;
    },
  });
}
