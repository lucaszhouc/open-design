// External-write detection for design-delivery finalization.
//
// A design run that mutated files only outside the project root used to end
// with the generic "finished without producing a deliverable project file"
// error even though its writes succeeded (and were listed in the turn's file
// summary). These tests cover the conservative external-path counter and the
// external_only finalization path, which keeps the persisted delivery state
// at no_result while surfacing an accurate detail message.
import { describe, expect, it } from 'vitest';
import {
  applyDesignDeliveryOutcome,
  countExternalMutationPaths,
  designDeliveryFailureDetail,
} from '../../src/components/ProjectView';
import type { ChatMessage } from '../../src/types';

const ROOT = 'C:/work/site';

const writeEvent = (id: string, filePath: string) => ({
  kind: 'tool_use' as const,
  id,
  name: 'Write',
  input: { file_path: filePath },
});

describe('countExternalMutationPaths', () => {
  it('counts an absolute write that provably lands outside the project root', () => {
    expect(
      countExternalMutationPaths(
        [writeEvent('w-1', 'C:\\Users\\alice\\Desktop\\notes.md')],
        undefined,
        ROOT,
      ),
    ).toBe(1);
  });

  it('does not count a write inside the project root', () => {
    expect(
      countExternalMutationPaths([writeEvent('w-1', 'C:/work/site/index.html')], undefined, ROOT),
    ).toBe(0);
  });

  it('does not count a relative-path edit', () => {
    expect(
      countExternalMutationPaths(
        [{ kind: 'tool_use' as const, id: 'e-1', name: 'Edit', input: { file_path: 'index.html' } }],
        undefined,
        ROOT,
      ),
    ).toBe(0);
  });

  it('counts a simple Bash rm of an external file', () => {
    expect(
      countExternalMutationPaths(
        [{ kind: 'tool_use' as const, id: 'b-1', name: 'Bash', input: { command: 'rm C:/tmp/stale.html' } }],
        undefined,
        ROOT,
      ),
    ).toBe(1);
  });

  it('trusts a managed-project alias path regardless of the resolved root', () => {
    expect(
      countExternalMutationPaths(
        [writeEvent('w-1', '/data/projects/proj-1/page.html')],
        'proj-1',
        ROOT,
      ),
    ).toBe(0);
  });

  it('stays conservative when no project root is known', () => {
    expect(
      countExternalMutationPaths(
        [writeEvent('w-1', 'C:\\Users\\alice\\Desktop\\notes.md')],
        undefined,
        null,
      ),
    ).toBe(0);
  });

  it('counts a `..` escape that lexically resolves outside the root', () => {
    expect(
      countExternalMutationPaths([writeEvent('w-1', 'C:/work/site/../escape.md')], undefined, ROOT),
    ).toBe(1);
  });

  it('ignores reads of external paths', () => {
    expect(
      countExternalMutationPaths(
        [
          {
            kind: 'tool_use' as const,
            id: 'r-1',
            name: 'Read',
            input: { file_path: 'C:/Users/alice/Desktop/notes.md' },
          },
        ],
        undefined,
        ROOT,
      ),
    ).toBe(0);
  });
});

describe('applyDesignDeliveryOutcome — external_only finalization', () => {
  it('persists external_only as no_result with the external-only detail', () => {
    const message: ChatMessage = {
      id: 'm-1',
      role: 'assistant',
      content: 'I saved the files to your desktop.',
      events: [],
    };
    const finalized = applyDesignDeliveryOutcome(message, 'external_only');
    expect(finalized.resultDeliveryState).toBe('no_result');
    expect(finalized.resumable).toBe(false);
    const last = finalized.events?.[finalized.events.length - 1];
    expect(last).toMatchObject({
      kind: 'status',
      label: 'error',
      detail:
        'The run wrote files only outside the project folder, so nothing was delivered to the project. Design runs track results as project files - use Chat mode for tasks that are not meant to produce one.',
    });
  });
});

describe('designDeliveryFailureDetail', () => {
  it('prefers the persistence error for delivery_failed', () => {
    expect(designDeliveryFailureDetail('delivery_failed', 'disk full')).toBe('disk full');
    expect(designDeliveryFailureDetail('delivery_failed')).toBe(
      'The design result was generated, but Open Design could not save it to the project.',
    );
  });

  it('returns the external-only detail for external_only', () => {
    expect(designDeliveryFailureDetail('external_only')).toBe(
      'The run wrote files only outside the project folder, so nothing was delivered to the project. Design runs track results as project files - use Chat mode for tasks that are not meant to produce one.',
    );
  });

  it('falls back to the missing-deliverable detail otherwise', () => {
    expect(designDeliveryFailureDetail('no_result')).toBe(
      'The design run finished without producing a deliverable project file.',
    );
  });
});
