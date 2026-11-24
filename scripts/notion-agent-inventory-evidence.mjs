import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function reviewedDirectoryInventoryStartup() { return "# ~/.bash_env is sourced by non-interactive Bash when BASH_ENV is set.\n# Keep this file side-effect free; only define lightweight compatibility shims.\n\n# macOS /bin/bash is 3.2 and misses mapfile/readarray.\n# Provide a minimal polyfill for the common usage in agent scripts.\nif ! builtin help mapfile >/dev/null 2>&1; then\n  mapfile() {\n    local trim_newline=0\n    local fd=0\n    local OPTIND=1\n    local opt\n\n    while getopts \":tu:\" opt; do\n      case \"$opt\" in\n        t) trim_newline=1 ;;\n        u) fd=\"$OPTARG\" ;;\n        *)\n          printf 'mapfile: unsupported option -- %s\\n' \"$OPTARG\" >&2\n          return 2\n          ;;\n      esac\n    done\n    shift \"$((OPTIND - 1))\"\n\n    if [[ \"$#\" -gt 1 ]]; then\n      printf 'mapfile: too many arguments\\n' >&2\n      return 2\n    fi\n\n    local target=\"${1:-MAPFILE}\"\n    case \"$target\" in\n      ''|*[!a-zA-Z0-9_]*)\n        printf 'mapfile: invalid array name: %s\\n' \"$target\" >&2\n        return 2\n        ;;\n    esac\n\n    eval \"$target=()\"\n\n    local line\n    local quoted\n    local i=0\n    while IFS= read -r -u \"$fd\" line || [[ -n \"$line\" ]]; do\n      if [[ \"$trim_newline\" -eq 0 ]]; then\n        line+=$'\\n'\n      fi\n      printf -v quoted '%q' \"$line\"\n      eval \"$target[$i]=$quoted\"\n      i=$((i + 1))\n    done\n\n    return 0\n  }\n\n  readarray() {\n    mapfile \"$@\"\n  }\nfi\n"; }

export function reviewedDirectoryInventoryProgram(name, file) {
  if (!file || typeof file.path !== 'string' || !file.path.startsWith('/')
    || typeof file.realpath !== 'string' || !file.realpath.startsWith('/')
    || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')
    || !Number.isSafeInteger(file.uid) || file.uid < 0 || !Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777
    || (file.mode & 0o022) !== 0 || (file.mode & 0o111) === 0) return false;
  if (name === 'rg') {
    // Maintained Pi ripgrep and Homebrew ripgrep 15.1.0, reviewed for --files.
    const known = new Map([
      ['a326a1fb48074202e9ad41e4cd1e389eeea372c8c6f7d7e80da81176d5d9430e', 4014576],
      ['a95906967134d19589fb57c4d4780b7dcf3ed0f5d846ea45e77e37c9e7af311c', 6190144],
    ]);
    return known.get(file.sha256) === file.bytes;
  }
  return ['bash', 'ls', 'head'].includes(name) && ['/bin/' + name, '/usr/bin/' + name].includes(file.realpath) && file.uid === 0;
}


/** This grammar has no substitutions, assignments, redirections, background jobs,
 * arbitrary paths, search/preprocessor flags, or general shell expressions. */
