import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedGraphProject, inspectOwnedGraphProject, extractGeneratedFiles, retainGeneratedPlan } from './notion-skill-graph-project.mjs';
import * as graphProject from './notion-skill-graph-project.mjs';
import { dailyRouteContract } from './verify-skill-graph-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const project = { sha256: hash('controlled file extraction fixture'), files: [] };
const prompt = { sha256: hash('unchanged natural task') };
const evidence = async () => mkdtemp(join(await realpath(tmpdir()), 'graph-file-extraction-'));
const systemTrashAvailable = process.env.GRAPH_TEST_DISABLE_SYSTEM_TRASH !== '1' && process.platform === 'darwin'
  && await fsPromises.access('/usr/bin/trash', 1).then(() => true, () => false);
const trashNotRun = (t, result) => t.diagnostic('System Trash ECE not_run: ' + JSON.stringify({ platform: process.platform,
  capability: 'unavailable-or-explicitly-disabled-for-test', coreAssertions: 'executed', evidence: result.evidence, scratch: result.scratch }));

const dailyProfile = () => dailyRouteContract({ modelContract: 'daily-route-v1', model: 'magpie/group/flash', thinkingLevel: 'high', rpcTimeoutMs: 300000 });
test('daily existing project check keeps the same sixth-file policy before and after execution', async () => {
  const base = await evidence(), modelProfile = dailyProfile();
  const actualProject = await createOwnedGraphProject(join(base, 'project'), { modelProfile });
  const output = join(base, 'evidence'); await mkdir(output);
  const final = { success: true, text: '````markdown path: .agents/skills/verify-owned/SKILL.md\n---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRun `npm test` for existing project checks.\n````\n' };
  const generatedPlan = await retainGeneratedPlan({ evidence: output, final, prompt, project: actualProject });
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', evidence: output, modelProfile, project: actualProject, generatedPlan, files: [] }));
  const execution = await graphProject.exerciseExistingProjectCommand(output, ['npm', 'test']);
  assert.equal(execution.status, 'passed');
  assert.deepEqual(await inspectOwnedGraphProject(actualProject.root, { modelProfile }), actualProject);
});
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

test('an unnamed file inventory does not conflict with six complete Skill files', async () => {
  const root = '.cursor/skills/verify-owned';
  for (const newline of ['\n', '\r\n']) {
    const entries = [
      ['SKILL.md', '---\nname: verify-owned\ndescription: Verify the owned project.\n---\n\nRead [the map](features/README.md).\n'],
      ['features/README.md', '# Cases\n\n[Create](create-ticket.md), [lookup](lookup-ticket.md), [failure](failure-handling.md).\n'],
      ['features/create-ticket.md', '# Create\n\nVerify a stored ticket.\n'],
      ['features/lookup-ticket.md', '# Lookup\n\nVerify the selected ticket.\n'],
      ['features/failure-handling.md', '# Failures\n\nReject invalid input.\n'],
      ['scripts/acceptance.mjs', '// Owned verification helper.\n'],
    ].map(([path, content]) => ({ path: root + '/' + path, content: content.replaceAll('\n', newline) }));
    const inventory = '# 文件清单' + newline + newline + '```' + newline + entries.map(file => file.path).join(newline) + newline + '```' + newline + newline;
    const text = inventory + entries.map(file => '## `' + file.path + '`' + newline + newline + '```text' + newline + file.content + '```' + newline + newline).join('');
    const files = extractGeneratedFiles(text);
    assert.deepEqual(files.map(file => file.path), entries.map(file => file.path));
    for (const [index, expected] of entries.entries()) {
      const file = files[index];
      assert.equal(file.content, expected.content);
      assert.equal(file.bytes, Buffer.byteLength(expected.content));
      assert.equal(file.sha256, hash(expected.content));
      assert.equal(text.slice(file.sourceSpan.start, file.sourceSpan.end), expected.content);
    }
    const directory = await evidence();
    const receipt = await retainGeneratedPlan({ evidence: directory, final: { success: true, text }, prompt, project });
    assert.equal(receipt.artifactStatus, 'complete-skill-files-retained');
    assert.deepEqual(receipt.skillFiles, [root + '/SKILL.md']);
    assert.deepEqual(receipt.fileExtractionIssues, []);
    assert.deepEqual(receipt.unresolvedReferences, []);
    assert.equal(await readFile(receipt.path, 'utf8'), text);
    for (const file of entries) assert.equal(await readFile(join(directory, 'generated-files', file.path), 'utf8'), file.content);
  }
});

