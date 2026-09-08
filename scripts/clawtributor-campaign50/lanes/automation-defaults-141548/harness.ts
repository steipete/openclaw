import { render } from "lit";
import "../../../styles.css";
import "../../../styles/settings.css";
import { analyzeConfigSchema, renderConfigForm } from "../../../components/config-form.ts";
import {
  applyConfigSnapshot,
  removeConfigFormValue,
  serializeFormForSubmit,
  updateConfigFormValue,
} from "../../../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../../../lib/config/config-state-model.ts";
import dataJson from "./data.json";
import type { Callback, ProofApi, ProofData, Snapshot } from "./types.ts";

declare global {
  interface Window {
    automationDefaultsProof: ProofApi;
  }
}
const data: ProofData = dataJson;
const id = new URL(location.href).searchParams.get("case");
const fixture = data.fixtures.find((entry) => entry.id === id);
if (!fixture) throw new Error("Unknown automation proof fixture");
const fixtureId = fixture.id;
const container = document.getElementById("form");
if (!container) throw new Error("Missing form host");
const state = createInitialConfigState();
const analysis = analyzeConfigSchema(data.schemaResponse.schema);
state.configSchema = analysis.schema;
state.configUiHints = data.schemaResponse.uiHints;
const callbacks: Callback[] = [];
let revision = 0;
function loadRaw(raw: Record<string, unknown>) {
  applyConfigSnapshot(
    state,
    {
      sourceConfig: structuredClone(raw),
      config: structuredClone(raw),
      raw: JSON.stringify(raw),
      valid: true,
      issues: [],
      hash: `fixture-${revision++}`,
    },
    { discardPendingChanges: true },
  );
}
function renderValue() {
  render(
    renderConfigForm({
      schema: analysis.schema,
      uiHints: data.schemaResponse.uiHints,
      unsupportedPaths: analysis.unsupportedPaths,
      value: state.configForm,
      activeSection: "cron",
      showAdvanced: true,
      onShowAdvanced: () => {},
      showSectionDocs: false,
      onPatch: (fieldPath, value) => {
        callbacks.push({ kind: "patch", path: [...fieldPath], value: structuredClone(value) });
        updateConfigFormValue(state, fieldPath, value);
        queueMicrotask(renderValue);
      },
      onRemove: (fieldPath) => {
        callbacks.push({ kind: "remove", path: [...fieldPath] });
        removeConfigFormValue(state, fieldPath);
        queueMicrotask(renderValue);
      },
    }),
    container,
  );
}
function snapshot(): Snapshot {
  return structuredClone({
    id: fixtureId,
    callbacks,
    dirty: state.configFormDirty,
    form: state.configForm,
    original: state.configFormOriginal,
    serialized: serializeFormForSubmit(state),
    raw: state.configRaw,
    rawOriginal: state.configRawOriginal,
    snapshotRaw: state.configSnapshot?.raw,
    sourceConfig: state.configSnapshot?.sourceConfig,
  });
}
loadRaw(fixture.config);
renderValue();
window.automationDefaultsProof = {
  ready: true,
  snapshot,
  reloadSerialized() {
    loadRaw(JSON.parse(serializeFormForSubmit(state)) as Record<string, unknown>);
    renderValue();
    return snapshot();
  },
};