export function directoryInventoryPlan(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 1024
    || /[\0\r$`\\<>]/u.test(command)) return undefined;
  const clauses = command.trim().split(/;|\n/u).map(value => value.trim());
  if (!clauses.length || clauses.length > 8 || clauses.some(value => !value)) return undefined;
  const programs = new Set(), actions = [];
  for (const clause of clauses) {
    if (/^pwd(?: -[LP])?$/u.test(clause)) { actions.push('cwd'); continue; }
    if (/^ls(?: -(?:l|a|A|la|al|lA|Al))?(?: \.)?$/u.test(clause)) {
      programs.add('ls'); actions.push('directory'); continue;
    }
    const parts = clause.split(/\s*\|\s*/u);
    if (parts.length > 2 || !/^rg --files(?: --hidden)?(?: -g (?:"!\.git(?:\/\*\*)?"|'!\.git(?:\/\*\*)?'|!\.git))?$/u.test(parts[0])) return undefined;
    programs.add('rg'); actions.push('file-list');
    if (parts.length === 2) {
      const head = /^head -(\d{1,3})$/u.exec(parts[1]) ?? /^head -n (\d{1,3})$/u.exec(parts[1]);
      if (!head || Number(head[1]) < 1 || Number(head[1]) > 300) return undefined;
      programs.add('head');
    }
  }
  return { version: 1, kind: 'bounded-directory-inventory', actions, programs: [...programs] };
}

/** Called only from the existing passive child-process diagnostic. Environment
 * values stay in memory. No command, process method, stream, or env is changed. */
export function captureDirectoryInventorySpawn(options, { fs, crypto, path, plan = directoryInventoryPlan }) {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const args = options?.args;
  if (options?.file !== '/bin/bash' || !Array.isArray(args) || args.length !== 3
    || args[0] !== '/bin/bash' || args[1] !== '-c' || typeof args[2] !== 'string') return undefined;
  const inventory = plan(args[2]);
  if (!inventory || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd)
    || !Array.isArray(options.envPairs) || options.envPairs.some(value => typeof value !== 'string')) return undefined;
  const env = new Map();
  for (const pair of options.envPairs) {
    const equals = pair.indexOf('=');
    if (equals < 1 || env.has(pair.slice(0, equals))) return undefined;
    env.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  // These keys can alter the meaning of an otherwise read-only command. Record
  // only the successful absence check; never retain their values or hashes.
  if ([...env.keys()].some(key => /^(?:ENV|BASHOPTS|SHELLOPTS|RIPGREP_CONFIG_PATH|LD_.+|DYLD_.+|BASH_FUNC_.+)$/u.test(key))) return undefined;
  const reviewedStartup = reviewedDirectoryInventoryStartup();
  const savedFiles = [];
  const fileIdentity = file => {
    const realpath = fs.realpathSync(file), stat = fs.statSync(realpath);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw new Error('UNREVIEWED_PROGRAM');
    const bytes = fs.readFileSync(realpath);
    const value = { path: file, realpath, bytes: bytes.length, sha256: sha(bytes), uid: stat.uid, mode: stat.mode & 0o777 };
    savedFiles.push(value); return value;
  };
  try {
    const cwd = fs.realpathSync(options.cwd);
    if (cwd !== options.cwd || !fs.statSync(cwd).isDirectory()) return undefined;
    const shell = fileIdentity('/bin/bash');
    if (!reviewedDirectoryInventoryProgram('bash', shell)) return undefined;
    let startup = { kind: 'absent' };
    if (env.has('BASH_ENV')) {
      const file = env.get('BASH_ENV');
      if (!path.isAbsolute(file) || /[\0\s$`\\<>;&|]/u.test(file)) return undefined;
      const realpath = fs.realpathSync(file), stat = fs.statSync(realpath);
      if (!stat.isFile() || stat.size !== Buffer.byteLength(reviewedStartup)
        || !fs.readFileSync(realpath).equals(Buffer.from(reviewedStartup))) return undefined;
      startup = { kind: 'reviewed-mapfile-compatibility-definitions', path: file, realpath,
        bytes: Buffer.byteLength(reviewedStartup), sha256: sha(reviewedStartup) };
    }
    const searchPath = env.get('PATH')?.split(path.delimiter);
    if (!Array.isArray(searchPath) || !searchPath.length || searchPath.some(entry => !path.isAbsolute(entry))) return undefined;
    const resolveProgram = name => {
      for (const entry of searchPath) {
        const file = path.join(entry, name);
        try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
      }
      return undefined;
    };
    const programs = [];
    for (const name of inventory.programs) {
      const selected = resolveProgram(name);
      if (!selected) return undefined;
      const program = fileIdentity(selected);
      if (!reviewedDirectoryInventoryProgram(name, program)) return undefined;
      programs.push({ name, ...program });
    }
    const proof = { version: 1, kind: 'bounded-directory-inventory', cwd,
      commandSha256: sha(args[2]), argvSha256: sha(JSON.stringify(args)), shell, programs, startup,
      actions: inventory.actions, environment: { unreviewedStartupVariables: false, exportedFunctions: false,
        loaderOverrides: false, ripgrepConfiguration: false }, scope: 'directory-enumeration-only; not all host traffic' };
    return { proof, unchanged() {
      try {
        if (fs.realpathSync(cwd) !== cwd || !fs.statSync(cwd).isDirectory()) return false;
        for (const program of programs) {
          const selected = resolveProgram(program.name);
          if (selected !== program.path || fs.realpathSync(selected) !== program.realpath) return false;
        }
        for (const file of savedFiles) {
          const actual = fs.statSync(file.realpath), bytes = fs.readFileSync(file.realpath);
          if (fs.realpathSync(file.path) !== file.realpath || actual.uid !== file.uid || (actual.mode & 0o777) !== file.mode
            || bytes.length !== file.bytes || sha(bytes) !== file.sha256) return false;
        }
        return startup.kind === 'absent' || fs.realpathSync(startup.path) === startup.realpath
          && fs.readFileSync(startup.realpath).equals(Buffer.from(reviewedStartup));
      } catch { return false; }
    } };
  } catch { return undefined; }
}

/** The call's schema/runtime and the full source ledger are independently verified
 * by their existing owners. Bind this exact executed input to one real child. */