test('path-only inventories stay unnamed while explicitly named path-only files retain their bytes', () => {
  const content = 'docs/one.md\n\ndocs/two.md\n';
  for (const info of ['', 'text']) assert.deepEqual(extractGeneratedFiles('```' + info + '\n' + content + '```\n'), []);
  for (const text of [
    '```text path=docs/inventory.txt\n' + content + '```\n',
    '## `docs/inventory.txt`\n\n```text\n' + content + '```\n',
    '```text\npath: docs/inventory.txt\n' + content + '```\n',
  ]) {
    const files = extractGeneratedFiles(text);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'docs/inventory.txt');
    assert.equal(files[0].content, content);
    assert.equal(text.slice(files[0].sourceSpan.start, files[0].sourceSpan.end), content);
  }
});

test('an earlier file inventory does not hide genuinely conflicting complete definitions', () => {
  const inventory = '```text\ndocs/listed-one.md\ndocs/listed-two.md\n```\n';
  const block = content => '```text path=docs/acceptance.md\n' + content + '```\n';
  assert.throws(() => extractGeneratedFiles(inventory + block('First bytes.\n') + block('Different bytes.\n')), /conflicting complete definitions/);
  const files = extractGeneratedFiles(inventory + block('Same bytes.\n') + block('Same bytes.\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0].content, 'Same bytes.\n');
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

async function controlledLoopbackFeature() {
  const assert = (await import('node:assert/strict')).default;
  const { spawn } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  const requests = [], report = { pid: child.pid, args: ['src/server.mjs'], cwd: process.cwd(), inheritedSecret: process.env.GENERATED_HELPER_TEST_SECRET ?? null };
  try {
    const ready = await new Promise((accept, reject) => { child.once('error', reject); child.stdout.once('data', bytes => { try { accept(JSON.parse(bytes.toString())); } catch (error) { reject(error); } }); });
    assert.equal(ready.address.address, '127.0.0.1'); assert.ok(ready.address.port > 0); report.ready = ready;
    const origin = 'http://127.0.0.1:' + ready.address.port;
    const request = async (path, options = {}) => {
      const response = await fetch(origin + path, options), body = await response.json();
      requests.push({ method: options.method ?? 'GET', path, requestBody: options.body ?? null, status: response.status, responseBody: body });
      return { status: response.status, body };
    };
    const created = await request('/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'Reviewed generated helper', priority: 'high' }) });
    assert.equal(created.status, 201); assert.equal(created.body.priority, 'high');
    const fetched = await request('/tickets/' + created.body.id);
    assert.equal(fetched.status, 200); assert.deepEqual(fetched.body, created.body);
    report.requests = requests;
  } finally { child.kill('SIGTERM'); report.closed = await closed; }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/feature.json', JSON.stringify(report, null, 2) + '\n');
}

async function reviewedHelperFixture(t, { helper = '(' + controlledLoopbackFeature.toString() + ')();\n', status = 'passed', extraFiles = [] } = {}) {
  const root = await evidence(), output = join(root, 'evidence'), privateRoot = join(root, 'private');
  await mkdir(output); await mkdir(privateRoot);
  const modelProfile = dailyProfile(), actualProject = await createOwnedGraphProject(join(root, 'project'), { modelProfile });
  const entry = '.agents/skills/verify-owned/scripts/acceptance.mjs';
  const files = [
    { path: '.agents/skills/verify-owned/SKILL.md', content: '---\nname: verify-owned\ndescription: Verify one owned ticket feature.\n---\n\nUse [the complete helper](scripts/acceptance.mjs). Do not substitute `npm test`.\n' },
    { path: entry, content: helper }, ...extraFiles,
  ];
  const final = { success: true, text: files.map(file => '````text path: ' + file.path + '\n' + file.content + '````\n').join('\n') };
  const generatedPlan = await retainGeneratedPlan({ evidence: output, final, prompt, project: actualProject });
  const result = { version: 1, status, evidence: output, scratch: root, modelProfile, project: actualProject, generatedPlan, files: [] };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const reviewPath = join(await evidence(), 'review.json');
  const review = { version: 1, purpose: 'generated-helper-exercise', reviewer: 'independent controlled-fixture reviewer', approvedForOwnedExercise: true,
    parent: { evidence: output, resultSha256: hash(await readFile(join(output, 'result.json'))), planSha256: generatedPlan.sha256, projectSha256: actualProject.sha256,
      files: generatedPlan.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) },
    entry: { path: entry, sha256: hash(helper) }, command: { executable: await realpath(process.execPath), args: [entry] }, budget: { timeoutMs: 20000, killGraceMs: 1000 } };
  await writeFile(reviewPath, JSON.stringify(review, null, 2) + '\n', { mode: 0o600 });
  const originalResult = await readFile(join(output, 'result.json'));
  t.diagnostic('Owned reviewed-helper fixture: ' + JSON.stringify({ root, reviewPath, realPi: 0, realModel: 0, realNotion: 0 }));
  return { root, evidence: output, reviewPath, review, result, project: actualProject, originalResult, generatedPlan, entry };
}

test('reviewed generated helper drives real loopback HTTP; available system Trash completes CLI ECE', async t => {
  const value = await reviewedHelperFixture(t);
  const driver = new URL('./notion-skill-graph-model.mjs', import.meta.url).pathname;
  const invoke = (action, args) => spawnSync(process.execPath, [driver, action, ...args], { encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GENERATED_HELPER_TEST_SECRET: 'controlled-secret-must-not-be-inherited' } });
  const exercised = invoke('exercise', ['--evidence', value.evidence, '--review', value.reviewPath]);
  assert.equal(exercised.status, 0, exercised.stderr);
  const result = JSON.parse(exercised.stdout);
  t.diagnostic('Owned generated-helper exercise: ' + JSON.stringify({ evidence: result.evidence, scratch: result.scratch }));
  assert.equal(result.kind, 'generated-helper-exercise'); assert.equal(result.status, 'completed');
  assert.notEqual(result.project.root, value.project.root); assert.equal(result.project.sha256, value.project.sha256);
  assert.equal(result.execution.spawnObserved, true); assert.equal(result.execution.closeObserved, true);
  assert.equal(result.execution.processGroupAbsent, true); assert.equal(result.execution.code, 0);
  assert.deepEqual(result.execution.args, value.review.command.args); assert.equal(result.execution.entrySha256, value.review.entry.sha256);
  assert.equal(result.productAcceptance.status, 'independent-review-required');
  assert.equal(result.productAcceptance.generatedProcedureExecuted, undefined);
  await assert.rejects(readFile(join(result.project.root, '.pi/settings.json')), error => error.code === 'ENOENT');
  for (const file of value.generatedPlan.files) assert.equal(hash(await readFile(join(result.project.root, file.path))), file.sha256);
  const actual = JSON.parse(await readFile(join(result.evidence, 'owned-output/artifacts/feature.json'), 'utf8'));
  assert.equal(actual.inheritedSecret, null); assert.equal(actual.ready.address.address, '127.0.0.1');
  assert.deepEqual(actual.requests.map(row => [row.method, row.status]), [['POST', 201], ['GET', 200]]);
  assert.deepEqual(JSON.parse(actual.requests[0].requestBody), { subject: 'Reviewed generated helper', priority: 'high' });
  assert.deepEqual(actual.requests[1].responseBody, actual.requests[0].responseBody);
  assert.equal(actual.closed.code, 0);
  const reference = { evidence: result.evidence, resultSha256: hash(await readFile(join(result.evidence, 'result.json'))) };
  await assert.rejects(graphProject.verifyGeneratedExerciseAcceptance(value.result, reference), /requires owned exercise cleanup/);
  const lifecycle = [];
  for (const action of systemTrashAvailable ? ['evidence', 'cleanup', 'evidence'] : ['evidence']) {
    const run = invoke(action, ['--evidence', result.evidence]); assert.equal(run.status, 0, run.stderr);
    lifecycle.push({ action, result: JSON.parse(run.stdout) });
  }
  await writeFile(join(value.root, 'exercise-ece.json'), JSON.stringify({ systemTrash: systemTrashAvailable ? 'completed' : 'not_run', lifecycle }, null, 2) + '\n');
  assert.ok(lifecycle.every(row => row.result.status === 'preserved'));
  if (systemTrashAvailable) {
    assert.equal(lifecycle[1].result.cleanup, 'trashed');
    await assert.rejects(readFile(join(result.scratch, 'ownership.json')), error => error.code === 'ENOENT');
  } else trashNotRun(t, result);
  assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult, 'Original model evidence remains immutable');
  assert.deepEqual(await inspectOwnedGraphProject(value.project.root, { modelProfile: value.result.modelProfile }), value.project);
  if (systemTrashAvailable) assert.equal((await graphProject.verifyGeneratedExerciseAcceptance(value.result, reference)).execution, 'completed');
  else await assert.rejects(graphProject.verifyGeneratedExerciseAcceptance(value.result, reference), /requires owned exercise cleanup/);
});

for (const fault of ['missing-review', 'failed-prerequisite', 'result-hash', 'plan-bytes', 'helper-bytes', 'file-manifest', 'entry-argv', 'interpreter', 'budget', 'incomplete', 'unsafe-path', 'symlink', 'baseline-overwrite', 'runtime-settings', 'consumer-review']) {
  test('reviewed helper rejects ' + fault + ' before creating an execution or spawning', async t => {
    const extraFiles = fault === 'baseline-overwrite' ? [{ path: 'src/tickets.mjs', content: 'changed\n' }]
      : fault === 'runtime-settings' ? [{ path: '.pi/settings.json', content: '{}\n' }] : [];
    const value = await reviewedHelperFixture(t, { status: fault === 'failed-prerequisite' ? 'failed' : 'passed', extraFiles });
    const receipt = structuredClone(value.generatedPlan), review = structuredClone(value.review);
    let reviewPath = value.reviewPath;
    if (fault === 'missing-review') reviewPath += '.missing';
    if (fault === 'result-hash') review.parent.resultSha256 = '0'.repeat(64);
    if (fault === 'plan-bytes') await writeFile(receipt.path, 'changed actual final');
    if (fault === 'helper-bytes') await writeFile(join(value.evidence, 'generated-files', value.entry), 'console.log("changed");\n');
    if (fault === 'file-manifest') review.parent.files.pop();
    if (fault === 'entry-argv') review.command.args = ['--eval', 'console.log("must not run")'];
    if (fault === 'interpreter') review.command.executable = '/bin/sh';
    if (fault === 'budget') review.budget.timeoutMs = 20001;
    if (fault === 'incomplete') receipt.artifactStatus = 'incomplete-generated-files';
    if (fault === 'unsafe-path') receipt.files[0].path = '../escape/SKILL.md';
    if (['incomplete', 'unsafe-path'].includes(fault)) await writeFile(join(value.evidence, 'generated-plan.json'), JSON.stringify(receipt));
    if (fault === 'symlink') { const target = join(value.evidence, 'generated-files', value.entry); await rename(target, target + '.original'); await symlink(target + '.original', target); }
    if (fault === 'consumer-review') reviewPath = join(value.evidence, 'self-approval.json');
    if (fault !== 'missing-review') await writeFile(reviewPath, JSON.stringify(review));
    const before = await readdir(value.root);
    await assert.rejects(graphProject.exerciseReviewedGeneratedHelper(value.evidence, reviewPath));
    assert.deepEqual(await readdir(value.root), before, 'No execution evidence or owned installation was created');
    assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult);
  });
}

for (const [name, helper, budget] of [
  ['nonzero', 'process.exitCode = 17;\n', { timeoutMs: 20000, killGraceMs: 1000 }],
  ['timeout', 'setInterval(() => {}, 1000);\n', { timeoutMs: 100, killGraceMs: 1000 }],
  ['only-prints-pass', 'console.log("PASS");\n', { timeoutMs: 20000, killGraceMs: 1000 }],
]) test('helper ' + name + ' retains actual execution without manufacturing feature acceptance', async t => {
  const value = await reviewedHelperFixture(t, { helper }); value.review.budget = budget;
  await writeFile(value.reviewPath, JSON.stringify(value.review));
  const result = await graphProject.exerciseReviewedGeneratedHelper(value.evidence, value.reviewPath);
  t.diagnostic('Owned generated-helper exercise: ' + JSON.stringify({ evidence: result.evidence, scratch: result.scratch }));
  assert.equal(result.status, name === 'only-prints-pass' ? 'completed' : 'failed');
  assert.equal(result.productAcceptance.status, 'independent-review-required');
  assert.equal(result.execution.closeObserved, true); assert.equal(result.execution.processGroupAbsent, true);
  assert.equal(result.execution.timedOut, name === 'timeout');
  if (name === 'nonzero') assert.equal(result.execution.code, 17);
  const reference = { evidence: result.evidence, resultSha256: hash(await readFile(join(result.evidence, 'result.json'))) };
  if (name !== 'only-prints-pass') await assert.rejects(graphProject.verifyGeneratedExerciseAcceptance(value.result, reference));
  await graphProject.inspectGeneratedExercise(result.evidence);
  if (systemTrashAvailable) { await graphProject.cleanupGeneratedExercise(result.evidence); await graphProject.inspectGeneratedExercise(result.evidence); }
  else trashNotRun(t, result);
  assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult);
});

