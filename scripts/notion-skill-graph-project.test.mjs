import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedGraphProject, inspectOwnedGraphProject, extractGeneratedFiles, retainGeneratedPlan } from './notion-skill-graph-project.mjs';
import { dailyRouteContract } from './verify-skill-graph-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const project = { sha256: hash('controlled file extraction fixture'), files: [] };
const prompt = { sha256: hash('unchanged natural task') };
const evidence = async () => mkdtemp(join(await realpath(tmpdir()), 'graph-file-extraction-'));

const dailyProfile = () => dailyRouteContract({ modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 });
test('daily owned inventory admits the frozen sixth file only under its explicit contract', async () => {
  const directory = await evidence(), modelProfile = dailyProfile();
  const before = await createOwnedGraphProject(directory);
  await mkdir(join(directory, '.pi'));
  await writeFile(join(directory, '.pi/settings.json'), JSON.stringify(modelProfile.ownedProjectRetry, null, 2) + '\n');
  const after = await inspectOwnedGraphProject(directory, { modelProfile });
  assert.equal(after.sha256, before.sha256);
  assert.equal(after.runtimeSettings.modelContract, 'daily-route-v1');
  await assert.rejects(inspectOwnedGraphProject(directory), /inventory/);
});

test('daily owned retry settings are an exact sixth file without changing task source identity', async () => {
  const plain = await createOwnedGraphProject(await evidence()), modelProfile = dailyProfile();
  const directory = await evidence(), actual = await createOwnedGraphProject(directory, { modelProfile });
  const settings = JSON.stringify(modelProfile.ownedProjectRetry, null, 2) + '\n';
  assert.equal(await readFile(join(directory, '.pi/settings.json'), 'utf8'), settings);
  assert.equal(actual.sha256, plain.sha256);
  assert.deepEqual(actual.files, plain.files);
  assert.deepEqual(actual.runtimeSettings, { path: '.pi/settings.json', bytes: Buffer.byteLength(settings), sha256: hash(settings), modelContract: 'daily-route-v1' });
  assert.deepEqual(await inspectOwnedGraphProject(directory, { modelProfile }), actual);
  await assert.rejects(inspectOwnedGraphProject(directory), /inventory/);
  await assert.rejects(createOwnedGraphProject(directory, { modelProfile }), /EEXIST/);
});

test('daily owned settings cannot change policy, bytes, inventory or filesystem identity', async () => {
  const modelProfile = dailyProfile();
  const changed = await evidence(); await createOwnedGraphProject(changed, { modelProfile });
  await writeFile(join(changed, '.pi/settings.json'), JSON.stringify(modelProfile.ownedProjectRetry));
  await assert.rejects(inspectOwnedGraphProject(changed, { modelProfile }), /settings changed/);
  const extra = await evidence(); await createOwnedGraphProject(extra, { modelProfile });
  await writeFile(join(extra, '.pi/extra.json'), '{}');
  await assert.rejects(inspectOwnedGraphProject(extra, { modelProfile }), /inventory/);
  const linked = await evidence(); await createOwnedGraphProject(linked);
  await mkdir(join(linked, '.pi')); await symlink(join(changed, '.pi/settings.json'), join(linked, '.pi/settings.json'));
  await assert.rejects(inspectOwnedGraphProject(linked, { modelProfile }), /symlink/);
  await assert.rejects(inspectOwnedGraphProject(changed, { modelProfile: { ...modelProfile, thinkingLevel: 'off' } }), /policy/);
});

test('explicit multilevel numbered file headings retain complete long-fenced bytes', () => {
  const content = '# Acceptance\r\n\r\n```bash\r\nnpm test\r\n```\r\n';
  for (const heading of ['### 3.1 `docs/acceptance.md`', '### 12.4.2. **`docs/acceptance.md`**']) {
    const text = heading + '\r\n\r\n````markdown\r\n' + content + '````\r\n';
    const files = extractGeneratedFiles(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'docs/acceptance.md');
    assert.equal(files[0].content, content);
    assert.equal(files[0].bytes, Buffer.byteLength(content));
    assert.equal(files[0].sha256, hash(content));
    assert.equal(text.slice(files[0].sourceSpan.start, files[0].sourceSpan.end), content);
  }
});

