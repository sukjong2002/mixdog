import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as contextMod from '../runtime/agent/orchestrator/context/collect.mjs';
import { parseSkillDocument } from '../runtime/shared/skill-document.mjs';
import { createSkillsApi } from './skills-api.mjs';
import { countSkillFiles } from '../runtime/agent/orchestrator/runtime-core/plugin-mcp.mjs';

test('skills status reads the registered list and diagnostics from one discovery snapshot', () => {
  const snapshots = [
    { skills: [{ name: 'same-view', description: 'Current skill.', source: 'global' }], issues: [] },
    { skills: [], issues: [{ code: 'invalid-document', filePath: '/later/SKILL.md', message: 'Later edit.' }] },
  ];
  let next = 0;
  const api = createSkillsApi({
    getCwd: () => '/project',
    contextMod: {
      collectSkillCatalogCached: () => snapshots[Math.min(next++, 1)],
      skillEnabledFlags: (skills) => skills.map(() => true),
    },
  });
  const status = api.skillsStatus();
  assert.deepEqual(status.skills.map((skill) => skill.name), ['same-view']);
  assert.deepEqual(status.issues, []);
});

test('plugin skills load by frontmatter name without moving their nested resource directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-compatible-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const pluginRoot = join(root, 'plugin');
    const skillDir = join(pluginRoot, 'skills', 'notion', 'knowledge-capture');
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'guide.md'), '# Reference\n');
    const source = '---\nname: notion-knowledge-capture\ndescription: Capture decisions in Notion.\n---\n\nRead references/guide.md.\n';
    writeFileSync(join(skillDir, 'SKILL.md'), source);
    mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'plugins'), { recursive: true });
    writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'plugins', 'registry.json'), JSON.stringify({
      plugins: [{ id: 'notion-plugin', root: pluginRoot, enabled: true }],
    }));
    contextMod.invalidateSkillsCache();
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    const skill = api.skillsStatus().skills.find((entry) => entry.name === 'notion-knowledge-capture');
    assert.ok(skill);
    assert.deepEqual(skill.owner, { kind: 'plugin', id: 'notion-plugin' });
    assert.equal(skill.whenToUse, '');
    const loaded = api.skillContent('notion-knowledge-capture');
    assert.equal(loaded.dir, skillDir);
    assert.equal(loaded.content, 'Read references/guide.md.');
    assert.equal(readFileSync(join(loaded.dir, 'references', 'guide.md'), 'utf8'), '# Reference\n');
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), source);
  } finally {
    contextMod.invalidateSkillsCache();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin discovery preserves upstream metadata behavior and explains actual exclusions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-diagnostics-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  try {
    const pluginRoot = join(root, 'plugin');
    const writeSkill = (base, folder, name, extra = '', description = 'Reusable instructions.') => {
      const dir = join(base, folder);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'SKILL.md');
      writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${folder}\n`);
      return filePath;
    };
    // Create in the reverse of the required path order.
    writeSkill(join(pluginRoot, 'skills'), 'z-last', 'shared');
    const winner = writeSkill(join(pluginRoot, 'skills'), 'a-first', 'shared');
    writeSkill(join(pluginRoot, 'skills'), 'user-only', 'user-only', 'disable-model-invocation: true\n');
    writeSkill(join(pluginRoot, 'skills'), 'model-only', 'model-only', 'user-invocable: false\n');
    writeSkill(join(pluginRoot, 'skills'), 'forked', 'forked', 'context: fork\n');
    writeSkill(join(pluginRoot, 'skills'), 'hooked', 'hooked', 'hooks: {}\n');
    writeSkill(join(pluginRoot, 'skills'), 'defaults', 'defaults', 'disable-model-invocation: false\nuser-invocable: true\n');
    writeSkill(join(pluginRoot, 'skills'), 'invalid', 'INVALID');
    writeSkill(join(pluginRoot, 'skills'), 'broken', 'broken', '', '[not valid YAML');
    const lowercase = join(pluginRoot, 'skills', 'lower', 'skill.md');
    mkdirSync(join(pluginRoot, 'skills', 'lower'), { recursive: true });
    writeFileSync(lowercase, '---\nname: lower\ndescription: Wrong file name.\n---\n\n# Lower\n');
    writeSkill(join(pluginRoot, 'skills'), 'override', 'owned');
    writeSkill(join(process.env.MIXDOG_DATA_DIR, 'skills'), 'owned', 'owned');
    writeSkill(join(process.env.MIXDOG_DATA_DIR, 'skills'), 'mismatch', 'wrong-global');
    writeSkill(join(process.env.MIXDOG_ROOT, 'defaults', 'skills'), 'mismatch', 'wrong-builtin');
    writeSkill(join(process.env.MIXDOG_ROOT, 'defaults', 'skills'), 'built-in', 'built-in');
    writeSkill(join(pluginRoot, 'skills'), 'override-builtin', 'built-in');
    const disabledRoot = join(root, 'disabled');
    writeSkill(join(disabledRoot, 'skills'), 'hidden', 'disabled-skill');
    // Overlapping roots must not produce a duplicate issue for the same file.
    writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({ skills: './skills/a-first' }));
    mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'plugins'), { recursive: true });
    writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'plugins', 'registry.json'), JSON.stringify({ plugins: [
      { id: 'compatible', root: pluginRoot, enabled: true },
      { id: 'disabled', root: disabledRoot, enabled: false },
    ] }));
    contextMod.invalidateSkillsCache();
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    const status = api.skillsStatus();
    assert.deepEqual(status.skills.map((skill) => skill.name).sort(),
      ['built-in', 'defaults', 'forked', 'hooked', 'model-only', 'owned', 'shared', 'user-only']);
    assert.equal(api.skillContent('shared').filePath, winner);
    assert.equal(api.skillContent('built-in').source, 'plugin');
    assert.equal(api.skillContent('owned').source, 'global');
    const pluginIssues = status.issues.filter((issue) => issue.plugin === 'compatible');
    assert.equal(pluginIssues.length, 5);
    assert.equal(pluginIssues.filter((issue) => issue.code === 'invalid-document').length, 3);
    assert.equal(pluginIssues.filter((issue) => issue.code === 'shadowed').length, 2);
    assert.ok(pluginIssues.every((issue) => issue.filePath && issue.message));
    assert.equal(pluginIssues.find((issue) => issue.filePath === lowercase)?.message, 'File must be named SKILL.md.');
    const registered = status.skills.filter((skill) => skill.owner.id === 'compatible');
    assert.equal(countSkillFiles(pluginRoot), 12, 'overlapping roots count each physical path once');
    assert.equal(countSkillFiles(pluginRoot), registered.length + pluginIssues.length);
    const duplicate = pluginIssues.find((issue) => issue.name === 'shared');
    assert.equal(duplicate.shadowedBy, winner);
    assert.deepEqual(api.skillsStatus().issues, status.issues, 'cached reads preserve diagnostics');
    for (const name of ['user-only', 'model-only', 'forked', 'hooked']) {
      assert.equal(api.skillContent(name).source, 'plugin');
    }
    assert.match(contextMod.buildSkillManifest(contextMod.collectSkillsCached(root)),
      /^- user-only: Reusable instructions\.$/m);
  } finally {
    contextMod.invalidateSkillsCache();
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a write through the skills API is visible to the very next read, with no waiting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-fresh-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const turn = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'skills'), { recursive: true });
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    const describe = (name) => api.skillsStatus().skills.find((skill) => skill.name === name)?.description;
    // Let the watched roots settle, so reads reuse their last walk.
    const settle = async () => {
      api.skillsStatus();
      await turn();
      api.skillsStatus();
      await turn();
    };
    await settle();
    api.addGlobalSkill({ name: 'fresh-skill', description: 'Use when first added.' });
    assert.equal(describe('fresh-skill'), 'Use when first added.');

    await settle();
    api.saveSkillDocument({
      originalName: 'fresh-skill',
      name: 'fresh-skill',
      description: 'Use when saved again.',
      instructions: '# Saved',
    });
    assert.equal(describe('fresh-skill'), 'Use when saved again.');

    // An external write followed by the explicit invalidation that reloadSkills
    // and settings mutations run.
    await settle();
    const filePath = join(process.env.MIXDOG_DATA_DIR, 'skills', 'fresh-skill', 'SKILL.md');
    writeFileSync(
      filePath,
      readFileSync(filePath, 'utf8').replace('Use when saved again.', 'Use when reloaded.')
    );
    api.invalidateSkills();
    assert.equal(describe('fresh-skill'), 'Use when reloaded.');
  } finally {
    contextMod.invalidateSkillsCache(root);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('edits existing skills without dropping optional metadata or sibling resources', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const originalDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'existing-skill');
    mkdirSync(join(originalDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(originalDir, 'SKILL.md'),
      [
        '---',
        'name: existing-skill',
        'description: Use when editing an existing skill.',
        'license: MIT',
        'metadata:',
        '  author: example',
        'allowed-tools:',
        '  - shell',
        '---',
        '',
        '# Original instructions',
        '',
      ].join('\n')
    );
    writeFileSync(join(originalDir, 'scripts', 'check.py'), 'print("ok")\n');

    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    const saved = api.saveSkillDocument({
      originalName: 'existing-skill',
      name: 'renamed-skill',
      description: 'Use when the renamed skill is needed.',
      instructions: '# Updated instructions',
    });
    const renamedDir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'renamed-skill');
    const parsed = parseSkillDocument(readFileSync(saved.filePath, 'utf8'));

    assert.equal(existsSync(originalDir), false);
    assert.equal(saved.filePath, join(renamedDir, 'SKILL.md'));
    assert.equal(existsSync(join(renamedDir, 'scripts', 'check.py')), true);
    assert.equal(parsed.name, 'renamed-skill');
    assert.equal(parsed.description, 'Use when the renamed skill is needed.');
    assert.equal(parsed.body, '# Updated instructions\n');
    assert.equal(parsed.frontmatter.license, 'MIT');
    assert.deepEqual(parsed.frontmatter.metadata, { author: 'example' });
    assert.deepEqual(parsed.frontmatter['allowed-tools'], ['shell']);
    assert.ok(api.skillsStatus().skills.some((skill) => skill.name === 'renamed-skill'));
  } finally {
    contextMod.invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('skillsStatus attributes each skill to the owner that installs and toggles it', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-owner-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  const cwd = join(root, 'project');
  const skill = (dir, name, extra = []) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      ['---', `name: ${name}`, `description: Use ${name}.`, ...extra, '---', '', '# x', ''].join('\n')
    );
  };
  try {
    skill(join(process.env.MIXDOG_DATA_DIR, 'skills', 'mine'), 'mine');
    skill(join(process.env.MIXDOG_ROOT, 'defaults', 'skills', 'pptx'), 'pptx', ['metadata:', '  requires: office']);
    const pluginRoot = join(root, 'plugin-a');
    skill(join(pluginRoot, 'skills', 'from-plugin'), 'from-plugin');
    mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'plugins'), { recursive: true });
    writeFileSync(
      join(process.env.MIXDOG_DATA_DIR, 'plugins', 'registry.json'),
      JSON.stringify({
        plugins: [{ id: 'plugin-a', name: 'Plugin A', root: pluginRoot, enabled: true }],
      })
    );
    contextMod.invalidateSkillsCache(cwd);

    const byName = Object.fromEntries(
      createSkillsApi({ contextMod, getCwd: () => cwd })
        .skillsStatus()
        .skills.map((entry) => [entry.name, entry])
    );
    assert.deepEqual(byName.mine.owner, { kind: 'user' });
    assert.equal(byName.mine.editable, true);
    assert.deepEqual(byName.pptx.owner, { kind: 'builtin', feature: 'office' });
    assert.equal(byName.pptx.editable, false);
    assert.deepEqual(byName['from-plugin'].owner, { kind: 'plugin', id: 'plugin-a' });
    assert.equal(byName['from-plugin'].editable, false);
  } finally {
    contextMod.invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('creates new global skills with all three standard fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-create-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  try {
    const cwd = join(root, 'project');
    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    const created = api.addGlobalSkill({
      name: 'new-skill',
      description: 'Use when creating a standard skill.',
      whenToUse: '"새 스킬", "new skill"; not for editing one.',
      instructions: '# Instructions\n\nDo the work.',
    });
    const parsed = parseSkillDocument(readFileSync(created.filePath, 'utf8'));

    assert.equal(parsed.name, 'new-skill');
    assert.equal(parsed.description, 'Use when creating a standard skill.');
    assert.equal(parsed.whenToUse, '"새 스킬", "new skill"; not for editing one.');
    assert.equal(parsed.body, '# Instructions\n\nDo the work.\n');
    assert.equal(
      api.skillsStatus().skills.find((skill) => skill.name === 'new-skill')?.whenToUse,
      '"새 스킬", "new skill"; not for editing one.'
    );
    assert.equal(created.filePath, join(process.env.MIXDOG_DATA_DIR, 'skills', 'new-skill', 'SKILL.md'));
    assert.throws(
      () =>
        api.addGlobalSkill({
          name: 'Invalid_Name',
          description: 'Use when invalid.',
          instructions: '# Instructions',
        }),
      /lowercase letters/
    );
  } finally {
    contextMod.invalidateSkillsCache(join(root, 'project'));
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool-link edits preserve imported source bytes, survive renames, and can be cleared or restored', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-skill-links-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  const cwd = join(root, 'project');
  const dir = join(process.env.MIXDOG_DATA_DIR, 'skills', 'imported-guide');
  mkdirSync(join(dir, 'agents'), { recursive: true });
  const source =
    '---\n# preserve formatting\nname: imported-guide\ndescription: Original guide.\nallowed-tools: shell\n---\n\n# Instructions\n';
  writeFileSync(join(dir, 'SKILL.md'), source);
  const metadata = 'dependencies:\n  tools:\n    - type: mcp\n      value: design-server\n';
  writeFileSync(join(dir, 'agents', 'openai.yaml'), metadata);
  try {
    contextMod.invalidateSkillsCache(cwd);
    const api = createSkillsApi({ contextMod, getCwd: () => cwd });
    api.saveSkillDocument({
      originalName: 'imported-guide',
      dependenciesOnly: true,
      toolDependencies: [{ type: 'tool', value: 'office' }],
    });
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), source);
    assert.equal(readFileSync(join(dir, 'agents', 'openai.yaml'), 'utf8'), metadata);
    assert.deepEqual(api.skillContent('imported-guide').toolDependencies, [{ type: 'tool', value: 'office' }]);
    api.saveSkillDocument({
      originalName: 'imported-guide',
      name: 'renamed-guide',
      description: 'Original guide.',
      instructions: '# Instructions',
    });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, [{ type: 'tool', value: 'office' }]);
    api.saveSkillDocument({ originalName: 'renamed-guide', dependenciesOnly: true, toolDependencies: [] });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, []);
    api.saveSkillDocument({ originalName: 'renamed-guide', dependenciesOnly: true, toolDependencies: null });
    assert.deepEqual(api.skillContent('renamed-guide').toolDependencies, [{ type: 'mcp', value: 'design-server' }]);
  } finally {
    contextMod.invalidateSkillsCache(cwd);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only packaged skills permit local dependency edits but not source edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-builtin-links-edit-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const previousRoot = process.env.MIXDOG_ROOT;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  process.env.MIXDOG_ROOT = join(root, 'package');
  const dir = join(process.env.MIXDOG_ROOT, 'defaults', 'skills', 'packaged-guide');
  mkdirSync(dir, { recursive: true });
  const source = '---\nname: packaged-guide\ndescription: Packaged guide.\n---\n\n# Instructions\n';
  writeFileSync(join(dir, 'SKILL.md'), source);
  try {
    contextMod.invalidateSkillsCache(root);
    const api = createSkillsApi({ contextMod, getCwd: () => root });
    api.saveSkillDocument({
      originalName: 'packaged-guide',
      dependenciesOnly: true,
      toolDependencies: [{ type: 'tool', value: 'office' }],
    });
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), source);
    assert.equal(
      api.skillsStatus().skills.find((entry) => entry.name === 'packaged-guide').dependencySource,
      'override'
    );
    assert.throws(
      () =>
        api.saveSkillDocument({
          originalName: 'packaged-guide',
          name: 'packaged-guide',
          description: 'Changed source',
          instructions: 'New body',
        }),
      /read-only/
    );
  } finally {
    contextMod.invalidateSkillsCache(root);
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    if (previousRoot === undefined) delete process.env.MIXDOG_ROOT;
    else process.env.MIXDOG_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
});