test('a setup copy failure retains a not-run receipt; available system Trash completes ECE', async t => {
  const value = await reviewedHelperFixture(t);
  const originalWrite = fsPromises.writeFile;
  let failedCopy = false, result;
  fsPromises.writeFile = async (file, ...args) => {
    if (!failedCopy && String(file).includes('/graph-generated-exercise-') && String(file).includes('/project/') && String(file).endsWith('/scripts/acceptance.mjs')) {
      failedCopy = true; throw Object.assign(new Error('Controlled full-helper copy failure'), { code: 'EIO' });
    }
    return originalWrite(file, ...args);
  };
  syncBuiltinESMExports();
  try { result = await graphProject.exerciseReviewedGeneratedHelper(value.evidence, value.reviewPath); }
  finally { fsPromises.writeFile = originalWrite; syncBuiltinESMExports(); }
  t.diagnostic('Owned generated-helper exercise: ' + JSON.stringify({ evidence: result.evidence, scratch: result.scratch }));
  assert.equal(failedCopy, true); assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'EIO');
  assert.equal(result.error.stage, 'install-generated-files'); assert.equal(result.execution.status, 'not_run');
  assert.equal(result.execution.spawnObserved, false); assert.equal(result.execution.closeObserved, false);
  const before = await readFile(join(result.evidence, 'result.json'));
  const driver = new URL('./notion-skill-graph-model.mjs', import.meta.url).pathname;
  const lifecycle = [];
  for (const action of systemTrashAvailable ? ['evidence', 'cleanup', 'evidence'] : ['evidence']) {
    const run = spawnSync(process.execPath, [driver, action, '--evidence', result.evidence], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr); lifecycle.push({ action, result: JSON.parse(run.stdout) });
  }
  await writeFile(join(value.root, 'setup-failure-ece.json'), JSON.stringify({ systemTrash: systemTrashAvailable ? 'completed' : 'not_run', lifecycle }, null, 2) + '\n');
  if (!systemTrashAvailable) trashNotRun(t, result);
  assert.ok(lifecycle.every(row => row.result.functionalStatus === 'failed'));
  assert.deepEqual(await readFile(join(result.evidence, 'result.json')), before);
  assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult);
});

