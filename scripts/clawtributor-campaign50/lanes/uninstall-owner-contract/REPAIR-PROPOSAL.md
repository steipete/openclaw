# Wave77 managed-review owner corrections

This file-only successor starts from preserved copied packet030ccb4c, including its canonical fixture formatting and byte-identical .txt source transports. Original030c/afeba is held and unexecuted. Source/docs95a remains accepted; no product source or PR branch changes are made here.

## Separate npm configuration owners

The exact Node24.20.0 bundle contains npm11.19.0 and @npmcli/config10.12.0. The downloaded official config index is byte-identical to the locally inspected installed source. Its load sequence loads user then global configuration; #loadFile passes the filename into #loadObject, whose sources map rejects reuse by another layer even when the file is empty. Therefore the prior one-file environment fails before meaningful owner proof.

The driver now creates two empty owned files, user.npmrc and global.npmrc, and binds each corresponding environment variable separately. Only user.npmrc later receives the already reviewed offline setting; the global layer stays explicitly empty. No environment key, registry policy, lifecycle behavior, prefix owner or source/tool version changes.

## Precisely owned Windows readonly-file removal

Git-for-Windows' create_tmpfile opens loose objects with mode0444. The three reviewed CPython3.12/3.13/3.14 shutil implementations forward an unlink error to onexc; default behavior raises it. Windows DeleteFile rejects readonly files, and Python documents clearing the readonly flag for this case. The relevant raw source snapshots and primary documentation locators are retained in repair-source/SOURCE-PINS.json and repair-source/PLATFORM-CONTRACTS.md.

One shared remove_owned_tree helper now serves both selective checkout/prefix cleanup and outer final-root cleanup. It validates the regular, non-reparse directory and its containment under the registered root. Ordinary rmtree behavior is retained; only an os.unlink PermissionError with Windows error5 is eligible for recovery. The failed leaf must be a readonly single-link regular non-reparse file physically within the selected tree, with an unchanged registered-root identity. The helper clears only that file's readonly bit, verifies the same regular file identity/attributes again, and retries that exact unlink once. Shared hardlinks, other errors and any retry failure propagate; no ignore_errors, recursive chmod, ACL edits, broad retries or outside-root permission changes are added.

Selective tree removal additionally requires all prior command receipts to show normal completion. The outer owner still waits for its complete managed group/job and checks the root's original device/inode before calling the same helper. The existing failure retention, lexists removal facts, full preserved-marker sets, process bounds, Windows PATH restoration, and independent raw checker remain intact. This is proof-fixture cleanup, not new OpenClaw uninstall behavior or generic daemon/symlink-race hardening.

No target/control/native Windows or deletion behavior has executed in this authoring phase. Existing real Git checkout creation/removal and the actual npm version/owner flow will exercise both corrections in the eventual admitted proof. Independent full verifier reacceptance and controller/root execution grant are required; older acceptance is not reused as execution readiness.
