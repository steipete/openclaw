# Nextcloud structured-command baseline proof

This baseline-only hosted proof packet was sealed after maintainer source review and automated review. It contains no candidate production overlay and cannot execute a candidate head. No product or test execution has occurred while authoring this packet.

The workflow checks out immutable OpenClaw main `50f02ecf4410c78269d7bbda7c47d891c9666d19` (tree `ffdb218beec301f502379390f37319ac6ba52825`) separately from the proof assets. It uses one GitHub-hosted `ubuntu-24.04` job, pinned action commits, Node 24.19.0, the package's integrity-pinned pnpm 12.1.0, and a fresh frozen dependency install. Runtime commands receive an explicit environment with fresh private HOME, XDG, temporary and OpenClaw state directories. No saved credentials, IAM role, external model, AWS machine, installer, or production service is involved. Checkout credentials are not persisted. Publication belongs only to the temporary `codex/round10-nextcloud-baseline-proof` branch of the existing public fork; no upstream workflow is proposed.

## Required observations

The controller first runs the exact permanent-test overlay through the canonical messaging Vitest project. It requires 21 named cases: 16 pass and exactly five structured-command regressions fail, with no skip, todo, module/hook failure, unhandled error, or incomplete-test warning. Each failure must be an assertion at its bound source line and have a matching named verbose failure block. Four projection cases require the exact expected command and observed structured raw value. The unauthorized case requires the unexpected mention-builder call at line 297: it proves that the early command-authorization return was missed, not that an unauthorized reply was dispatched. The unchanged fixture later drops before dispatch. The exact 21 title inventory includes Vitest 4.1.11 string quoting and truncation for `$label` interpolation; no names or failures are accepted by fuzzy matching. A setup error is never baseline RED. The installed Vitest 4.1.11 JsonReporter source was inspected directly: `dist/chunks/index.UpGiHP7g.js:3522–3625`; file-level `message` represents file errors, while individual assertion errors are in `assertionResults.failureMessages`. Its exact source and lockfile patch hashes are recorded.

Only after that original RED is established does the controller build the canonical `qaRuntime` profile with private QA enabled and record every build artifact. The fixture launches the actual built `dist/index.js` Gateway through the existing QA lifetime owner. It uses the actual Nextcloud plugin, webhook HMAC verification, durable ingress spool, access policy, core command path, and signed bot-message transport, with a synthetic loopback Talk HTTP service and the existing mock model provider.

Eleven baseline cases must all complete with their specific observed outcome:

| Case | Baseline outcome |
| --- | --- |
| Plain DM `/help` | Actual core help reply; no model call |
| Plain DM `/status` | Actual core status reply; no model call |
| Structured DM `/help` | One model call containing the original raw JSON; accepted signed reply |
| Structured DM `/status` | One model call containing the original raw JSON; accepted signed reply |
| Structured group command without mention | Exact mention-policy drop and completed ingress row |
| Structured Bob command in room-only account | One model call and accepted reply; room access does not authorize commands |
| Structured command in unlisted room | Exact room-policy drop and completed ingress row |
| Ordinary rich message | One model call preserving original raw content |
| Malformed JSON text | One model call preserving original raw content |
| Invalid webhook HMAC | HTTP 401, no durable marker, no ingress row, no dispatch |
| Replay of completed plain-help event | Same completed tombstone and unchanged outbound/provider inventory |

The second `roomonly` account has explicit empty global allowlists and a room-only Bob allowlist. This is a canonical existing configuration, not a policy override: the account merger preserves those empty arrays, so Bob passes room sender access but obtains no command-owner/group authority. POSTs, ingress reads, and startup observations bind the same account. Default-account discovery is preserved by the plugin's existing implicit baseUrl/secret rule. Two real webhook listeners are required.

## Source, build and process identity

The binding contains 96 exact source hashes, including all changed owners, caller/transport/policy/ingress boundaries, QA launch/cleanup/staging owners, command owners, tests, build/runtime loaders, and dependency lock/patch. The controller additionally records and compares every tracked path and the complete Git index, including its raw bytes, stage entries and flags. Only the bound permanent test file may differ from unchanged main. Guards run after install, immediately after test execution before result parsing, after build, after Gateway execution, and after restoring the test. The frozen installed lock and every proof asset are rechecked. The runtime proof file is new and task-owned; it is removed only after confirmed closure.

Every staged plugin file is compared with the immutable build inventory, except canonical source manifests explicitly mapped by the staging owner. Talk, QA Lab and OpenAI must be present. If the build contains generated `image-generation-core` files, it must also be staged and all of its actual files must match; source-directory absence is not treated as runtime absence. This includes generated package/runtime files without inventing a source manifest. Staging and the complete build inventory are unchanged across the run.

The Gateway child identity combines the requested launch executable and `dist/index.js` prefix at the canonical parent owner, the returned actual PID, and observed `/proc/<pid>/exe`. Linux proc command-line bytes are labeled as the observed `openclaw-gateway` process title; they are not mislabeled as original argv because Node rewrites them. The relevant entry and run-loop owners are bound.

## Lifetime and limits

A completed ingress row means adoption, not natural turn settlement. For policy drops, the handler returns before dispatch and the ingress monitor then records adoption, so the exact drop diagnostic plus the completed row identifies a completed intentional non-outcome. Dispatched cases additionally require the real processed diagnostic, actual accepted signed reply, and exact model-request contents/count. Those observations do not expose the unmodified dispatcher's final return.

The fixture therefore retains the individual observations, stops the child through its canonical cached lifetime, and then reads the final provider request and inflight inventories while the external mock remains alive. It requires no inflight provider payloads and exact equality between final requests/replies and the case inventories. Finally the original QA owner closes the mock and must report `confirmed-stopped` with no errors. This proves process closure and rejects late/unattributed calls; it does not claim per-case natural settlement or that mock inflight state is a Gateway-wide settlement barrier. No observer plugin, quiet-period delay, guessed idle state, custom kill path, or increased product timeout is introduced.

The controller records command leader exit and its process-group absence; detached Gateway closure separately requires the canonical child receipt. On failure, missing closure retains the private runtime for hosted-runner disposal, records the gap and fails the proof. No runtime HOME, config, auth or state database is copied into evidence. Per-command output is capped at 16 MiB, copied child logs at 4 MiB each, and the evidence inventory at 64 MiB. Existing canonical Gateway lifetimes are retained; the outer command has a 780-second execution bound plus its cleanup reserve, with a 90-minute workflow bound.

The proof targets the published Nextcloud wire contract (Spreed commit `1c6d1c787b8198402c74e75939e246bbda890a0c`): ActivityPub JSON content, random-plus-body webhook signing and random-plus-message bot signing, and the bot endpoint's HTTP 201/null-data response. Source snapshots are retained in the preflight packet. This is not an authenticated Nextcloud deployment, native client command interception, external API live run, or Codex runtime proof. Passing this baseline packet alone does not validate the proposed production fix or authorize landing.