async function controlledDetachedPipeHolder() {
  const { spawn } = await import('node:child_process');
  const { mkdir, readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  await mkdir('artifacts', { recursive: true });
  const marker = resolve('artifacts/child-owner.json'), token = process.argv[2];
  const code = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),executable:process.execPath,argv:process.argv.slice(1),token:process.argv[2]})); setInterval(()=>{},1000);';
  const child = spawn(process.execPath, ['-e', code, marker, token], { detached: true, stdio: ['ignore', process.stdout, process.stderr] });
  child.unref();
  for (;;) { try { await readFile(marker); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(accept => setTimeout(accept, 10)); } }
}

test('a detached fixture pipe holder cannot keep the runner waiting or manufacture close and cleanup', async t => {
  const value = await reviewedHelperFixture(t, { helper: '(' + controlledDetachedPipeHolder.toString() + ')();\n' });
  const token = hash('owned detached fixture ' + value.root);
  value.review.command.args.push(token); value.review.budget = { timeoutMs: 250, killGraceMs: 100 };
  await writeFile(value.reviewPath, JSON.stringify(value.review));
  const started = Date.now(), result = await graphProject.exerciseReviewedGeneratedHelper(value.evidence, value.reviewPath);
  t.diagnostic('Owned generated-helper exercise with outer cleanup: ' + JSON.stringify({ evidence: result.evidence, scratch: result.scratch }));
  const owner = JSON.parse(await readFile(join(result.evidence, 'owned-output/artifacts/child-owner.json'), 'utf8'));
  assert.equal(owner.token, token); assert.equal(owner.executable, await realpath(process.execPath));
  assert.deepEqual(owner.argv, [join(result.project.root, 'artifacts/child-owner.json'), token]);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Date.parse(owner.startedAt) >= started);
  const present = () => { try { process.kill(owner.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const original = await readFile(join(result.evidence, 'result.json'));
  const outer = { kind: 'controlled-fixture-owned-detached-child', owner, originalResultSha256: hash(original), driverCleanup: 'blocked', steps: [] };
  try {
    assert.ok(Date.now() - started < 5000, 'The hard deadline must return even without natural pipe EOF');
    assert.equal(result.status, 'failed'); assert.equal(result.execution.processExitObserved, true);
    assert.equal(result.execution.closeObserved, false); assert.equal(result.execution.forcedPipeClosure, true);
    assert.equal(result.execution.stdoutComplete, false); assert.equal(result.execution.stderrComplete, false);
    assert.equal(result.execution.processScope, 'incomplete-finality-unknown-pipe-holder');
    outer.steps.push({ action: 'evidence', status: (await graphProject.inspectGeneratedExercise(result.evidence)).status });
    await assert.rejects(graphProject.cleanupGeneratedExercise(result.evidence), /finality/);
    await assert.rejects(graphProject.verifyGeneratedExerciseAcceptance(value.result, { evidence: result.evidence, resultSha256: hash(original) }));
  } finally {
    // This fixture, not the driver, deliberately created and identified this
    // one child. Its cleanup is outside the driver's still-failed raw receipt.
    if (present()) { process.kill(owner.pid, 'SIGTERM'); outer.steps.push({ action: 'signal-known-fixture-child', pid: owner.pid, signal: 'SIGTERM' }); }
    const deadline = Date.now() + 2000;
    while (present() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 20));
    assert.equal(present(), false, 'Only the explicitly identified fixture child may be stopped');
    if (systemTrashAvailable) {
      const trashed = spawnSync('/usr/bin/trash', [result.scratch], { encoding: 'utf8', timeout: 10000 });
      assert.equal(trashed.status, 0, trashed.stderr);
      outer.steps.push({ action: 'outer-owned-fixture-trash', scratch: result.scratch, code: trashed.status });
      await assert.rejects(readFile(join(result.scratch, 'ownership.json')), error => error.code === 'ENOENT');
    } else { outer.steps.push({ action: 'outer-owned-fixture-trash', status: 'not_run', reason: 'system-trash-unavailable' }); trashNotRun(t, result); }
    for (const file of result.artifacts) assert.equal(hash(await readFile(join(result.evidence, file.path))), file.sha256);
    assert.deepEqual(await readFile(join(result.evidence, 'result.json')), original);
    outer.steps.push({ action: systemTrashAvailable ? 'evidence-after-outer-cleanup' : 'evidence-with-fixture-retained', retainedFiles: result.artifacts.length, originalResultUnchanged: true, knownChildAbsent: true });
    await writeFile(join(value.root, 'hard-deadline-outer-ece.json'), JSON.stringify(outer, null, 2) + '\n');
  }
  await assert.rejects(readFile(join(result.evidence, 'cleanup.json')), error => error.code === 'ENOENT', 'No successful driver cleanup is invented');
});

async function failedFinalFixture(t, { stopReason = 'stop', laterUser = false, livePid = false } = {}) {
  const value = await reviewedHelperFixture(t, { status: 'failed' });
  const artifactEvidence = await evidence();
  t.diagnostic('Owned failed-final retention: ' + JSON.stringify({ artifactEvidence }));
  const text = await readFile(value.generatedPlan.path, 'utf8');
  const generatedPlan = await retainGeneratedPlan({ evidence: artifactEvidence, final: { success: true, text }, prompt, project: value.project });
  const terminated = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); assert.equal(terminated.status, 0);
  const rows = [{ type: 'session', id: 'controlled-failed-final', version: 3, cwd: value.project.root },
    { type: 'message', id: 'current-user', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'unchanged natural task' }] } },
    { type: 'message', id: 'current-final', parentId: 'current-user', message: { role: 'assistant', provider: 'magpie', model: 'group/worker', stopReason, content: [{ type: 'text', text }] } }];
  if (laterUser) rows.push({ type: 'message', id: 'later-user', parentId: 'current-final', message: { role: 'user', content: [{ type: 'text', text: 'Another task without a final.' }] } });
  const native = rows.map(row => JSON.stringify(row)).join('\n') + '\n', sessionPath = join(value.evidence, 'native.jsonl');
  await writeFile(sessionPath, native);
  const result = { ...value.result, scope: 'project-scoped-candidate-print', arm: 'notion-only', expectedUserMessages: laterUser ? 2 : 1,
    process: { pid: livePid ? process.pid : terminated.pid, code: null, signal: 'SIGTERM', timedOut: true, startedNs: '1', endedNs: '600000000002' },
    session: { path: sessionPath, realpath: sessionPath, bytes: Buffer.byteLength(native), sha256: hash(native) },
    error: { code: 'ERR_ASSERTION', message: 'Native print process failed\n\nnull !== 0\n' },
    normalConfigurationUnchanged: true, baselineFilesUnchanged: true, projectFilesUnchanged: true, originalSessionUnchanged: true };
  delete result.generatedPlan;
  const originalResult = Buffer.from(JSON.stringify(result, null, 2) + '\n'); await writeFile(join(value.evidence, 'result.json'), originalResult);
  const retention = { version: 1, kind: 'retained-complete-native-final', status: 'retained-not-executed',
    originalGeneration: { path: join(value.evidence, 'result.json'), bytes: originalResult.length, sha256: hash(originalResult), status: 'failed', process: result.process, error: result.error },
    session: result.session, final: { entryId: 'current-final', stopReason, bytes: Buffer.byteLength(text), sha256: hash(text) },
    prompt: { bytes: Buffer.byteLength('unchanged natural task'), sha256: prompt.sha256 }, generatedPlan, originalOutcomeUnchanged: true,
    execution: 'not_run', sourceCoverage: 'Unknown remains unknown in this controlled fixture.' };
  const retentionPath = join(artifactEvidence, 'retention.json'), retentionBytes = JSON.stringify(retention, null, 2) + '\n';
  await writeFile(retentionPath, retentionBytes);
  const review = { ...value.review, parent: { ...value.review.parent, resultSha256: hash(originalResult) },
    artifactAdmission: { mode: 'reviewed-complete-failed-final', retention: { path: retentionPath, sha256: hash(retentionBytes) } } };
  await writeFile(value.reviewPath, JSON.stringify(review, null, 2) + '\n');
  return { ...value, result, originalResult, review, generatedPlan, artifactEvidence, retention, retentionPath };
}

