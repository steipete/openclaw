// Bundle-mode fallback registry: when a single-file bundle is shipped without
// the extensions/ tree, the public-surface loaders can consult this registry
// before throwing "Unable to resolve bundled plugin public surface" errors.
//
// Each stub matches the runtime-api shape of an extension that is intentionally
// disabled in the bundle (e.g. TTS, when speech-core is not available). Real
// installs continue to load the on-disk runtime first; the registry only kicks
// in when filesystem resolution fails.

import speechCoreRuntimeApiStub from "./speech-core-runtime-api.js";

const REGISTRY: Record<string, () => unknown> = {
  "speech-core/runtime-api.js": () => speechCoreRuntimeApiStub,
};

export function getBundledPluginPublicSurfaceStub(params: {
  dirName: string;
  artifactBasename: string;
}): unknown {
  const factory = REGISTRY[`${params.dirName}/${params.artifactBasename}`];
  return factory ? factory() : undefined;
}

export function hasBundledPluginPublicSurfaceStub(params: {
  dirName: string;
  artifactBasename: string;
}): boolean {
  return `${params.dirName}/${params.artifactBasename}` in REGISTRY;
}
