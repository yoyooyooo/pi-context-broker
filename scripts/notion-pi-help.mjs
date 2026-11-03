// A shared, observer-only boundary for the installed host's own documentation.
// No package inventory, Skill discovery, source query or provider instruction.
export function createPiHelpBoundary({ fs, path, crypto, executable }) {
  const sha = value => crypto.createHash('sha256').update(value).digest('hex');
  const inside = (root, file) => { const tail = path.relative(root, file); return tail && tail !== '..' && !tail.startsWith('../') && !path.isAbsolute(tail); };
  const actualExecutable = fs.realpathSync(executable);
  let root;
  for (let directory = path.dirname(actualExecutable), count = 0; count < 8; count++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
      if (typeof pkg.name === 'string' && /^@[^/]+\/pi-coding-agent$/.test(pkg.name) && typeof bin === 'string'
        && fs.realpathSync(path.resolve(directory, bin)) === actualExecutable) { root = directory; break; }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  if (!root) throw new Error('The actual Pi executable has no matching installed package root');
  const known = new Map(), consumed = new Map();
  const canonicalFile = input => {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.split(/[\\/]/).includes('..')) return undefined;
    try {
      const absolute = path.resolve(input), actual = fs.realpathSync(absolute);
      if (!inside(root, actual) || !actual.endsWith('.md')) return undefined;
      // An OS spelling outside the package may alias its root; every segment
      // below that boundary must keep the same path and may not be a symlink.
      let boundary;
      for (let directory = path.dirname(absolute);;) {
        if (fs.realpathSync(directory) === root) { boundary = directory; break; }
        const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
      }
      if (!boundary || path.resolve(root, path.relative(boundary, absolute)) !== actual) return undefined;
      let current = boundary;
      for (const segment of path.relative(boundary, absolute).split(path.sep)) {
        current = path.join(current, segment); if (fs.lstatSync(current).isSymbolicLink()) return undefined;
      }
      if (!fs.statSync(actual).isFile()) return undefined;
      return actual;
    } catch (error) { if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) return undefined; throw error; }
  };
  const register = (input, source) => {
    const actual = canonicalFile(input); if (!actual) return undefined;
    const bytes = fs.readFileSync(actual), content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) return undefined;
    const fact = { role: 'host-help', path: actual, sha256: sha(bytes), bytes: bytes.length, content, source };
    const prior = known.get(actual); if (prior && prior.sha256 !== fact.sha256) throw new Error('An advertised Pi help file changed during observation');
    known.set(actual, fact); return fact;
  };
  const text = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [item] : typeof item?.text === 'string' ? [item.text] : []) : [];
  const observeProvider = payload => {
    const strings = [...(payload?.messages ?? []).filter(message => message.role === 'system').flatMap(message => text(message.content)),
      ...text(payload?.system), ...text(payload?.systemInstruction?.parts)];
    const added = [];
    for (const value of strings) for (const match of value.matchAll(/<docs>([\s\S]*?)<\/docs>/g)) {
      const docs = match[1];
      if (!/^\s*Pi documentation\b/.test(docs)) continue;
      const main = /^- Main documentation:\s*([^\r\n]+)$/m.exec(docs)?.[1]?.trim();
      const directory = /^- Additional docs:\s*([^\r\n]+)$/m.exec(docs)?.[1]?.trim();
      if (canonicalFile(main) !== path.join(root, 'README.md')) continue;
      let actualDocs; try { actualDocs = directory && fs.realpathSync(directory); } catch { continue; }
      if (actualDocs !== path.join(root, 'docs')) continue;
      const paths = [main, ...[...docs.matchAll(/\bdocs\/([A-Za-z0-9_.-]+\.md)\b/g)].map(item => path.join(directory, item[1]))];
      for (const file of paths) {
        const before = known.size, fact = register(file, 'actual provider system docs');
        if (fact && known.size > before) added.push(fact);
      }
    }
    return added;
  };
  const target = input => {
    const actual = canonicalFile(input), fact = known.get(actual);
    if (!fact) return undefined;
    if (sha(fs.readFileSync(actual)) !== fact.sha256) throw new Error('An advertised Pi help file changed before native read');
    return { ...fact };
  };
  const verifyRead = (input, content, isError = false) => {
    const fact = target(input); if (!fact) return undefined;
    const complete = !isError && typeof content === 'string' && Buffer.byteLength(content) === fact.bytes && sha(content) === fact.sha256;
    if (complete) {
      consumed.set(fact.path, fact);
      for (const match of content.matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
        let link; try { link = decodeURIComponent(match[1].split('#')[0]); } catch { continue; }
        if (!link || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)/.test(link) || !link.endsWith('.md')) continue;
        const absolute = path.resolve(path.dirname(fact.path), link);
        if (inside(root, absolute)) register(absolute, 'complete successful Pi help read: ' + fact.path);
      }
    }
    return { role: 'host-help', path: fact.path, sha256: fact.sha256, bytes: fact.bytes, source: fact.source,
      returnedSha256: typeof content === 'string' ? sha(content) : null, returnedBytes: typeof content === 'string' ? Buffer.byteLength(content) : null, complete };
  };
  return { observeProvider, target, verifyRead, consumed: () => [...consumed.values()].map(fact => ({ ...fact })) };
}
