import { describe, expect, it } from 'bun:test';
import { extractResultArtifacts, recoveryActionLabel, resolveComposerMode, resultDisplayContent } from './workbench-ux';

describe('workbench UX decisions', () => {
  it('uses explicit modes and a narrow transparent Auto heuristic', () => {
    expect(resolveComposerMode('auto', 'Discuss: release risks')).toBe('chat');
    expect(resolveComposerMode('auto', 'talk about the architecture')).toBe('chat');
    expect(resolveComposerMode('auto', 'Write the release notes')).toBe('task');
    expect(resolveComposerMode('task', 'chat: hello')).toBe('task');
  });
  it('extracts only recognizable structured or textual artifacts', () => {
    expect(extractResultArtifacts({ files: [{ path: 'out/report.pdf', type: 'PDF' }, 'data.csv'] })).toEqual([{ name: 'out/report.pdf', detail: 'PDF' }, { name: 'data.csv' }]);
    expect(extractResultArtifacts('Saved `notes.md` and image.png.')).toEqual([{ name: 'notes.md' }, { name: 'image.png' }]);
    expect(extractResultArtifacts('A prose-only answer.')).toEqual([]);
  });
  it('promotes a structured report summary without hiding the full export payload', () => {
    const result = { summary: '# Readiness report', artifacts: ['report.md'] };
    expect(resultDisplayContent(result)).toBe('# Readiness report');
    expect(resultDisplayContent({ arbitrary: true })).toEqual({ arbitrary: true });
  });
  it('exposes only status-matched Retry and Resume recovery controls', () => {
    expect(recoveryActionLabel({runId:'failed',status:'failed',action:'retry_same_run',executable:true,reason:'retryable'})).toBe('Retry run');
    expect(recoveryActionLabel({runId:'interrupted',status:'interrupted',action:'resume_same_run',executable:true,reason:'resumable'})).toBe('Resume run');
    expect(recoveryActionLabel({runId:'continue',status:'failed',action:'continue_new_run',executable:true,reason:'continuable'})).toBe('');
    expect(recoveryActionLabel({runId:'mismatch',status:'failed',action:'resume_same_run',executable:true,reason:'stale plan'})).toBe('');
    expect(recoveryActionLabel({runId:'disabled',status:'failed',action:'retry_same_run',executable:false,reason:'not retryable'})).toBe('');
  });
});
