"""Observe the owned fixture's completed export and broker snapshot receipt."""
import hashlib
import json
from pathlib import Path


def source_readiness(expected):
    result = {'ready': False, 'callsPath': expected['callsPath']}
    try:
        raw = Path(expected['callsPath']).read_text()
    except FileNotFoundError:
        result['pending'] = 'source calls'
        return result
    # A concurrently appended final line is not a completed record yet.
    rows = [json.loads(line) for line in raw.splitlines(keepends=True)
            if line.endswith('\n') and line.strip()]
    listed = any(row['command'] == 'list' and row['args'] == expected['listArgs']
                 and row['scenario'] == 'normal' for row in rows)
    read = any(row['command'] == 'read' and row['args'] == expected['readArgs']
               and row['scenario'] == 'normal' for row in rows)
    completed = [row for row in rows if row['command'] == 'export'
                 and row.get('phase') == 'completed' and row['scenario'] == 'normal'
                 and row['args'][:5] == [expected['snapshotId'], '--projection', 'snapshot', '--format', 'directory']
                 and len(row['args']) == 7 and row['args'][5] == '--output']
    if not listed or not read or not completed:
        result['pending'] = 'list/read/export completion'
        return result
    export = completed[-1]
    stage = Path(export['args'][6])
    cache = Path(expected['cacheDir']).resolve()
    if not stage.is_absolute() or not stage.name.startswith('.stage-') or not stage.resolve().is_relative_to(cache):
        raise RuntimeError('Fixture export escaped the owned source cache')
    record = stage.parent.parent
    if (stage.parent.name != 'snapshots'
            or record.name != hashlib.sha256(expected['id'].encode()).hexdigest()
            or record.parent.name != 'records'
            or record.parent.parent.name != expected['scope']
            or record.parent.parent.parent.name != 'scopes'):
        raise RuntimeError('Fixture export does not match the selected record and scope')
    snapshot = stage.parent / expected['snapshotId']
    try:
        receipt = json.loads((snapshot / '.broker-snapshot.json').read_text())
    except FileNotFoundError:
        result['pending'] = 'broker snapshot publication'
        return result
    if any(receipt.get(key) != value for key, value in {
        'version': 3, 'projection': 'snapshot', 'scope': expected['scope'],
        'snapshot': expected['snapshotId'], 'entry': 'SKILL.md',
    }.items()):
        raise RuntimeError('Broker snapshot identity does not match the owned fixture')
    selected = receipt.get('record', {})
    if (selected.get('id') != expected['id'] or selected.get('locator') != expected['locator']
            or selected.get('kind') != 'skill' or selected.get('entrypoint') != 'SKILL.md'
            or selected.get('ref') != expected['readArgs'][0]):
        raise RuntimeError('Broker snapshot record does not match the selected fixture')
    files = receipt['files']
    if len(files) != 3 or {item['path'] for item in files} != {'.ntn-skills.json', 'SKILL.md', 'references/ledger.md'}:
        raise RuntimeError('Broker snapshot fixture inventory is incomplete')
    for item in files:
        data = (snapshot / item['path']).read_bytes()
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['hash']:
            raise RuntimeError('Broker snapshot fixture bytes do not match its receipt')
    result.update(ready=True, snapshot=str(snapshot), receipt=receipt,
                  export=export, completedCalls=len(rows))
    return result
