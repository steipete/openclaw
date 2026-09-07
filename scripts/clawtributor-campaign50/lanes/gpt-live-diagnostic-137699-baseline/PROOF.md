# #137699 baseline design

This packet has not been executed. It is for independent artifact review before
the campaign controller copies it into the existing secretless fork workflow.
No source patch or custom auth/privilege seam is included.

Pinned source: b3d67aa9b80bd95ff696332ec8cc8c25e40a191d (fresh main read via
GitHub API). Its complete controller matches the previously inspected source,
SHA256 6db930195804b1e6d5233217a7084a555aa62230c60188b691b4cc2fe15d6f5c.
The source package manifest requires pnpm12.3.4 and Vitest5. Node24.20.0 is pinned.

The driver uses the actual production controller's handleFrame path, existing
parser, constructor injection, normalized error formatter, diagnostic logger
boundary, and output append encoder. The runner is an ordinary controlled
failure callback, as in the existing delegation test. It performs no agent
execution, model/provider request, socket connection, auth operation, or
privileged delegation. The socket is an output recorder and logger warnings
are persisted as real UTF8 bytes in the evidence directory.

Eight fresh controllers run sequentially. Two explicitly expected baseline
defects cross the180 UTF16-unit boundary, directly and after whitespace collapse.
Their logged string contains a lone high surrogate, isWellFormed is false, and
writing/reading UTF8 substitutes U+FFFD. The independent expected output stops
before the astral character. Six controls cover an astral character wholly
within the cap, one wholly after it, a multibyte BMP string at the cap,
whitespace-only fallback, ordinary failure, and the existing injected formatter
contract. The normalized-boundary oracle deliberately retains the trailing
space produced when truncation occurs after trim; moving trim after truncation
would change this result.

Each case requires one consult call and one formatter call with the exact
error object, in order consult -> format -> warn -> send, no fatal callback,
the exact fixed safe client response, and a diagnostic no longer than180
UTF16 units. The custom formatter control returns a distinct ordinary host
diagnostic through the existing injected callback, proving the controller
consumes that result rather than raw error.message. Other cases use the real
production formatter directly. No redaction policy is changed or bypassed.

The original controller owner suite is then run unchanged, retaining existing
ordinary failure, timeout, structured error, cancellation, detach, queue and
native-control regression coverage. A separate validator requires successful,
nonempty JSON with every assertion passed and none skipped, plus matching
completed verbose file/test totals, Start at and Duration markers. It rejects
failure/global-error headings without matching passing test titles that mention
errors. Both Git guards compare with HEAD, including staged changes. The controller driver checks
all eight cases itself and writes behavior.json only after exact assertions.
Baseline completion means two confirmed formatting defects plus six controls,
not a green product result.

The runner verifies the pinned Git source and controller hash, records the
controller, real callers, parser, wire owner, SDK export, formatter and Unicode
helper source hashes before execution, and checks them unchanged afterward.
Standard campaign bootstrap binds the full source/runtime and empty environment.
Both browser and Gateway relay use this controller; this packet does not
pretend to establish a live provider call or lifecycle repair.

Only syntax checks of these artifacts are authorized locally. Product edits,
claims, native worktree setup, Git/public writes and execution await root's
explicit next gate. The eventual green driver must use the same cases and
normalization/ordering/output controls against the reviewed repaired source.
