import { describe, expect, it } from 'bun:test';
import { extractResultArtifacts, historyResultArtifacts, recoveryActionLabel, resolveComposerMode, resolveResultArtifactPaths, resultDisplayContent } from './workbench-ux';

describe('workbench UX decisions', () => {
  it('uses explicit modes and a narrow transparent Auto heuristic', () => {
    expect(resolveComposerMode('auto', 'Discuss: release risks')).toBe('chat');
    expect(resolveComposerMode('auto', 'talk about the architecture')).toBe('chat');
    expect(resolveComposerMode('auto', 'Write the release notes')).toBe('task');
    expect(resolveComposerMode('task', 'chat: hello')).toBe('task');
  });
  it('extracts only recognizable structured or textual artifacts', () => {
    expect(extractResultArtifacts({ files: [{ path: 'out/report.pdf', type: 'PDF' }, 'data.csv'] })).toEqual([{ path: 'out/report.pdf', detail: 'PDF' }, { path: 'data.csv' }]);
    expect(extractResultArtifacts('Saved `notes.md`, image.png, and demo.webm.')).toEqual([{ path: 'notes.md' }, { path: 'image.png' }, { path: 'demo.webm' }]);
    expect(extractResultArtifacts('A prose-only answer.')).toEqual([]);
  });
  it('promotes a structured report summary without hiding the full export payload', () => {
    const result = { summary: '# Readiness report', artifacts: ['report.md'] };
    expect(resultDisplayContent(result)).toBe('# Readiness report');
    expect(resultDisplayContent({ arbitrary: true })).toEqual({ arbitrary: true });
  });
  it('resolves artifact references to unique full workspace paths', () => {
    const workspace = [{ path: '/workspace/output/report.md' }, { path: '/workspace/plots/chart.png' }];
    expect(resolveResultArtifactPaths([{ path: 'report.md' }, { path: 'plots/chart.png' }], workspace)).toEqual([
      { path: '/workspace/output/report.md' },
      { path: '/workspace/plots/chart.png' },
    ]);
    expect(resolveResultArtifactPaths([{ path: 'report.md' }], [...workspace, { path: '/workspace/archive/report.md' }])).toEqual([{ path: 'report.md' }]);
  });
  it('collects and deduplicates artifacts from only the supplied history results', () => {
    const workspace = [{ path: '/workspace/one/report.html' }, { path: '/workspace/two/chart.png' }];
    expect(historyResultArtifacts([
      { artifacts: ['one/report.html', 'two/chart.png'] },
      'Updated `two/chart.png`.',
    ], workspace)).toEqual([
      { path: '/workspace/one/report.html' },
      { path: '/workspace/two/chart.png' },
    ]);
  });
  it('finds an existing artifact referenced by a persisted run envelope or trace result', () => {
    const workspace = [{ path: '/Users/example/work/news.html' }];
    expect(historyResultArtifacts([
      { status: 'success', output: 'Created `news.html` at `/Users/example/work/news.html`.' },
      'The bulletin is ready at /Users/example/work/news.html.',
    ], workspace)).toEqual([{ path: '/Users/example/work/news.html' }]);
  });
  it('exposes one status-matched Recover control', () => {
    expect(recoveryActionLabel({runId:'failed',status:'failed',action:'retry_same_run',executable:true,reason:'retryable'})).toBe('Recover run');
    expect(recoveryActionLabel({runId:'interrupted',status:'interrupted',action:'resume_same_run',executable:true,reason:'resumable'})).toBe('Recover run');
    expect(recoveryActionLabel({runId:'continue',status:'failed',action:'continue_new_run',executable:true,reason:'continuable'})).toBe('');
    expect(recoveryActionLabel({runId:'mismatch',status:'failed',action:'resume_same_run',executable:true,reason:'stale plan'})).toBe('');
    expect(recoveryActionLabel({runId:'disabled',status:'failed',action:'retry_same_run',executable:false,reason:'not retryable'})).toBe('');
  });
});
