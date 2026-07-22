import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import {
  detectSkillPluginCandidate,
  dismissSkillPluginCandidate,
  generateSkillPluginDraft,
  insertSkillPluginCandidate,
  listSkillPluginCandidates,
  sanitizeLocalContext,
} from '../src/plugins/skill-candidates.js';
import {
  detectSkillPluginCandidateOnRunSuccess,
  upsertSkillPluginCandidateAssistantMessage,
} from '../src/plugins/share-helpers.js';

let tmpDir: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-skill-plugin-candidates-'));
  projectRoot = path.join(tmpDir, 'project');
  await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  closeDatabase();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('skill plugin candidates', () => {
  it('detects an explicit SKILL.md and generates a valid draft', async () => {
    await writeFile(
      path.join(projectRoot, 'SKILL.md'),
      [
        '# Research brief skill',
        '',
        'Use this skill when a reusable research workflow should collect sources, compare claims, and produce a concise brief.',
        '',
        '## Workflow',
        '',
        '- Read the supplied source material.',
        '- Extract durable steps.',
        '- Return a structured brief.',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    insertProject(db, {
      id: 'proj_1',
      name: 'Candidate project',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    });

    const detected = await detectSkillPluginCandidate({
      projectId: 'proj_1',
      runId: 'run_1',
      conversationId: 'conv_1',
      message: 'Please use @SKILL.md for this run.',
      projectRoot,
      now: 10,
    });
    expect(detected?.title).toBe('Research brief skill');

    const candidate = insertSkillPluginCandidate(db, detected!);
    expect(candidate?.sourceRefs[0]?.value).toBe('SKILL.md');
    expect(listSkillPluginCandidates(db, 'proj_1')).toHaveLength(1);

    const result = await generateSkillPluginDraft(db, projectRoot, 'proj_1', candidate!.id, 20);
    expect(result?.ok).toBe(true);
    expect(result?.draftPath).toMatch(/^plugin-source\/research-brief-skill-/);
    const manifest = JSON.parse(await readFile(path.join(result!.folder, 'open-design.json'), 'utf8'));
    expect(manifest.od.kind).toBe('skill');
    await expect(readFile(path.join(result!.folder, 'references', 'provenance.json'), 'utf8'))
      .resolves.toContain(candidate!.id);
  });

  it('does not detect generic prompt heading blocks', async () => {
    const detected = await detectSkillPluginCandidate({
      projectId: 'proj_1',
      message: [
        '## Instructions',
        'Follow these steps.',
        '## Workflow',
        'Make a page.',
        '## Constraints',
        'Keep it simple.',
      ].join('\n'),
      projectRoot,
    });
    expect(detected).toBeNull();
  });

  it('only detects GitHub URLs that point at explicit skill artifacts', async () => {
    await expect(detectSkillPluginCandidate({
      projectId: 'proj_1',
      message: 'Look at https://github.com/foo/bar for context.',
      projectRoot,
    })).resolves.toBeNull();

    await expect(detectSkillPluginCandidate({
      projectId: 'proj_1',
      message: 'The implementation is discussed at https://github.com/foo/bar/pull/123.',
      projectRoot,
    })).resolves.toBeNull();

    const detected = await detectSkillPluginCandidate({
      projectId: 'proj_1',
      message: 'Use https://github.com/foo/bar/blob/main/SKILL.md for this run.',
      projectRoot,
    });
    expect(detected?.sourceRefs[0]?.value).toBe('https://github.com/foo/bar/blob/main/SKILL.md');
  });

  it('dismisses only the matching project candidate', async () => {
    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    for (const id of ['proj_1', 'proj_2']) {
      insertProject(db, {
        id,
        name: id,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'prototype' },
        createdAt: 1,
        updatedAt: 1,
      });
    }
    const base = {
      runId: null,
      conversationId: null,
      assistantMessageId: null,
      title: 'Reusable Skill',
      description: 'A reusable skill.',
      confidence: 0.9,
      sourceRefs: [{ kind: 'url' as const, value: 'https://github.com/acme/skill' }],
      provenance: { summary: 'test', detectedAt: 1 },
      draftPath: null,
    };
    const a = insertSkillPluginCandidate(db, { ...base, projectId: 'proj_1', fingerprint: 'a' })!;
    insertSkillPluginCandidate(db, { ...base, projectId: 'proj_2', fingerprint: 'b' });

    dismissSkillPluginCandidate(db, 'proj_1', a.id, 30);

    expect(listSkillPluginCandidates(db, 'proj_1')).toHaveLength(0);
    expect(listSkillPluginCandidates(db, 'proj_2')).toHaveLength(1);
    expect(listSkillPluginCandidates(db, 'proj_1', true)[0]?.status).toBe('dismissed');
  });

  it('does not dismiss or expose a candidate from another project', () => {
    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    for (const id of ['proj_1', 'proj_2']) {
      insertProject(db, {
        id,
        name: id,
        skillId: null,
        designSystemId: null,
        pendingPrompt: null,
        metadata: { kind: 'prototype' },
        createdAt: 1,
        updatedAt: 1,
      });
    }
    insertConversation(db, {
      id: 'conv_1',
      projectId: 'proj_1',
      title: 'Candidate conversation',
      createdAt: 1,
      updatedAt: 1,
    });
    upsertMessage(db, 'conv_1', {
      id: 'assistant_card_1',
      role: 'assistant',
      content: 'plugin candidate',
      createdAt: 1,
      endedAt: 1,
    });
    const candidate = insertSkillPluginCandidate(db, {
      projectId: 'proj_1',
      runId: null,
      conversationId: 'conv_1',
      assistantMessageId: 'assistant_card_1',
      title: 'Reusable Skill',
      description: 'A reusable skill.',
      confidence: 0.9,
      sourceRefs: [{ kind: 'file', value: 'SKILL.md' }],
      provenance: { summary: 'test', detectedAt: 1 },
      fingerprint: 'fingerprint_1',
      draftPath: null,
    })!;

    const dismissed = dismissSkillPluginCandidate(db, 'proj_2', candidate.id, 30);

    expect(dismissed).toBeNull();
    expect(listSkillPluginCandidates(db, 'proj_1')).toHaveLength(1);
    expect(listSkillPluginCandidates(db, 'proj_1', true)[0]?.status).toBe('active');
    expect(listMessages(db, 'conv_1').map((message) => message.id)).toContain('assistant_card_1');
  });

  it('reuses and reanchors an existing candidate assistant message', () => {
    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    insertProject(db, {
      id: 'proj_1',
      name: 'Candidate project',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    });
    insertConversation(db, {
      id: 'conv_1',
      projectId: 'proj_1',
      title: 'Candidate conversation',
      createdAt: 1,
      updatedAt: 1,
    });
    upsertMessage(db, 'conv_1', {
      id: 'assistant_1',
      role: 'assistant',
      content: 'first run',
      createdAt: 1,
      endedAt: 1,
    });

    const candidate = insertSkillPluginCandidate(db, {
      projectId: 'proj_1',
      runId: 'run_1',
      conversationId: 'conv_1',
      assistantMessageId: null,
      title: 'Reusable Skill',
      description: 'A reusable skill.',
      confidence: 0.9,
      sourceRefs: [{ kind: 'file', value: 'SKILL.md' }],
      provenance: { summary: 'test', detectedAt: 1 },
      fingerprint: 'fingerprint_1',
      draftPath: null,
    })!;

    const firstCardId = upsertSkillPluginCandidateAssistantMessage(db, {
      id: 'run_1',
      conversationId: 'conv_1',
      assistantMessageId: 'assistant_1',
      agentId: 'agent_1',
    }, candidate);
    upsertMessage(db, 'conv_1', {
      id: 'assistant_2',
      role: 'assistant',
      content: 'second run',
      createdAt: 2,
      endedAt: 2,
    });

    const reloadedCandidate = listSkillPluginCandidates(db, 'proj_1')[0]!;
    const secondCardId = upsertSkillPluginCandidateAssistantMessage(db, {
      id: 'run_2',
      conversationId: 'conv_1',
      assistantMessageId: 'assistant_2',
      agentId: 'agent_1',
    }, reloadedCandidate);

    expect(secondCardId).toBe(firstCardId);
    expect(listMessages(db, 'conv_1').filter((message) =>
      message.events?.some((event: { kind?: string }) => event.kind === 'plugin_candidate'),
    )).toHaveLength(1);
    expect(listSkillPluginCandidates(db, 'proj_1')[0]?.assistantMessageId).toBe(firstCardId);
    expect(listMessages(db, 'conv_1').map((message) => message.id)).toEqual([
      'assistant_1',
      'assistant_2',
      firstCardId,
    ]);
  });

  it('scrubs local context from the synthesized draft but keeps reference sources verbatim', async () => {
    await writeFile(
      path.join(projectRoot, 'SKILL.md'),
      [
        '# Path leak skill',
        '',
        'Use this skill with the notes kept in C:\\Users\\alice\\AppData\\Roaming\\od\\notes.md when the workflow repeats.',
        '',
        '## Workflow',
        '',
        '- Read /Users/alice/Library/refs.md and \\\\fileserver\\share\\brief.md first.',
        '- Send open questions to alice@example.com.',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    insertProject(db, {
      id: 'proj_1',
      name: 'Candidate project',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    });

    const detected = await detectSkillPluginCandidate({
      projectId: 'proj_1',
      runId: 'run_1',
      conversationId: 'conv_1',
      message: 'Please use @SKILL.md for this run.',
      projectRoot,
      now: 10,
    });
    const candidate = insertSkillPluginCandidate(db, detected!);

    const result = await generateSkillPluginDraft(db, projectRoot, 'proj_1', candidate!.id, 20);
    expect(result?.ok).toBe(true);

    const skill = await readFile(path.join(result!.folder, 'SKILL.md'), 'utf8');
    expect(skill).not.toContain('C:\\Users');
    expect(skill).not.toContain('/Users/alice');
    expect(skill).not.toContain('\\\\fileserver');
    expect(skill).toContain('<local-path>');

    const manifest = JSON.parse(await readFile(path.join(result!.folder, 'open-design.json'), 'utf8'));
    expect(manifest.description).toContain('<local-path>');
    expect(manifest.description).not.toContain('C:\\Users');

    const reference = await readFile(path.join(result!.folder, 'references', 'source-1-SKILL.md'), 'utf8');
    expect(reference).toContain('C:\\Users\\alice\\AppData\\Roaming\\od\\notes.md');
    expect(reference).toContain('/Users/alice/Library/refs.md');
    expect(reference).toContain('alice@example.com');

    const warning = result!.validation.diagnostics.find((d) => d.code === 'references.local-context');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('references/source-1-SKILL.md');
    expect(warning?.message).toMatch(/review/iu);
  });

  it('does not warn about references without local context', async () => {
    await writeFile(
      path.join(projectRoot, 'SKILL.md'),
      [
        '# Clean skill',
        '',
        'Use this skill when a reusable research workflow should collect sources and produce a concise brief.',
        '',
        '## Workflow',
        '',
        '- Read the supplied source material.',
        '- Return a structured brief.',
        '',
      ].join('\n'),
      'utf8',
    );

    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    insertProject(db, {
      id: 'proj_1',
      name: 'Candidate project',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    });

    const detected = await detectSkillPluginCandidate({
      projectId: 'proj_1',
      message: 'Please use @SKILL.md for this run.',
      projectRoot,
      now: 10,
    });
    const candidate = insertSkillPluginCandidate(db, detected!);

    const result = await generateSkillPluginDraft(db, projectRoot, 'proj_1', candidate!.id, 20);
    expect(result?.ok).toBe(true);
    expect(result!.validation.diagnostics.filter((d) => d.code === 'references.local-context')).toHaveLength(0);
  });

  it('defers the CTA when the matching run only asks a question form', async () => {
    const db = openDatabase(tmpDir, { dataDir: path.join(tmpDir, 'data') });
    insertProject(db, {
      id: 'proj_1',
      name: 'Candidate project',
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype' },
      createdAt: 1,
      updatedAt: 1,
    });
    insertConversation(db, {
      id: 'conv_1',
      projectId: 'proj_1',
      title: 'Candidate conversation',
      createdAt: 1,
      updatedAt: 1,
    });
    upsertMessage(db, 'conv_1', {
      id: 'assistant_question',
      role: 'assistant',
      content: [
        'I need one detail first.',
        '<question-form id="task-type" title="Choose task type">',
        '{"questions":[{"id":"kind","type":"single-choice","label":"What?","options":["Slide deck"]}]}',
        '</question-form>',
      ].join('\n'),
      createdAt: 1,
      endedAt: 1,
    });

    const runs = { wait: async () => ({ status: 'succeeded' }) };
    detectSkillPluginCandidateOnRunSuccess(db, runs, {
      id: 'run_question',
      projectId: 'proj_1',
      conversationId: 'conv_1',
      assistantMessageId: 'assistant_question',
      agentId: 'agent_1',
    }, {
      message: 'Use https://github.com/foo/bar/blob/main/SKILL.md for this run.',
    }, projectRoot);
    await flushSkillCandidateHook();

    const deferred = listSkillPluginCandidates(db, 'proj_1')[0];
    expect(deferred?.assistantMessageId).toBeNull();
    expect(listMessages(db, 'conv_1').map((message) => message.id)).toEqual(['assistant_question']);

    upsertMessage(db, 'conv_1', {
      id: 'assistant_final',
      role: 'assistant',
      content: 'Done. Created the deck.',
      createdAt: 2,
      endedAt: 2,
    });
    detectSkillPluginCandidateOnRunSuccess(db, runs, {
      id: 'run_final',
      projectId: 'proj_1',
      conversationId: 'conv_1',
      assistantMessageId: 'assistant_final',
      agentId: 'agent_1',
    }, {
      message: '[form answers -- task-type]\n- What?: Slide deck',
    }, projectRoot);
    await flushSkillCandidateHook();

    const shown = listSkillPluginCandidates(db, 'proj_1')[0];
    expect(shown?.assistantMessageId).toBeTruthy();
    expect(listMessages(db, 'conv_1').map((message) => message.id)).toEqual([
      'assistant_question',
      'assistant_final',
      shown?.assistantMessageId,
    ]);
  });
});

describe('sanitizeLocalContext', () => {
  it('replaces Windows drive-letter paths with both separators', () => {
    expect(sanitizeLocalContext('Data lives in C:\\Users\\alice\\AppData\\Roaming\\od and D:/work/repo today.'))
      .toBe('Data lives in <local-path> and <local-path> today.');
  });

  it('replaces UNC paths', () => {
    expect(sanitizeLocalContext('Shared brief at \\\\fileserver\\design\\brief.md for review.'))
      .toBe('Shared brief at <local-path> for review.');
  });

  it('replaces POSIX user directories', () => {
    expect(sanitizeLocalContext('Logs in /Users/alice/Library/Logs and config in /home/bob/.config/tool.'))
      .toBe('Logs in <local-path> and config in <local-path>.');
  });

  it('keeps non-path words, URLs, and relative paths intact', () => {
    const text = 'See https://github.com/foo/bar/blob/main/SKILL.md, the references/ folder, a 16:9 ratio, and the C: drive.';
    expect(sanitizeLocalContext(text)).toBe(text);
  });

  it('keeps sentence punctuation after a scrubbed path', () => {
    expect(sanitizeLocalContext('Copy C:\\Users\\alice\\notes.md. Then continue.'))
      .toBe('Copy <local-path>. Then continue.');
  });
});

async function flushSkillCandidateHook() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
