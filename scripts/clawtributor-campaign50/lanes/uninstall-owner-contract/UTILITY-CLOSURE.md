# Selected POSIX utility closure

The first executable packet omitted ln; that failed source review before any run. The complete selected owner paths were reread for this correction. Each name below resolves to the existing real utility; the PATH contains links, not mock commands.

- Shell/launch: bash, sh, env. Installer child shells and pnpm/npm script commands use actual shells; source functions never share a shell between cases.
- Path and source fixture handling: git, basename, dirname, ls, mkdir, rm, readlink. Git receives a committed existing checkout and a full existing SHA, so no clone/fetch/rebase branch is needed; no SSH helper is exposed.
- Atomic wrapper/runtime/profile publication: mktemp, cat, chmod, mv, cp, ln. link_node_runtime_paths and install_node's existing-runtime path use ln; the Git owner/profile publisher uses cp/stat/id and temporary rename. All destinations are within the newly registered root.
- Profile/path inspection: grep, sed, awk, stat, id, head, tail, tr. resolve_safe_profile_target, prepare_safe_profile_parent and persist_path_line_to_profile were read in full; readonly profile content is a synthetic file under the case HOME.
- Platform/metadata and diagnostic calls: uname, ldd, date, df, sort, wc. Node/npm are copied or linked verbatim from the pinned official Node archive. linked_node_is_usable checks the actual runtime/npm/SQLite contract before accepting the alias.
- Node/npm/pnpm run their inspected official installed code. The package has no dependencies or installation hooks; its only explicit scripts invoke Node to write the synthetic UI marker or copy the synthetic CLI entry.

Excluded branches are explicit, not faked successes: the fixture HOME already exists, Git is present and the checkout committed, the requested SHA is already local, no prompting/onboarding or Gum/bootstrap/main flow runs, the admitted runtime exists and passes its real probe, and no real Gateway is invoked. Corepack is absent, selecting the canonical npm fallback. Runtime download/bootstrap tools (curl/wget/apk/apt/brew) are not exposed. Any attempt to need that different branch fails this bounded proof rather than silently installing a different tool.

Separate child shells still isolate functions and traps after removing inner start_new_session. The only process-group owner on Linux is the outer supervisor; per-command receipts do not imply a separate group disappeared. Final whole-root cleanup occurs outside that group after its observed completion. This is not a general daemon/detach containment test.
