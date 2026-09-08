import type { ConfigSchemaResponse } from "../../../api/types.ts";
type Fixture = { id: string; config: Record<string, unknown>; expected: string };
export type ProofData = {
  source: string;
  schemaResponse: ConfigSchemaResponse;
  fixtures: Fixture[];
  validation: Array<{ id: string; valid: boolean }>;
};
export type Callback = { kind: "patch" | "remove"; path: Array<string | number>; value?: unknown };
export type Snapshot = {
  id: string;
  callbacks: Callback[];
  dirty: boolean;
  form: Record<string, unknown> | null;
  original: Record<string, unknown> | null;
  serialized: string;
  raw: string;
  rawOriginal: string;
  snapshotRaw: string | null | undefined;
  sourceConfig: Record<string, unknown> | null | undefined;
};
type ProofApi = {
  ready: boolean;
  snapshot: () => Snapshot;
  reloadSerialized: () => Snapshot;
};

declare global {
  interface Window {
    automationDefaultsProof: ProofApi;
  }
}
