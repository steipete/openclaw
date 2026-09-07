import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

TARGET, LANE, EVIDENCE = map(Path, sys.argv[1:])
CASES = json.loads((LANE / 'cases.json').read_text())
NODE = shutil.which('node')
assert NODE
owned = Path(tempfile.mkdtemp(prefix='openclaw-progress-proof-'))
records = []
inspections = []
cancel_signals = {signal.SIGTERM, signal.SIGHUP, signal.SIGINT}
cancelled_signal = None
cleaning = False

def cancel(signum, _frame):
    global cancelled_signal
    if cancelled_signal is None:
        cancelled_signal = signum
    if not cleaning:
        raise InterruptedError(f'parent cancelled by signal {signum}')

for signum in cancel_signals:
    signal.signal(signum, cancel)

def frame_count(raw, kind):
    text = raw.decode('utf-8', errors='ignore')
    text = re.sub(r'\x1b\][\s\S]*?(?:\x07|\x1b\\)', '', text)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    pattern = r'\((?:\\/|\|\||--)\)' if kind == 'wizard' else r'[◒◐◓◑•oO0]  '
    return len(re.findall(pattern, text))

def gone(pid):
    try:
        os.killpg(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except OSError:
        return False

def child_session():
    signal.pthread_sigmask(signal.SIG_UNBLOCK, cancel_signals)
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)

def observer_session():
    signal.pthread_sigmask(signal.SIG_UNBLOCK, cancel_signals)
    os.setsid()


def inspect_group(target_process, deadline, cleanup_deadline, cell_dir, phase):
    global cleaning
    record = {'phase': phase, 'targetPid': target_process.pid, 'targetExitCode': target_process.poll(),
              'spawned': False, 'reaped': False, 'pipeEOF': False, 'kernelGroupAbsent': False,
              'forcedSignals': [], 'canonicalState': 'indeterminate'}
    inspections.append(record)
    observer = None
    stdout = stderr = b''
    try:
        assert record['targetExitCode'] is not None
        assert deadline > time.monotonic(), 'original cell deadline exhausted before inspection'
        env = {'PATH': os.environ['PATH'], 'HOME': str(owned), 'TMPDIR': str(owned)}
        command = [NODE, '--experimental-strip-types', str(LANE / 'inspect-group.mjs'),
                   str(TARGET), str(target_process.pid), str(record['targetExitCode'])]
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)
        try:
            observer = subprocess.Popen(command, cwd=TARGET, env=env, stdin=subprocess.DEVNULL,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        preexec_fn=observer_session)
            record.update(spawned=True, observerPid=observer.pid)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        stdout, stderr = observer.communicate(timeout=max(0, deadline - time.monotonic()))
        record.update(exitCode=observer.returncode, reaped=True, pipeEOF=True,
                      kernelGroupAbsent=gone(observer.pid))
        assert len(stdout) <= 262144 and len(stderr) <= 65536, 'observer output bound exceeded'
        assert observer.returncode == 0 and not stderr and record['kernelGroupAbsent']
        observation = json.loads(stdout)
        assert observation['pid'] == target_process.pid
        assert observation['exitCode'] == record['targetExitCode']
        assert observation['observerPid'] == observer.pid and observation['observationValid']
        assert observation['builtinBindingsRestored'] and observation['policy'] == 'indeterminate'
        assert observation['canonicalState'] in ['dead', 'live', 'indeterminate']
        record['observation'] = observation
        record['canonicalState'] = observation['canonicalState']
    except BaseException as error:
        record['error'] = f'{type(error).__name__}: {error}'
    finally:
        was_cleaning = cleaning
        cleaning = True
        if observer is not None and (observer.poll() is None or not gone(observer.pid)):
            for sig in [signal.SIGTERM, signal.SIGKILL]:
                if gone(observer.pid):
                    break
                try:
                    os.killpg(observer.pid, sig)
                    record['forcedSignals'].append(sig.name)
                except ProcessLookupError:
                    pass
                try:
                    stdout, stderr = observer.communicate(timeout=max(0, min(1, cleanup_deadline - time.monotonic())))
                    record['pipeEOF'] = True
                except subprocess.TimeoutExpired as error:
                    stdout, stderr = error.output or stdout, error.stderr or stderr
            record['reaped'] = observer.poll() is not None
            record['kernelGroupAbsent'] = gone(observer.pid)
        if observer is not None:
            for pipe in [observer.stdout, observer.stderr]:
                if pipe and not pipe.closed:
                    pipe.close()
        record['bytes'] = {'stdout': len(stdout), 'stderr': len(stderr)}
        (cell_dir / f'inspection-{phase}.stdout').write_bytes(stdout[:262144])
        (cell_dir / f'inspection-{phase}.stderr').write_bytes(stderr[:65536])
        (cell_dir / f'inspection-{phase}.json').write_text(json.dumps(record, indent=2) + '\n')
        cleaning = was_cleaning
    return record['canonicalState']