test('artifact-only failed final uses the original helper executor and keeps the failed parent immutable through ECE', async t => {
  const value = await failedFinalFixture(t);
  const result = await graphProject.exerciseReviewedGeneratedHelper(value.evidence, value.reviewPath);
  t.diagnostic('Owned generated-helper exercise: ' + JSON.stringify({ evidence: result.evidence, scratch: result.scratch }));
  assert.equal(result.status, 'completed'); assert.equal(result.artifactAdmission.originalModelStatus, 'failed');
  assert.equal(result.artifactAdmission.mode, 'reviewed-complete-failed-final');
  assert.equal(result.productAcceptance.status, 'independent-review-required');
  const report = JSON.parse(await readFile(join(result.evidence, 'owned-output/artifacts/feature.json'), 'utf8'));
  assert.deepEqual(report.requests.map(row => [row.method, row.status]), [['POST', 201], ['GET', 200]]);
  const reference = { evidence: result.evidence, resultSha256: hash(await readFile(join(result.evidence, 'result.json'))) };
  await assert.rejects(graphProject.verifyGeneratedExerciseAcceptance(value.result, reference), /requires owned exercise cleanup/);
  await graphProject.inspectGeneratedExercise(result.evidence);
  if (systemTrashAvailable) {
    await graphProject.cleanupGeneratedExercise(result.evidence); await graphProject.inspectGeneratedExercise(result.evidence);
    const accepted = await graphProject.verifyGeneratedExerciseAcceptance(value.result, reference);
    assert.equal(accepted.originalModelStatus, 'failed'); assert.equal(accepted.scope, 'artifact-only');
  } else trashNotRun(t, result);
  assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult);
  assert.equal(JSON.parse(value.originalResult).generatedPlan, undefined);
});

