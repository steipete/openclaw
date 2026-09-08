"""Bound actual proof processes and seal receipts only after authoritative quiescence."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

class Collector:
    def __init__(self, evidence, lane, own_tree=False):
        self.evidence = Path(evidence)
        self.lane = Path(lane)
        self.own_tree = own_tree
        self.records = []
        self.pending = []

    def run(self, argv, cwd, env, name, seconds=120, expected=0):
        if not name.replace('-', '').isalnum() or any(r['name'] == name for r in self.records):
            raise ValueError('unsafe or repeated output name')
        entry = {'name': name, 'argv': [str(x) for x in argv], 'cwd': str(cwd),
                 'spawned': False, 'released': False, 'forced': [], 'expectedExit': expected, 'ownsTree': self.own_tree}
        self.records.append(entry)
        proc = None
        job = None
        assigned = False
        readers = []
        buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        eof = {'stdout': False, 'stderr': False}
        errors = []
        lock = threading.Lock()
        started = time.monotonic()
        limit = 1048576
        def read_stream(key, stream):
            try:
                with open(self.evidence / (name + '.' + key), 'wb', buffering=0) as output:
                    while True:
                        data = stream.read(65536)
                        if not data:
                            eof[key] = True
                            return
                        with lock:
                            remaining = limit - len(buffers[key])
                            output.write(data[:remaining])
                            buffers[key].extend(data[:remaining])
                            if len(data) > remaining and not errors:
                                errors.append('stream cap exceeded')
            except BaseException as error:
                errors.append(type(error).__name__ + ': ' + str(error))
            finally:
                stream.close()
        def tree_gone():
            if proc is None:
                return True
            if not self.own_tree:
                return proc.poll() is not None
            if os.name == 'nt':
                try:
                    return job.accounting()['active'] == 0 if assigned else proc.poll() is not None
                except OSError as error:
                    errors.append('job accounting failed: ' + str(error))
                    return False
            try:
                os.killpg(proc.pid, 0)
                return False
            except ProcessLookupError:
                return True
        def complete():
            return proc is not None and proc.poll() is not None and tree_gone() and all(eof.values()) and all(not t.is_alive() for t in readers)
        failure = None
        try:
            if os.name == 'nt' and self.own_tree:
                from windows_job import WindowsJob
                job = WindowsJob()
            proc = subprocess.Popen([sys.executable, '-I', '-S', str(self.lane / 'bridge.py')], cwd=cwd,
                                    env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, start_new_session=self.own_tree and os.name != 'nt')
            entry.update(spawned=True, pid=proc.pid)
            if os.name != 'nt':
                entry['groupId'] = os.getpgid(proc.pid)
                expected_group = proc.pid if self.own_tree else os.getpgrp()
                if entry['groupId'] != expected_group:
                    raise RuntimeError('command is outside the expected managed group')
            if job:
                job.assign(proc)
                assigned = True
            for key in ['stdout', 'stderr']:
                thread = threading.Thread(target=read_stream, args=(key, getattr(proc, key)), daemon=True)
                thread.start()
                readers.append(thread)
            # Target execution starts only after process group / Job Object containment exists.
            proc.stdin.write((json.dumps({'argv': entry['argv']}) + '\n').encode())
            proc.stdin.close()
            entry['released'] = True
            deadline = started + seconds
            while not complete():
                if errors:
                    raise RuntimeError(errors[0])
                if proc.poll() is not None and proc.returncode != expected:
                    raise RuntimeError('command failed before pipe/tree completion')
                if time.monotonic() >= deadline:
                    raise TimeoutError('bounded child/pipe/process-tree deadline')
                time.sleep(0.02)
            code = proc.wait()
            if code != expected:
                raise RuntimeError(f'expected exit {expected}, observed {code}')
        except BaseException as error:
            failure = error
            if proc is not None and not tree_gone():
                if not self.own_tree:
                    entry['forced'].append('terminate-command-bridge')
                    proc.terminate()
                elif os.name == 'nt':
                    entry['forced'].append('TerminateJobObject' if assigned else 'terminate-unreleased-bridge')
                    job.terminate() if assigned else proc.terminate()
                else:
                    for sig in [signal.SIGTERM, signal.SIGKILL]:
                        if tree_gone():
                            break
                        entry['forced'].append(sig.name)
                        try:
                            os.killpg(proc.pid, sig)
                        except ProcessLookupError:
                            pass
                        until = time.monotonic() + 5
                        while time.monotonic() < until and not tree_gone():
                            proc.poll()
                            time.sleep(0.02)
            if proc is not None:
                if proc.stdin and not proc.stdin.closed:
                    proc.stdin.close()
                until = time.monotonic() + 10
                while time.monotonic() < until and not complete():
                    time.sleep(0.02)
        finally:
            gone = tree_gone()
            reaped = proc is None or proc.poll() is not None
            joined = all(not t.is_alive() for t in readers)
            quiescent = gone and reaped and joined
            entry.update(exitCode=proc.poll() if proc else None, reaped=reaped,
                         treeGone=gone if self.own_tree else None,
                         treeCompletionOwner='self' if self.own_tree else 'outer managed group/job',
                         readersJoined=joined, pipeEOF=eof, commandJoined=reaped and joined and all(eof.values()),
                         quiescent=quiescent if self.own_tree else None,
                         elapsedSeconds=time.monotonic()-started,
                         streams={key: {'bytes':len(data), 'sha256':hashlib.sha256(data).hexdigest()} for key,data in buffers.items()},
                         passed=failure is None and not errors and not entry['forced'] and all(eof.values()) and quiescent)
            if job and assigned:
                try:
                    entry['jobAccounting'] = job.accounting()
                except OSError as error:
                    entry['jobAccountingFailure'] = str(error)
                    entry['passed'] = False
                    entry['quiescent'] = False
                    quiescent = False
            if failure:
                entry['failure'] = type(failure).__name__ + ': ' + str(failure)
            if not quiescent:
                self.pending.append(name)
            if job and gone:
                try:
                    job.close_quiescent()
                except BaseException as error:
                    entry['jobCloseFailure'] = str(error)
                    entry['passed'] = False
                    self.pending.append(name)
            (self.evidence / (name + '.outcome.json')).write_text(json.dumps(entry, indent=2)+'\n')
        if not entry['passed']:
            raise RuntimeError('proof child failed; inspect ' + name) from failure
        return bytes(buffers['stdout'])

    def finish(self):
        self.pending = sorted(set(self.pending) | {row['name'] for row in self.records if row.get('commandJoined') is not True or (self.own_tree and row.get('quiescent') is not True)})
        result = {'children': self.records, 'pending': self.pending, 'allCommandsJoined': not self.pending,
                  'quiescent': not self.pending if self.own_tree else None, 'ownsTree': self.own_tree,
                  'allPassed': all(row.get('passed') is True for row in self.records)}
        (self.evidence / 'processes.json').write_text(json.dumps(result, indent=2)+'\n')
        return not self.pending
