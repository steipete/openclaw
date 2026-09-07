"""Own bounded proof children; retain fixtures when cleanup cannot prove quiescence."""
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import time

CHILDREN = []


class CapturedChild:
    def __init__(self, argv, cwd, env, evidence, name, limit=1048576):
        self.prefix = Path(evidence) / name
        self.started = time.monotonic()
        self.limit = limit
        self.argv = argv
        self.buffers = {"stdout": bytearray(), "stderr": bytearray()}
        self.files = {}
        self.selector = selectors.DefaultSelector()
        self.forced = []
        self.proc = None
        self.eof = {"stdout": False, "stderr": False}
        self.sealed = False
        CHILDREN.append(self)
        try:
            for key in self.buffers:
                self.files[key] = open(str(self.prefix) + "." + key, "wb")
            self.proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         start_new_session=True)
            for name, stream in [("stdout", self.proc.stdout), ("stderr", self.proc.stderr)]:
                os.set_blocking(stream.fileno(), False)
                self.selector.register(stream, selectors.EVENT_READ, name)
        except BaseException:
            self.cleanup_failure()
            raise

    def group_gone(self):
        if self.proc is None:
            return True
        try:
            os.killpg(self.proc.pid, 0)
            return False
        except ProcessLookupError:
            return True

    def quiescent(self):
        return self.proc is None or (self.proc.poll() is not None and self.group_gone())

    def pump_until(self, predicate, seconds):
        deadline = time.monotonic() + seconds
        while not predicate():
            if time.monotonic() >= deadline:
                raise TimeoutError("proof child deadline exceeded")
            for key, _ in self.selector.select(min(0.1, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    self.eof[key.data] = True
                    self.selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                name = key.data
                remaining = self.limit - len(self.buffers[name])
                self.files[name].write(data[:remaining])
                self.files[name].flush()
                self.buffers[name].extend(data[:remaining])
                if len(data) > remaining:
                    raise RuntimeError(name + " output exceeded proof cap")
            if self.proc.poll() is not None and not self.selector.get_map() and not predicate():
                raise RuntimeError("proof child exited before expected observation")

    def send(self, value):
        self.proc.stdin.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
        self.proc.stdin.flush()

    def finish(self, seconds=60):
        if self.proc.stdin and not self.proc.stdin.closed:
            self.proc.stdin.close()
        self.pump_until(lambda: self.proc.poll() is not None and not self.selector.get_map(), seconds)
        code = self.proc.wait()
        self._seal()
        if code != 0 or self.forced or not all(self.eof.values()) or not self.quiescent():
            raise RuntimeError("normal exit, pipe EOF and process-group completion were not proven")
        return bytes(self.buffers["stdout"])

    def _seal(self):
        for f in self.files.values():
            f.close()
        self.selector.close()
        self.sealed = True
        receipt = {"argv": self.argv, "spawned": self.proc is not None,
                   "pid": self.proc.pid if self.proc else None,
                   "exitCode": self.proc.poll() if self.proc else None,
                   "reaped": self.proc is None or self.proc.poll() is not None,
                   "forcedSignals": self.forced, "pipeEOF": all(self.eof.values()),
                   "processGroupGone": self.group_gone(), "quiescent": self.quiescent(),
                   "elapsedSeconds": time.monotonic() - self.started,
                   "bytes": {k: len(v) for k, v in self.buffers.items()}}
        Path(str(self.prefix) + ".outcome.json").write_text(json.dumps(receipt, indent=2) + "\n")

    def cleanup_failure(self):
        if self.sealed and self.quiescent():
            return
        if self.proc is not None:
            for sig in [signal.SIGTERM, signal.SIGKILL]:
                if self.quiescent():
                    break
                if not self.group_gone():
                    try:
                        os.killpg(self.proc.pid, sig)
                        self.forced.append(sig.name)
                    except ProcessLookupError:
                        pass
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not self.quiescent():
                    time.sleep(0.05)
            for stream in [self.proc.stdin, self.proc.stdout, self.proc.stderr]:
                if stream and not stream.closed:
                    stream.close()
        self._seal()


def run(argv, cwd, env, evidence, name, seconds=60):
    child = CapturedChild(argv, cwd, env, evidence, name)
    try:
        return child.finish(seconds)
    finally:
        child.cleanup_failure()


def cleanup_owned(owned, evidence):
    pending = [str(child.prefix.name) for child in CHILDREN if not child.quiescent()]
    receipt = {"path": str(owned), "retained": bool(pending), "pendingChildren": pending,
               "spawnRecords": len(CHILDREN), "absent": False}
    if not pending:
        shutil.rmtree(owned)
        receipt["absent"] = not owned.exists()
    Path(evidence, "cleanup.json").write_text(json.dumps(receipt, indent=2) + "\n")
    if pending:
        raise RuntimeError("owned fixture retained: child/group termination remains unproven")