test('artifact-only source rejects forged retention, missing last stop, changed artifacts and a live original PID before allocation', async t => {
  const valid = await failedFinalFixture(t);
  assert.equal((await graphProject.reviewedHelperInputs(valid.evidence, valid.reviewPath)).artifactAdmission.originalModelStatus, 'failed');
  for (const [options, mutate] of [
    [{}, async value => { value.review.artifactAdmission.retention.sha256 = '0'.repeat(64); await writeFile(value.reviewPath, JSON.stringify(value.review)); }],
    [{ stopReason: 'length' }, async () => {}],
    [{ laterUser: true }, async () => {}],
    [{ livePid: true }, async () => {}],
    [{}, async value => { await writeFile(value.generatedPlan.path, 'A replacement final that never came from the native session.'); }],
    [{}, async value => { await writeFile(join(value.artifactEvidence, 'generated-files', value.entry), 'console.log("changed");\n'); }],
  ]) {
    const value = await failedFinalFixture(t, options); await mutate(value); const before = await readdir(value.root);
    await assert.rejects(graphProject.exerciseReviewedGeneratedHelper(value.evidence, value.reviewPath));
    assert.deepEqual(await readdir(value.root), before, 'Invalid source creates no execution evidence or scratch');
    assert.deepEqual(await readFile(join(value.evidence, 'result.json')), value.originalResult);
  }
});