export function verifyNotionAgentDirectoryInventory(call, { source, session, runtimeEvidence } = {}) {
  const blocked = reason => ({ status: 'blocked', code: 'DIRECTORY_INVENTORY_UNPROVEN', reason });
  const input = call?.arguments, event = call?.event, result = call?.result, owner = event?.toolSource;
  const runtime = runtimeEvidence?.get(call?.id), plan = directoryInventoryPlan(input?.command);
  if (call?.name !== 'bash' || owner?.source !== 'builtin' || owner.path !== 'builtin:bash'
    || !input || typeof input !== 'object' || Array.isArray(input) || !plan
    || Object.keys(input).some(key => !['command', 'timeout'].includes(key))
    || input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)
    || event.inputSha256 !== hash(JSON.stringify(input)) || !result || result.isError !== false
    || result.inputSha256 !== event.inputSha256 || event.pid !== result.pid
    || !runtime?.implementation?.profile || runtime.toolCallId !== call.id || runtime.toolName !== call.name
    || runtime.pid !== event.pid || runtime.inputSha256 !== event.inputSha256) return blocked('tool-input-or-runtime');
  const events = Array.isArray(source) ? source : source?.events;
  if (!Array.isArray(events)) return blocked('source-ledger-missing');
  const ns = value => typeof value === 'string' && /^\d+$/u.test(value) ? BigInt(value) : null;
  const startTime = ns(event.monotonicNs), endTime = ns(result.monotonicNs);
  if (startTime === null || endTime === null || startTime >= endTime) return blocked('tool-lifetime');
  const expectedArgv = hash(JSON.stringify(['/bin/bash', '-c', input.command]));
  const starts = events.filter(row => row.phase === 'unmatched_child_start' && row.parentPid === event.pid
    && row.argvSha256 === expectedArgv && ns(row.monotonicNs) !== null
    && ns(row.monotonicNs) >= startTime && ns(row.monotonicNs) < endTime);
  if (starts.length !== 1) return blocked('actual-child-not-unique');
  const start = starts[0], proof = start.directoryInventory;
  const startup = proof?.startup, reviewedStartup = reviewedDirectoryInventoryStartup();
  const startupValid = startup?.kind === 'absent' && Object.keys(startup).length === 1
    || startup?.kind === 'reviewed-mapfile-compatibility-definitions'
      && typeof startup.path === 'string' && startup.path.startsWith('/')
      && typeof startup.realpath === 'string' && startup.realpath.startsWith('/')
      && startup.bytes === Buffer.byteLength(reviewedStartup) && startup.sha256 === hash(reviewedStartup);
  if (proof?.version !== 1 || proof.kind !== 'bounded-directory-inventory'
    || proof.commandSha256 !== hash(input.command) || proof.argvSha256 !== expectedArgv
    || start.argumentCount !== 3 || start.executableSha256 !== hash('/bin/bash')
    || proof.cwd !== session?.header?.cwd || proof.shell?.path !== '/bin/bash'
    || !reviewedDirectoryInventoryProgram('bash', proof.shell) || !startupValid
    || JSON.stringify(proof.actions) !== JSON.stringify(plan.actions)
    || !Array.isArray(proof.programs) || proof.programs.length !== plan.programs.length
    || proof.programs.some((program, index) => program?.name !== plan.programs[index] || !reviewedDirectoryInventoryProgram(program.name, program))
    || proof.environment?.unreviewedStartupVariables !== false || proof.environment?.exportedFunctions !== false
    || proof.environment?.loaderOverrides !== false || proof.environment?.ripgrepConfiguration !== false) return blocked('spawn-context-not-proved');
  const phases = name => events.filter(row => row.phase === name && row.childId === start.childId && row.parentPid === event.pid);
  const spawned = phases('unmatched_child_spawn'), exited = phases('unmatched_child_exit'), closed = phases('unmatched_child_close');
  if (spawned.length !== 1 || exited.length !== 1 || closed.length !== 1 || phases('unmatched_child_error').length
    || !Number.isSafeInteger(spawned[0].childPid) || spawned[0].childPid <= 0
    || exited[0].childPid !== spawned[0].childPid || closed[0].childPid !== spawned[0].childPid
    || exited[0].code !== 0 || exited[0].signal !== null || closed[0].code !== 0 || closed[0].signal !== null
    || closed[0].directoryInventoryUnchanged !== true
    || [spawned[0], exited[0], closed[0]].some(row => ns(row.monotonicNs) === null)
    || ns(spawned[0].monotonicNs) < ns(start.monotonicNs) || ns(exited[0].monotonicNs) < ns(spawned[0].monotonicNs)
    || ns(closed[0].monotonicNs) < ns(exited[0].monotonicNs) || ns(closed[0].monotonicNs) > endTime)
    return blocked('child-terminal-or-program-drift');
  return { status: 'passed', toolCallId: call.id, owner: 'observed-builtin-directory-inventory',
    childId: start.childId, childPid: spawned[0].childPid, inputSha256: event.inputSha256,
    runtimeProfile: runtime.implementation.profile, proof };
}
