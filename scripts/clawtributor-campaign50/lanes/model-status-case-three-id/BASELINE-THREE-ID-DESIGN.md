# 140099 one revised baseline design — pending independent acceptance

This is a new three-ID scenario. The first two-ID scenario is honestly classified NONREPRODUCTION in NONREPRODUCTION.md; do not reinterpret or rerun it. Root authorized at most one revised baseline after independent design/driver review. If this scenario is also healthy, stop qualification. No production edit is authorized before accepted actual red.

Use the same protected55d source, runtime pins, ordinary built CLI, canonical explicit qa agent, empty utilityModel, dummy-only child environment, custom .test endpoint metadata, no --probe, fresh HOME/state per case, retained full results and fail-propagating cleanup as the first design. No provider API is authored, no static manifest adapter is assumed, and no catalog rows are injected.

Both cases contain THREE model rows with identical adapter facts:

| Row             | Healthy control ID | Collision case ID | Explicit API       |
| --------------- | ------------------ | ----------------- | ------------------ |
| Primary         | Reader             | Reader            | openai-completions |
| First fallback  | Writer             | rEaDeR            | openai-responses   |
| Second fallback | reader             | reader            | absent             |

Each name equals its ID. Change only the first fallback's ID/name and its matching configured fallback/allow refs between the cases. Provider baseUrl remains https://models.example.test/v1; provider api remains absent. All three refs are actual text consumers via primary+fallbacks, with all three allowed. This holds API facts constant while changing whether the Responses row shares the lowercased status key.

Actual producer rationale: the two explicit model APIs survive generated-catalog validation and registry parsing without any inherited provider API. The API-less reader remains represented by its configured catalog metadata. In the control, reader shares only Reader's Completions observation; Writer's Responses row has a different key. In the collision case, rEaDeR's independently authored Responses row enters the same lowercase key as Reader and reader. Complete authored routes on Reader and rEaDeR stay healthy by policy. Only reader's absent-adapter fallback sees both concrete Platform APIs and should report the precise ambiguity.

Control assertions: ordinary numeric exit0, exact qa/Reader primary, fallbacks [openai/Writer,openai/reader], exact three allowed refs, disabled utility, no images, no missingProvidersInUse, empty runtimeAuthRoutes and empty modelRouteIssues. The control must finish healthy before running the collision case.

Collision assertions: ordinary numeric exit1, exact qa/Reader primary, fallbacks [openai/rEaDeR,openai/reader], exact three allowed refs and all other control fields unchanged. modelRouteIssues must contain exactly one incompatible reader issue with code ambiguous-openai-route-group and message "Observed OpenAI routes disagree on the Platform adapter for an authored endpoint." Missing provider auth and runtime route arrays remain empty. Any missing row, config validation failure, unknown/global exception, setup error, timeout, other issue or cleanup failure rejects proof; never accept it as expected red.

Use a separate proof-three-id artifact directory and scenario-labelled output so the first packet/run stay immutable. The driver must retain raw config/stdout/stderr/process result before assertions. Keep all existing source-before/after and build gates; baseline source/driver must be bound by exact hashes. Later candidate proof, if authorized after observed red, must run byte-identical cases and turn only the collision case's false diagnostic/exit1 into healthy exit0. CLI JSON does not expose selected APIs; do not claim it does.

No production helper, policy, auth/routing path, config default, persistence or schema change is introduced by the proof design. This is still a proposed failure, not an observed one.