test('save-file labels retain exact files with parenthesized location notes without completing a Skill', async () => {
  const content = '# Acceptance\r\n\r\nRun `node scripts/acceptance.cjs`.\r\n';
  const heading = 'Save the file: `docs/acceptance-procedure.md` (directory relative to the repo root `workspace/`).';
  const text = heading + '\r\n\r\n```markdown\r\n' + content + '```\r\n';
  const [file] = extractGeneratedFiles(text);
  assert.ok(file, 'The explicitly named complete Markdown file must be retained');
  assert.equal(file.path, 'docs/acceptance-procedure.md');
  assert.equal(file.content, content);
  assert.equal(file.bytes, Buffer.byteLength(content));
  assert.equal(file.sha256, hash(content));
  assert.equal(text.slice(file.sourceSpan.start, file.sourceSpan.end), content);
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.artifactStatus, 'incomplete-generated-files');
  assert.deepEqual(receipt.skillFiles, []);
  assert.equal(receipt.executed, false);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
  assert.equal(await readFile(join(directory, 'generated-files', file.path), 'utf8'), content);
  assert.throws(() => extractGeneratedFiles(text + text.replace(content, 'Conflicting bytes.\r\n')), /conflicting complete definitions/);
});

test('save-file labels reject prose, multiple paths and paths outside the owned project', () => {
  const block = heading => heading + '\n\n```markdown\nExact file bytes.\n```\n';
  for (const heading of [
    'Read `docs/acceptance.md` (directory relative to the repo root).',
    'Save the file: `docs/one.md` or `docs/two.md`',
    'Save the file: `docs/one.md` (or `docs/two.md`)',
    'Save the file: `docs/one.md` (or docs/two.md).',
    'Save the file: `docs/one.md` (or `/outside/docs/two.md`)',
    'Save the file: `docs/one.md` (or `../escape/two.md`)',
    'Save the file: `docs/acceptance.md` then execute it.',
    'Save the file: `../escape/acceptance.md` (relative file).',
    'Save the file: `docs/../acceptance.md` (relative file).',
    'Save the file: `docs//acceptance.md` (relative file).',
    'Save the file: `/outside/docs/acceptance.md` (absolute file).',
    'Save the file: `/owned/project-other/docs/acceptance.md` (absolute file).',
  ]) assert.deepEqual(extractGeneratedFiles(block(heading), { projectRoot: '/owned/project' }), [], heading);
});

test('same-length nested fences retain the raw plan and report ambiguity without truncated files', async () => {
  const text = [
    '### 3.1 `docs/acceptance.md`', '', '```markdown',
    '# Acceptance procedure', '', 'Run:', '', '```bash', 'npm test', '```',
    '', 'This remaining content belongs to the proposed file.', '```', '',
  ].join('\n');
  assert.deepEqual(extractGeneratedFiles(text), []);
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
  assert.equal(receipt.artifactStatus, 'plan-only');
  assert.deepEqual(receipt.files, []);
  assert.deepEqual(receipt.skillFiles, []);
  assert.deepEqual(receipt.fileExtractionIssues, [{ code: 'AMBIGUOUS_FILE_FENCE', path: 'docs/acceptance.md', openingLine: 3, line: 8 }]);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
  assert.equal(receipt.sha256, hash(text));
  assert.equal((await readdir(directory)).includes('generated-files'), false);
});

test('an incomplete named file prevents a retained Skill from counting as complete', async () => {
  const skill = '---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRun `npm test`.\n';
  const text = '### `.agents/skills/verify-owned/SKILL.md`\n\n````markdown\n' + skill + '````\n\n### 3.2 `docs/missing.md`\n\n````markdown\nNo closing fence.\n';
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
  assert.equal(receipt.files.length, 1);
  assert.deepEqual(receipt.skillFiles, ['.agents/skills/verify-owned/SKILL.md']);
  assert.equal(receipt.artifactStatus, 'incomplete-generated-files');
  assert.deepEqual(receipt.fileExtractionIssues, [{ code: 'UNCLOSED_FILE_FENCE', path: 'docs/missing.md', openingLine: 14 }]);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
});