try:
    for cell in CASES:
        cleaning = False
        item = {'id': cell['id'], 'spawned': False, 'joined': False,
                'groupState': 'indeterminate', 'eof': False, 'forced': False, 'resizeApplied': False, 'readySignals': []}
        records.append(item)
        master = slave = ready_read = ready_write = None
        process = None
        deadline = time.monotonic() + 18
        cleanup_deadline = deadline + 2
        raw = bytearray()
        cell_dir = EVIDENCE / cell['id']
        cell_dir.mkdir(parents=True)
        try:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 100, cell['columns'], 0, 0))
            ready_read, ready_write = os.pipe()
            env = {'PROOF_READY_FD': str(ready_read), 'PATH': os.environ['PATH'], 'HOME': str(owned), 'TMPDIR': str(owned),
                   'TERM': 'xterm-256color', 'TERM_PROGRAM': 'ghostty',
                   'FORCE_COLOR': '3', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}
            command = [NODE, '--import', str(TARGET / 'scripts/tsx.mjs'), str(LANE / 'child.mts'),
                       str(TARGET), json.dumps(cell), str(cell_dir / 'child.json')]
            old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, cancel_signals)
            try:
                process = subprocess.Popen(command, cwd=TARGET, env=env, stdin=slave,
                                           stdout=slave, stderr=slave, preexec_fn=child_session,
                                           pass_fds=(ready_read,))
                item.update(spawned=True, pid=process.pid)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
            os.close(ready_read)
            ready_read = None
            os.close(slave)
            slave = None
            while not item['eof'] or process.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('PTY child did not naturally close within 18 seconds')
                readable, _, _ = select.select([master] if not item['eof'] else [], [], [], 0.05)
                if readable:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b''
                    if not chunk:
                        item['eof'] = True
                    else:
                        raw.extend(chunk)
                        if len(raw) > 524288:
                            raise RuntimeError('PTY output exceeded 512 KiB')
                        if (cell['kind'] == 'delayed' and not item['resizeApplied']
                                and b'\x1b]777;progress-proof;resize-request\x07' in raw):
                            fcntl.ioctl(master, termios.TIOCSWINSZ,
                                        struct.pack('HHHH', 100, cell['finalColumns'], 0, 0))
                            item['resizeApplied'] = True
                            item['resizeByteOffset'] = len(raw)
                        frames = frame_count(raw, cell['kind'])
                        suppressed = b'\x1b]777;progress-proof;suppressed\x07' in raw
                        if not item['readySignals'] and (frames >= 1 or suppressed):
                            os.write(ready_write, b'S')
                            item['readySignals'].append({'byte': 'S', 'frames': frames, 'offset': len(raw)})
                        if (len(item['readySignals']) == 1
                                and b'\x1b]777;progress-proof;updated\x07' in raw
                                and (frames >= 26 or suppressed)):
                            os.write(ready_write, b'A')
                            item['readySignals'].append({'byte': 'A', 'frames': frames, 'offset': len(raw)})
                            os.close(ready_write)
                            ready_write = None
            item['exitCode'] = process.wait(timeout=1)
            item['joined'] = True
            item['groupState'] = inspect_group(process, deadline, cleanup_deadline, cell_dir, 'normal')
            assert item['exitCode'] == 0, f"child exit {item['exitCode']}"
            assert item['groupState'] == 'dead', 'canonical process-group completion is unproven'
            assert item['resizeApplied'] == (cell['kind'] == 'delayed')
            assert (cell_dir / 'child.json').is_file()
        except BaseException as error:
            item['error'] = f'{type(error).__name__}: {error}'
        finally:
            cleaning = True
            if process is not None and (process.poll() is None or item['groupState'] != 'dead'):
                item['forced'] = True
                for sig in [signal.SIGTERM, signal.SIGKILL]:
                    if gone(process.pid):
                        break
                    try:
                        os.killpg(process.pid, sig)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=max(0, min(1, cleanup_deadline - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        pass
                item['joined'] = process.poll() is not None
                if process.poll() is not None and inspections and not inspections[-1].get('error'):
                    item['groupState'] = inspect_group(process, min(deadline, cleanup_deadline), cleanup_deadline, cell_dir, 'cleanup')
            for descriptor in [ready_read, ready_write]:
                if descriptor is not None:
                    os.close(descriptor)
            if slave is not None:
                os.close(slave)
            if master is not None:
                # Preserve any trailing output from a failed child before closing the master.
                if process is not None and item['groupState'] == 'dead' and not item['eof']:
                    while select.select([master], [], [], 0)[0]:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                            chunk = b''
                        if not chunk:
                            item['eof'] = True
                            break
                        raw.extend(chunk)
                os.close(master)
            (cell_dir / 'raw.ansi').write_bytes(raw)
            item['rawBytes'] = len(raw)
            item['rawSha256'] = hashlib.sha256(raw).hexdigest()
            (cell_dir / 'process.json').write_text(json.dumps(item, indent=2) + '\n')
        if item.get('error') or cancelled_signal is not None:
            break
finally:
    cleaning = True
    quiescent = all(not row['spawned'] or row['joined'] and row['groupState'] == 'dead' and row['eof'] for row in records) and all(not row['spawned'] or row['reaped'] and row['pipeEOF'] and row['kernelGroupAbsent'] for row in inspections)
    if quiescent:
        shutil.rmtree(owned)
    receipt = {'records': records, 'inspections': inspections, 'quiescent': quiescent, 'cancelledSignal': cancelled_signal,
               'ownedFixtureRemoved': quiescent, 'retainedState': None if quiescent else str(owned)}
    (EVIDENCE / 'processes.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert cancelled_signal is None, f'parent cancelled by signal {cancelled_signal}'
assert len(records) == len(CASES)
assert all(row['joined'] and row['groupState'] == 'dead' and row['eof'] and not row['forced'] and not row.get('error') for row in records)
