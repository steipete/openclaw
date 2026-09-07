# #139075 exact baseline packet

This packet has not executed. It contains no product patch, native claim or
checkout operation. Root dispatch and independent frozen-packet acceptance are
required. Source is2d58961f33fd48b94b48bf569b65fb1c6ad2d954; Node24.20.0,
pnpm12.3.4 and the source-declared esbuild0.28.2 are pinned.

The driver creates four independent synthetic host/plugin projects, then invokes
the actual source's scripts/build-plugin-control-ui.mts through its normal tsx
preload. This script performs the real browser build and manifest write. Every
invocation is a fresh joined child with a bounded120second timeout, complete
stdout/stderr and an explicit status/signal/error receipt. No credentials,
Gateway, network/provider request, or privileged operation is needed.

The matrix is source+stale-dist versus genuinely dist-only, each with NODE_ENV
absent or production from process start. Fixture source has no environment
branches; SDK and workspace markers are named exports so the compiler retains
them. The source/default control must export current-source markers. The
source/production baseline must export stale compiled markers and publish a
different generation hash. Both packaged cases must export compiled markers
and agree on their hash. Each plugin also exports an independent local marker
and has a real CSS asset.

Package selection uses the supported physical host layout, not a development
source override. Each plugin lives under host/plugins/proof, beneath its own
recognized openclaw package.json. Current sdk-alias prioritizes the entry's cwd
package-root search. The source fixture is born with SDK/workspace src files;
the packaged fixture is born without either source tree. No source is removed
under a populated cache. OPENCLAW_DEV_SOURCE_ROOT must be absent: current
resolveOpenClawDevSourceRoot requires src and extensions and cannot represent a
dist-only host. Only the requested test NODE_ENV input differs between children;
no product code forces or clears the operator's environment.

check-artifact.mjs invokes the actual build owner with check:true, then imports
the emitted synthetic module to verify observable marker exports and records
the actual compiler version. The canonical build script has no --check flag;
none is invented. Check calls must leave manifest bytes, asset digests and
existing generation lists unchanged.

For all four cases the driver recomputes the generation hash from the actual
sorted filenames, byte lengths and bytes, checks manifest entry/styles against
real assets, and verifies a repeat build preserves the exact manifest, bytes
and directory inventory. No staging directory may remain. Raw manifests,
compiled JS/CSS, digests and fixture input bytes are retained in evidence.

The source/default case additionally changes its local exported marker. The
real owner check must fail as stale without publishing. A subsequent actual
script build must create a different generation; check/import must expose the
new marker while old generation bytes remain intact. A final ordinary missing
relative module forces compilation failure; the previous manifest and completed
generation must remain byte-identical. This is not a hostile path, race,
permission bypass or crash scenario.

The original browser-build owner suite runs unchanged afterward. Its complete
JSON and verbose summaries must show a nonzero all-passed result with no skips
or global diagnostic headings. It retains the existing Windows EPERM collision
and mismatched-asset preservation tests, supplementing the real repeat-build
collision proof. No errno or runtime policy is changed by this baseline.

All11 source/package hashes are checked before and after. The bootstrap binds
the full clean Git source and isolated environment; the runner requires an
unchanged HEAD diff. Cleanup removes only its own mkdtemp workspace and emits a
receipt. Actual build/inspection subprocesses are synchronously joined. A run
is complete only if the artifact, owner suite, source and cleanup gates all pass;
setup failures must not be relabeled an observed defect.

The expected baseline result is one matrix row demonstrating two stale embedded
markers, three matrix controls, and all generation/check/failure preservation
controls. Future candidate proof must use the same fixture contracts with the
source/production oracle changed to current-source markers; packaged fallback
and every preservation control remain unchanged. This packet does not claim a
full managed-Gateway update or service restart.
