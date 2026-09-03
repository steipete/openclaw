import { writeFileSync } from "node:fs";

const errors = (values) => values.map(({ name, message, stack }) => ({ name, message, stack }));

// Vitest's JSON reporter omits unhandled and nested-suite hook errors.
export default class LifecycleReporter {
  state = { schema: "settings-media-lifecycle-v1", runEnded: false, processTimeout: false, afterAllOwners: [] };

  onInit(vitest) {
    this.output = `${vitest.config.outputFile.json}.lifecycle.json`;
    this.state.vitestVersion = vitest.version;
    this.save();
  }

  onHookEnd({ name, entity }) {
    if (name === "afterAll") this.state.afterAllOwners.push(entity.name ?? entity.moduleId);
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    Object.assign(this.state, {
      runEnded: true, reason, unhandledErrors: errors(unhandledErrors),
      modules: modules.map((module) => ({
        path: module.moduleId, errors: errors(module.errors()),
        suites: [...module.children.allSuites()].map((suite) => ({ name: suite.name, errors: errors(suite.errors()) })),
      })),
    });
    this.save();
  }

  onProcessTimeout() {
    this.state.processTimeout = true;
    this.save();
  }

  save() {
    writeFileSync(this.output, `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