test('Chinese file-path labels under the owned absolute project root retain exact complete files', async () => {
  const root = '/owned/project';
  const skillPath = '.agents/skills/verify-owned/SKILL.md', resourcePath = '.agents/skills/verify-owned/references/happy.md';
  const skill = '---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRead [the case](references/happy.md).\n\n```sh\nnpm test\n```\n';
  const resource = '# Happy path\n\nVerify the actual HTTP response.\n';
  const text = '**文件路径：** `' + root + '/' + skillPath + '`\n\n````markdown\n' + skill + '````\n\n**文件路径：** `' + root + '/' + resourcePath + '`\n\n```markdown\n' + resource + '```\n';
  const files = extractGeneratedFiles(text, { projectRoot: root });
  assert.deepEqual(files.map(file => file.path), [skillPath, resourcePath]);
  for (const [index, content] of [skill, resource].entries()) {
    assert.equal(files[index].content, content);
    assert.equal(files[index].sha256, hash(content));
    assert.equal(text.slice(files[index].sourceSpan.start, files[index].sourceSpan.end), content);
  }
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project: { ...project, root } });
  assert.equal(receipt.artifactStatus, 'complete-skill-files-retained');
  assert.deepEqual(receipt.skillFiles, [skillPath]);
  assert.deepEqual(receipt.unresolvedReferences, []);
  assert.equal(await readFile(join(directory, 'generated-files', skillPath), 'utf8'), skill);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
});

test('absolute generated paths require an exact owned root and cannot escape through prefixes or traversal', () => {
  const root = '/owned/project';
  const block = path => '**文件路径：** `' + path + '`\n\n```text\nExact model bytes.\n```\n';
  const accepted = root + '/docs/acceptance.md';
  assert.deepEqual(extractGeneratedFiles(block(accepted)), []);
  assert.equal(extractGeneratedFiles(block(accepted), { projectRoot: root })[0]?.path, 'docs/acceptance.md');
  for (const path of ['/outside/docs/acceptance.md', root + '-other/docs/acceptance.md', root + '/../escape/acceptance.md', root + '/docs/../acceptance.md', root + '//docs/acceptance.md']) {
    assert.deepEqual(extractGeneratedFiles(block(path), { projectRoot: root }), [], path);
  }
});


test('language-prefixed path labels retain exact complete Skill and resource bytes', async () => {
  const skillPath = '.cursor/skills/verify-owned/SKILL.md', resourcePath = '.cursor/skills/verify-owned/features/README.md';
  const skill = '---\r\nname: verify-owned\r\ndescription: Verify the owned project.\r\n---\r\n\r\n# 验证\r\n\r\nRead [the case](features/README.md).\r\n\r\n```sh\r\nnpm test\r\n```\r\n';
  const resource = '# Case\r\n\r\nVerify the actual HTTP response.\r\n';
  const text = '````markdown path: "' + skillPath + '"\r\n' + skill + '````\r\n\r\n~~~text path: ' + resourcePath + '\r\n' + resource + '~~~\r\n';
  const files = extractGeneratedFiles(text);
  assert.deepEqual(files.map(file => file.path), [skillPath, resourcePath]);
  for (const [index, content] of [skill, resource].entries()) {
    assert.equal(files[index].content, content);
    assert.equal(files[index].bytes, Buffer.byteLength(content));
    assert.equal(files[index].sha256, hash(content));
    assert.deepEqual(files[index].sourceSpan, { start: text.indexOf(content), end: text.indexOf(content) + content.length });
    assert.equal(text.slice(files[index].sourceSpan.start, files[index].sourceSpan.end), content);
  }
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
  assert.equal(receipt.artifactStatus, 'complete-skill-files-retained');
  assert.deepEqual(receipt.skillFiles, [skillPath]);
  assert.deepEqual(receipt.unresolvedReferences, []);
  assert.deepEqual(receipt.fileExtractionIssues, []);
  for (const file of files) assert.equal(await readFile(join(directory, 'generated-files', file.path), 'utf8'), file.content);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
  assert.equal(receipt.sha256, hash(text));
  assert.equal(receipt.executed, false);
});

test('language-prefixed path labels retain the owned path boundaries', () => {
  const root = '/owned/project';
  const block = path => '```text path: ' + path + '\nExact model bytes.\n```\n';
  const accepted = root + '/docs/acceptance.md';
  assert.deepEqual(extractGeneratedFiles(block(accepted)), []);
  assert.equal(extractGeneratedFiles(block(accepted), { projectRoot: root })[0]?.path, 'docs/acceptance.md');
  for (const path of [
    '/outside/docs/acceptance.md', root + '-other/docs/acceptance.md',
    root + '/../escape/acceptance.md', root + '/docs/../acceptance.md', root + '//docs/acceptance.md',
    '../escape/acceptance.md', 'docs/../acceptance.md', 'docs/./acceptance.md', 'docs//acceptance.md',
  ]) assert.deepEqual(extractGeneratedFiles(block(path), { projectRoot: root }), [], path);
});

