# #127254 executable ownership-proof candidate

This packet is FILE-ONLY and has not executed. Root must grant execution after independent executable/tool/backend/controller review. Source/preservation proposal95a17445 and canonical parser acceptance are separate completed evidence. Do not infer execution authorization from a local packet's stage field.

The invariant is installation ownership: real global npm removal must remove its package control but leave independently owned Git/prefix launchers callable; removing the actual recorded owner must eliminate that launcher while preserving the named synthetic data and shared tools. The credible failure is following the existing uninstall guide's universal npm instruction, or deleting a checkout/prefix while leaving its launcher or deleting unrelated files.

Existing unit/mocked installer tests and documentation comparisons do not demonstrate this real producer/removal mismatch. This artifact uses unchanged current installer functions, real Node/npm/pnpm/Git and native shell resolution against an explicitly synthetic package. It creates no production seam; POSIX NO_RUN controls and actual Windows dry-run/owner functions already exist. No permanent repository regression test or runtime change is proposed for this docs-only repair.

Entrypoints:

- Linux: existing workflow env-i → proposed tightly guarded lane bootstrap-linux.sh → run.sh → launch-driver.py → driver.py.
- Windows: existing workflow's lane-local bootstrap-windows.ps1 → a fresh environment/NoProfile worker → run.ps1 → launch-driver.py → driver.py. This exact new bootstrap requires review, not inherited approval from earlier Windows lanes.
- Each owner command runs in a separate child shell while inheriting the outer managed group/job. Per-command receipts prove direct exit and EOF; only the outer owner proves final inherited-tree quiescence and deletes its registered root afterward. Windows bootstrap and driver Job Objects may be nested; inner commands do not create their own jobs. Generic daemon/detach containment is not claimed.
- verifier input/source gates run before driver imports and after the complete lane. Root/controller binds the reviewed packet to the immutable harness commit used by the actual job.

The small package/checkouts are fixtures, not an OpenClaw CLI or build. Only the real installers' selected owner functions run; no complete installer main, onboarding, doctor, Gateway/service, provider, user install, release or deployment is part of the claimed proof. Linux is not native macOS or WSL proof. State/prefix overlap and service/workspace semantics remain source-backed qualifications, not tested uninstaller behavior.

The packet preserves separately reviewed public Node/npm/pnpm integrity data, source copies and source pins. See BACKEND-DESIGN.md and TOOL-LOCK.json for exact archive pins, platform-tool inventory admission limits, queue requirements and the proposed controller delta. Native platform source/utility versions are recorded at preflight; their proposed allowed ranges still require independent/root acceptance. No new backend has been acquired.

Expected artifact data: input-before/after, runtime/platform/pnpm admissions, raw per-child streams and immutable after-quiescence process outcomes, produced launcher bytes, profile/user-PATH facts, cases.json, cleanup.json, outer driver-process receipts, final untouched source patch and acceptance.json. The outer Windows bootstrap additionally retains its own terminal/EOF/cleanup receipt. Any input drift, unexpected retry, forced termination, missing EOF, unresolved ownership/cleanup or failure rejects qualification rather than relabeling it as success.

Linux deliberately has no competing GNU timeout around the managed supervisor. The driver/group deadline remains840seconds; inert controls are separately bounded. Windows has an additional900second managed outer Job Object. The unchanged GitHub job limit is not presented as the driver deadline.