test('actual v12 failed result and exact retained six-file final pass read-only artifact admission without executing the helper',
  { skip: !process.env.PI_ARTIFACT_FAILED_FINAL_RETENTION }, async t => {
    const retentionPath = process.env.PI_ARTIFACT_FAILED_FINAL_RETENTION, bytes = await readFile(retentionPath), retention = JSON.parse(bytes);
    const parent = JSON.parse(await readFile(retention.originalGeneration.path, 'utf8'));
    const reviewRoot = await evidence(), reviewPath = join(reviewRoot, 'read-only-admission-review.json');
    t.diagnostic('Owned artifact admission review: ' + JSON.stringify({ reviewRoot, executed: false }));
    const entry = retention.generatedPlan.files.find(file => /\.(?:mjs|cjs|js)$/.test(file.path));
    const review = { version: 1, purpose: 'generated-helper-exercise', reviewer: 'Controlled read-only admission fixture; not the actual execution approval', approvedForOwnedExercise: true,
      parent: { evidence: parent.evidence, resultSha256: retention.originalGeneration.sha256, planSha256: retention.generatedPlan.sha256,
        projectSha256: parent.project.sha256, files: retention.generatedPlan.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) },
      artifactAdmission: { mode: 'reviewed-complete-failed-final', retention: { path: retentionPath, sha256: hash(bytes) } },
      entry: { path: entry.path, sha256: entry.sha256 }, command: { executable: await realpath(process.execPath), args: [entry.path] },
      budget: { timeoutMs: 20000, killGraceMs: 2000 } };
    await writeFile(reviewPath, JSON.stringify(review, null, 2) + '\n');
    const input = await graphProject.reviewedHelperInputs(parent.evidence, reviewPath);
    assert.equal(input.files.length, 6); assert.equal(input.artifactAdmission.originalModelStatus, 'failed');
    assert.equal(input.entry.bytes, 15275); assert.equal(input.entry.sha256, '68ea879680c9641ae00ea6d226561632179b1e0e82b72ae18fae2aa6a8733eee');
    assert.equal(input.receipt.sha256, '2dbf297cfe0e0a3b60c4fe8d7ceae155594cf096150b8a8cb0151ec36041bf03');
    assert.equal(hash(await readFile(retention.originalGeneration.path)), retention.originalGeneration.sha256);
    assert.equal(hash(await readFile(parent.session.path)), parent.session.sha256);
  });