test('language-prefixed path labels reject conflicting definitions across accepted forms', () => {
  const block = (label, content) => '```text ' + label + '\n' + content + '```\n';
  const first = block('path: docs/acceptance.md', 'Exact model bytes.\n');
  const duplicate = block('path=docs/acceptance.md', 'Exact model bytes.\n');
  assert.equal(extractGeneratedFiles(first + duplicate).length, 1);
  assert.throws(() => extractGeneratedFiles(first + block('path=docs/acceptance.md', 'Different bytes.\n')), /conflicting complete definitions/);
});

test('language-prefixed path labels preserve unclosed and ambiguous fence failures', async () => {
  for (const [text, issue] of [
    ['```markdown path: docs/acceptance.md\nNo closing fence.\n', { code: 'UNCLOSED_FILE_FENCE', path: 'docs/acceptance.md', openingLine: 1 }],
    ['```markdown path: docs/acceptance.md\nRun:\n```sh\nnpm test\n```\nTrailing file content.\n```\n', { code: 'AMBIGUOUS_FILE_FENCE', path: 'docs/acceptance.md', openingLine: 1, line: 3 }],
  ]) {
    const directory = await evidence();
    const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
    assert.equal(receipt.artifactStatus, 'plan-only');
    assert.deepEqual(receipt.files, []);
    assert.deepEqual(receipt.skillFiles, []);
    assert.deepEqual(receipt.fileExtractionIssues, [issue]);
    assert.equal(await readFile(receipt.path, 'utf8'), text);
    assert.equal((await readdir(directory)).includes('generated-files'), false);
  }
});

test('language-prefixed path labels do not promote incomplete Skills', async () => {
  for (const content of [
    '# No frontmatter\n\nRun the procedure.\n',
    '---\nname: verify-owned\n---\n\nRun the procedure.\n',
    '---\nname: verify-owned\ndescription: Verify the owned project.\n---\n',
  ]) {
    const text = '```markdown path: .cursor/skills/verify-owned/SKILL.md\n' + content + '```\n';
    const directory = await evidence();
    const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
    assert.equal(receipt.artifactStatus, 'incomplete-generated-files');
    assert.equal(receipt.files.length, 1);
    assert.deepEqual(receipt.skillFiles, []);
    assert.deepEqual(receipt.fileExtractionIssues, []);
    assert.equal(await readFile(receipt.path, 'utf8'), text);
  }
});


test('a first body-line path retains exact Skill and resource bytes and spans', async () => {
  const skillPath = '.cursor/skills/verify-owned/SKILL.md', resourcePath = '.cursor/skills/verify-owned/features/README.md';
  const skill = '---\r\nname: verify-owned\r\ndescription: Verify the owned project.\r\n---\r\n\r\n# 验证\r\n\r\nRead [the case](features/README.md).\r\n\r\n```sh\r\nnpm test\r\n```\r\n';
  const resource = '# Case\r\n\r\nVerify the response.\r\n';
  const text = '````markdown\r\n' + skillPath + '\r\n' + skill + '````\r\n\r\n~~~text\r\npath: ' + resourcePath + '\r\n' + resource + '~~~\r\n';
  const files = extractGeneratedFiles(text);
  assert.deepEqual(files.map(file => file.path), [skillPath, resourcePath]);
  for (const [index, content] of [skill, resource].entries()) {
    assert.equal(files[index].content, content);
    assert.equal(files[index].bytes, Buffer.byteLength(content));
    assert.equal(files[index].sha256, hash(content));
    assert.deepEqual(files[index].sourceSpan, { start: text.indexOf(content), end: text.indexOf(content) + content.length });
    assert.equal(text.slice(files[index].sourceSpan.start, files[index].sourceSpan.end), content);
  }
  const directory = await evidence();
  const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
  assert.equal(receipt.artifactStatus, 'complete-skill-files-retained');
  assert.deepEqual(receipt.skillFiles, [skillPath]);
  assert.deepEqual(receipt.fileExtractionIssues, []);
  assert.deepEqual(receipt.unresolvedReferences, []);
  for (const file of files) assert.equal(await readFile(join(directory, 'generated-files', file.path), 'utf8'), file.content);
  assert.equal(await readFile(receipt.path, 'utf8'), text);
});

