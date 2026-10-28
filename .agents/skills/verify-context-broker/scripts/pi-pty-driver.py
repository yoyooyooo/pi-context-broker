#!/usr/bin/env python3
"""Drive one owned terminal; retain raw bytes rather than inventing screenshots."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path
from terminal_screen import TerminalScreen, matches
from pi_readiness import source_readiness

spec = json.loads(Path(sys.argv[1]).read_text())
evidence = Path(spec['evidence'])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
child = None
raw = bytearray()
screen = TerminalScreen()
actions = []
cleanup = {}
def interrupted(signum, frame):
    raise RuntimeError(f'Interrupted by signal {signum}')

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def save(name, value):
    (evidence / name).write_text(json.dumps(value, indent=2) + '\n')

def pump(timeout=0.1):
    if select.select([master], [], [], timeout)[0]:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        raw.extend(data)
        screen.feed(data)
        # Answer the terminal's cursor-position query, never application input.
        if b'\x1b[6n' in data:
            os.write(master, b'\x1b[1;1R')
        (evidence / 'terminal.ansi').write_bytes(raw)

def wait_for(label, predicate, timeout=45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump()
        if predicate():
            return
        if child.poll() is not None:
            raise RuntimeError(f'Pi exited during {label}: {child.returncode}')
    raise RuntimeError(f'Timeout: {label}')

def providers():
    path = Path(spec['provider'])
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]

try:
    child = subprocess.Popen(spec['command'], cwd=spec['cwd'], env=spec['env'],
                             stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    slave = None
    save('owned-process.json', {'pid': child.pid, 'command': spec['command'], 'cwd': spec['cwd']})
    for index, step in enumerate(spec['steps']):
        start = len(raw)
        action = {'index': index, 'label': step['label'], 'at': time.time(), 'rawStart': start}
        actions.append(action)
        save('actions.json', actions)
        if 'source' in step:
            def source_ready():
                action['source'] = source_readiness(step['source'])
                save('source-readiness.json', action['source'])
                return action['source']['ready']
        if 'send' in step:
            os.write(master, step['send'].encode())
            action['sent'] = step['send']
        if 'screen' in step:
            wait_for(step['label'], lambda: ('source' not in step or source_ready()) and len(raw) > start and matches(screen, step['screen']))
        if 'requests' in step:
            wait_for(step['label'], lambda: len(providers()) >= step['requests'])
            rows = providers()
            if len(rows) != step['requests']:
                raise RuntimeError('Unexpected provider request count')
            context = rows[-1]['context']
            messages = json.dumps(context.get('messages', []))
            if messages.count(spec['canary']) != 1:
                raise RuntimeError('Selected body must occur exactly once in current provider messages')
            if spec['canary'] in str(context.get('systemPrompt', '')):
                raise RuntimeError('System catalog must remain metadata-only')
            action['providerRequests'] = len(rows)
            action['bodyCount'] = 1
        if step.get('exit'):
            wait_for(step['label'], lambda: child.poll() is not None, timeout=15)
            if child.returncode != 0:
                raise RuntimeError(f'Natural Pi exit failed: {child.returncode}')
        action['rawEnd'] = len(raw)
        (evidence / f'{index:02d}-{step["label"]}.ansi').write_bytes(raw[start:])
        save(f'{index:02d}-{step["label"]}.screen.json', screen.snapshot())
        action['screen'] = screen.snapshot()
        action['observed'] = True
        save('actions.json', actions)
    save('result.json', {'status': 'passed', 'coverage': 'real Pi PTY with controlled provider; raw terminal stream, no screenshot renderer', 'actions': actions})
except BaseException as error:
    save('failure.screen.json', screen.snapshot())
    save('result.json', {'status': 'failed', 'error': str(error), 'actions': actions})
    sys.exitcode = 1
finally:
    if child:
        natural = child.poll() is not None
        signals = []
        try:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                signals.append('SIGTERM')
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    signals.append('SIGKILL')
            child.wait(timeout=5)
            cleanup = {'pid': child.pid, 'observedExit': child.returncode is not None,
                       'returncode': child.returncode, 'naturalExit': natural, 'signals': signals}
        except BaseException as error:
            cleanup = {'pid': child.pid, 'observedExit': False, 'error': str(error)}
            sys.exitcode = 1
    if slave is not None:
        os.close(slave)
    os.close(master)
    cleanup['ptyClosed'] = True
    save('cleanup.json', cleanup)
    for step in spec['steps']:
        if 'source' in step:
            calls = Path(step['source']['callsPath'])
            if calls.exists():
                (evidence / 'source-cli-calls.jsonl').write_bytes(calls.read_bytes())
    (evidence / 'terminal.ansi').write_bytes(raw)
sys.exit(getattr(sys, 'exitcode', 0))
