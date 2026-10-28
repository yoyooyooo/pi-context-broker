#!/usr/bin/env python3
"""Owned Pi/OMP terminal for live cache acceptance; commands are real PTY input."""
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

spec = json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0, spec['screenModuleDir'])
from terminal_screen import TerminalScreen

out = Path(spec['channel'])
host = spec.get('host', 'omp')
env = spec['env']
for name in ['NOTION_API_TOKEN', 'NTN_API_TOKEN']:
    if os.environ.get(name):
        env[name] = os.environ[name]
env.update(TERM='xterm-256color', COLORTERM='truecolor')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 160, 0, 0))
child = None
screen = TerminalScreen(45, 160)
raw = bytearray()
exits = []

def save(name, value):
    (out / name).write_text(json.dumps(value, indent=2) + '\n')

def append(name, value):
    with (out / name).open('a') as stream:
        stream.write(json.dumps(value) + '\n')

def ledger(event, **details):
    path = env.get('BROKER_E2E_PROCESS_LEDGER')
    if path:
        with open(path, 'a') as stream:
            stream.write(json.dumps(dict(event=event, host=host + '-terminal', pid=child.pid, **details)) + '\n')

def interrupted(signum, frame):
    raise RuntimeError(f'Interrupted by signal {signum}')
signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def pump():
    if select.select([master], [], [], 0.1)[0]:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                return
            raise
        raw.extend(data)
        screen.feed(data)
        if b'\x1b[6n' in data:
            os.write(master, b'\x1b[1;1R')
        (out / 'terminal.ansi').write_bytes(raw)

def wait_for(label, predicate, timeout=120):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump()
        if predicate():
            return
        if child.poll() is not None:
            raise RuntimeError(f'{host} terminal exited during {label}: {child.returncode}')
    save('failure.screen.json', screen.snapshot())
    raise RuntimeError(f'{host} terminal timeout: {label}')

def providers():
    path = Path(spec['provider'])
    return [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []

def boot():
    global child, screen
    screen = TerminalScreen(45, 160)
    child = subprocess.Popen(spec['command'], cwd=spec['cwd'], env=env,
                             stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    ledger('spawn', file=spec['command'][0], args=spec['command'][1:], cwd=spec['cwd'])
    def ready():
        state = screen.snapshot()
        if host == 'pi':
            return state['editor'] == '' and any('fake' in line for line in state['lines'])
        return any('Fixture' in line for line in state['lines']) and any('thinking effort' in line for line in state['lines'])
    wait_for('interactive composer', ready)
    save('ready.screen.json', screen.snapshot())

def quit_host():
    os.write(master, b'\x04')
    wait_for('natural interactive exit', lambda: child.poll() is not None, 15)
    assert child.returncode == 0, f'Natural terminal exit failed: {child.returncode}'
    exits.append(dict(pid=child.pid, code=child.returncode, observedExit=True, naturalExit=True))
    ledger('close', code=child.returncode, signal=None, observedExit=True)

try:
    boot()
    save('ready.json', dict(base=str(out), provider=spec['provider']))
    sequence = 0
    while True:
        path = out / 'commands.jsonl'
        request = None
        while request is None:
            pump()
            if child.poll() is not None:
                raise RuntimeError(f'Owned {host} exited before next action')
            requests = [json.loads(line) for line in path.read_text().splitlines() if line] if path.exists() else []
            if len(requests) > sequence:
                request = requests[sequence]
        sequence += 1
        try:
            action = request['action']
            if action in ['stop', 'restart']:
                quit_host()
                if action == 'restart':
                    boot()
            elif action == 'new':
                os.write(master, b'/new\r')
                # Drain command handling before another real keyboard action.
                end = time.monotonic() + 0.5
                while time.monotonic() < end:
                    pump()
            else:
                before = len(providers())
                if action == 'resource':
                    Path(spec['plan']).write_text(json.dumps(dict(trigger=request['text'], id=request['id'], path=request['path'])))
                text = ('$' + spec['alias'] + '@notion ' if action == 'activate' else '') + request['text']
                os.write(master, (text + '\r').encode())
                expected = before + (2 if action == 'resource' else 1)
                wait_for('provider completion', lambda: len(providers()) >= expected)
                assert len(providers()) == expected, 'Unexpected provider request count'
                wait_for('rendered assistant reply', lambda: any(line.strip() == 'OK' for line in screen.snapshot()['lines']))
            save(request.get('label', request['id']) + '.screen.json', screen.snapshot())
            append('responses.jsonl', dict(id=request['id'], status='passed', pid=child.pid))
            if action == 'stop':
                break
        except BaseException as error:
            append('responses.jsonl', dict(id=request['id'], status='failed', error=str(error)))
            raise
except BaseException as error:
    save('terminal-failure.json', dict(error=str(error), screen=screen.snapshot()))
    sys.exitcode = 1
finally:
    if child and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
        exits.append(dict(pid=child.pid, code=child.returncode, observedExit=True, naturalExit=False))
        ledger('close', code=child.returncode, signal='SIGTERM', observedExit=True)
    os.close(slave)
    os.close(master)
    save('cleanup.json', dict(stopped=bool(exits) and all(item['observedExit'] for item in exits), processes=exits, ptyClosed=True))
    (out / 'terminal.ansi').write_bytes(raw)
sys.exit(getattr(sys, 'exitcode', 0))