test('existing info and preceding paths outrank a path-shaped first body line', () => {
  const content = 'docs/literal-first-line.md\nKeep this exact first body line.\n';
  for (const [expectedPath, text] of [
    ['docs/from-info.md', '```text path=docs/from-info.md\n' + content + '```\n'],
    ['docs/from-heading.md', '### `docs/from-heading.md`\n\n```text\n' + content + '```\n'],
  ]) {
    const [file] = extractGeneratedFiles(text);
    assert.equal(file.path, expectedPath);
    assert.equal(file.content, content);
    assert.equal(text.slice(file.sourceSpan.start, file.sourceSpan.end), content);
  }
  assert.deepEqual(extractGeneratedFiles('```text\n\ndocs/not-the-first-line.md\nNot a path annotation.\n```\n'), []);
});

test('first body-line paths retain the exact owned root and unsafe path boundaries', () => {
  const root = '/owned/project', block = path => '```text\n' + path + '\nExact model bytes.\n```\n';
  const accepted = root + '/docs/acceptance.md';
  assert.deepEqual(extractGeneratedFiles(block(accepted)), []);
  assert.equal(extractGeneratedFiles(block(accepted), { projectRoot: root })[0]?.path, 'docs/acceptance.md');
  for (const path of [
    '/outside/docs/acceptance.md', root + '-other/docs/acceptance.md', root + '/../escape/acceptance.md',
    root + '/docs/../acceptance.md', root + '//docs/acceptance.md', '../escape/acceptance.md',
    'docs/../acceptance.md', 'docs/./acceptance.md', 'docs//acceptance.md',
  ]) assert.deepEqual(extractGeneratedFiles(block(path), { projectRoot: root }), [], path);
});

test('first body-line paths preserve ambiguous and unclosed fence failures', async () => {
  for (const [text, issue] of [
    ['```markdown\ndocs/acceptance.md\nNo closing fence.\n', { code: 'UNCLOSED_FILE_FENCE', path: 'docs/acceptance.md', openingLine: 1 }],
    ['```markdown\ndocs/acceptance.md\nRun:\n```sh\nnpm test\n```\nTrailing content.\n```\n', { code: 'AMBIGUOUS_FILE_FENCE', path: 'docs/acceptance.md', openingLine: 1, line: 4 }],
  ]) {
    const directory = await evidence();
    const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
    assert.equal(receipt.artifactStatus, 'plan-only');
    assert.deepEqual(receipt.files, []);
    assert.deepEqual(receipt.skillFiles, []);
    assert.deepEqual(receipt.fileExtractionIssues, [issue]);
    assert.equal(await readFile(receipt.path, 'utf8'), text);
    assert.equal((await readdir(directory)).includes('generated-files'), false);
  }
});

test('first body-line paths reject empty and conflicting definitions', () => {
  const block = content => '```text\ndocs/acceptance.md\n' + content + '```\n';
  assert.throws(() => extractGeneratedFiles(block('')), /cannot be empty/);
  assert.equal(extractGeneratedFiles(block('Same bytes.\n') + block('Same bytes.\n')).length, 1);
  assert.throws(() => extractGeneratedFiles(block('First bytes.\n') + block('Different bytes.\n')), /conflicting complete definitions/);
});

test('first body-line paths do not promote incomplete Skills or missing references', async () => {
  const skillPath = '.cursor/skills/verify-owned/SKILL.md';
  for (const [content, skillFiles, unresolvedReferences] of [
    ['# No frontmatter\n\nRun the procedure.\n', [], []],
    ['---\nname: verify-owned\n---\n\nRun the procedure.\n', [], []],
    ['---\nname: verify-owned\ndescription: Verify the owned project.\n---\n', [], []],
    ['---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRead [the case](references/missing.md).\n', [skillPath], [{ from: skillPath, href: 'references/missing.md' }]],
  ]) {
    const text = '```markdown\n' + skillPath + '\n' + content + '```\n';
    const directory = await evidence();
    const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
    assert.equal(receipt.artifactStatus, 'incomplete-generated-files');
    assert.equal(receipt.files.length, 1);
    assert.deepEqual(receipt.skillFiles, skillFiles);
    assert.deepEqual(receipt.fileExtractionIssues, []);
    assert.deepEqual(receipt.unresolvedReferences, unresolvedReferences);
    assert.equal(await readFile(receipt.path, 'utf8'), text);
  }
});
