"""Hosted-only instrumentation of the existing real-process cron fixture."""
from pathlib import Path
import sys

target = Path(sys.argv[1])
source = target.read_text()


def replace_once(old, new):
    global source
    assert source.count(old) == 1, repr(old)
    source = source.replace(old, new)


replace_once(
    '      let command: ReturnType<typeof runCronCommandJob> | undefined;\n      try {',
    '''      let command: ReturnType<typeof runCronCommandJob> | undefined;
      const realClearTimeout = clearTimeout;
      const nativeKill = process.kill.bind(process);
      let holdGroupObservation = false;
      let groupPolls = 0;
      let forceAttempts = 0;
      let forceOutcome: string | undefined;
      let commandSettled = false;
      let observedChildPid = 0;
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      const groupObservation = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (parent?.pid && pid === -parent.pid) {
          if (signal === "SIGKILL") {
            forceAttempts += 1;
            try {
              const result = nativeKill(pid, signal);
              forceOutcome = result ? "sent" : "returned-false";
              return result;
            } catch (error) {
              forceOutcome = (error as NodeJS.ErrnoException).code ?? "unknown-error";
              throw error;
            }
          }
          if (signal === 0 && holdGroupObservation) {
            groupPolls += 1;
            return true;
          }
        }
        return nativeKill(pid, signal);
      });
      try {''',
)
replace_once(
    '          abortSignal: controller.signal,\n        });',
    '''          abortSignal: controller.signal,
        }).then((result) => {
          commandSettled = true;
          return result;
        });''',
)
replace_once(
    '        await vi.advanceTimersByTimeAsync(500);',
    '''        observedChildPid = childPid;
        holdGroupObservation = true;
        await vi.advanceTimersByTimeAsync(500);''',
)
# This anchor ends at the first grace phase in both baseline and candidate.
replace_once(
    '''        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);''',
    '''        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(execSpawn.COMMAND_PROCESS_TREE_KILL_GRACE_MS);
        holdGroupObservation = false;
        expect(forceAttempts, "CRON_FORCE_SEND_NOT_OBSERVED").toBe(1);
        expect(groupPolls, "CRON_GROUP_OBSERVATION_NOT_EXERCISED").toBeGreaterThan(1);
        expect(commandSettled, "CRON_SETTLED_BEFORE_OBSERVATION").toBe(false);
        expect(vi.getTimerCount(), "CRON_OBSERVATION_POLL_NOT_QUEUED").toBeGreaterThan(0);
        console.log("CRON_PHASE_PROOF " + JSON.stringify({
          phase: "observation-pending", forceAttempts, forceOutcome, groupPolls,
          pendingTimers: vi.getTimerCount(), commandSettled,
          observationReleased: !holdGroupObservation,
        }));''',
)
replace_once(
    '        const result = await command;',
    '''        const result = await Promise.race([
          command,
          new Promise<never>((_, reject) => {
            completionTimer = realSetTimeout(() => {
              reject(new Error("CRON_OBSERVATION_CLOCK_FROZEN"));
            }, 1_000);
          }),
        ]);
        realClearTimeout(completionTimer);
        console.log("CRON_PHASE_PROOF " + JSON.stringify({ phase: "completed", commandSettled }));''',
)
replace_once(
    '''      } finally {
        try {
          controller.abort();''',
    '''      } finally {
        holdGroupObservation = false;
        groupObservation.mockRestore();
        realClearTimeout(completionTimer);
        try {
          controller.abort();''',
)
replace_once(
    '''          spawnSpy.mockRestore();
          await command;
        }
      }''',
    '''          spawnSpy.mockRestore();
          await command;
          const childGone = observedChildPid > 0 && await waitForPidToExit(observedChildPid);
          expect(childGone, "CRON_PROOF_CHILD_CLEANUP_FAILED").toBe(true);
          console.log("CRON_PHASE_PROOF " + JSON.stringify({
            phase: "cleanup", childGone, commandSettled,
            fakeTimers: vi.isFakeTimers(), observationReleased: !holdGroupObservation,
          }));
        }
      }''',
)
target.write_text(source)
