import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyRepo,
  issueFromFactorySession,
  issueFromPath,
  knownRepos,
  normalizeRepo,
  renameRepo,
  workspaceFor,
  type RepoInput,
} from './repo.ts'

describe('normalizeRepo', () => {
  test('takes the directory under SourceRoot whatever the home dir', () => {
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/argo/x/y')).toBe('argo')
    expect(normalizeRepo('/Users/johannes.krumm/SourceRoot/shutterflow')).toBe('shutterflow')
    expect(normalizeRepo('/home/ops/SourceRoot/vps/')).toBe('vps')
  })

  test('worktree paths fold into their repo', () => {
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/argo/.claude/worktrees/basalt-1150')).toBe(
      'argo',
    )
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/basalt-ui/.claude/maturation')).toBe('basalt-ui')
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/warden-w6')).toBe('warden')
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/basalt-ui-obsidian-w2')).toBe(
      'basalt-ui-obsidian',
    )
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/linewatch-w11-trial')).toBe('linewatch')
    expect(normalizeRepo('/Users/johannes.krumm/SourceRoot/shutterflow-wt/p3-05')).toBe(
      'shutterflow',
    )
  })

  test('siblings that only look similar keep their own slug', () => {
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/basalt-ui-obsidian')).toBe('basalt-ui-obsidian')
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/linewatch-basalt-2')).toBe('linewatch-basalt-2')
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/sy-serendipity-codex')).toBe(
      'sy-serendipity-codex',
    )
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/ShutterflowOps')).toBe('ShutterflowOps')
  })

  test('IuRoot is a separate namespace', () => {
    expect(normalizeRepo('/Users/jkrumm/IuRoot/prometheus-epx/chat/ui')).toBe('iu/prometheus-epx')
    expect(normalizeRepo('/Users/jkrumm/IuRoot/epos.student-enrolment')).toBe(
      'iu/epos.student-enrolment',
    )
    expect(normalizeRepo('/Users/jkrumm/IuRoot/worktrees/se-loa')).toBe(
      'iu/epos-studentenrolment-backend',
    )
    expect(normalizeRepo('/Users/jkrumm/IuRoot/worktrees/split-w2')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm/IuRoot/worktrees')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm/IuRoot/.wt/x')).toBeNull()
  })

  test('bare roots, scratch directories, non-paths and empties are null', () => {
    expect(normalizeRepo('/Users/jkrumm/SourceRoot')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm/IuRoot')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/.hermes-wt/rh-fix')).toBeNull()
    expect(normalizeRepo('/Users/jkrumm')).toBeNull()
    expect(normalizeRepo('/private/tmp/wt-1511')).toBeNull()
    expect(normalizeRepo('athena-teamchat')).toBeNull()
    expect(normalizeRepo('')).toBeNull()
    expect(normalizeRepo(null)).toBeNull()
  })

  test('SourceRoot/worktrees/<repo> is the repo', () => {
    expect(
      normalizeRepo('/Users/jkrumm/SourceRoot/worktrees/free-planning-poker/factory-141-1'),
    ).toBe('free-planning-poker')
    expect(normalizeRepo('/Users/jkrumm/SourceRoot/worktrees')).toBeNull()
  })

  test('IuRoot/worktrees/<name> goes through the prefix table', () => {
    const wt = (n: string) => normalizeRepo(`/Users/jkrumm/IuRoot/worktrees/${n}/x`)
    for (const n of [
      'se-ep-1',
      'student-enrolment-x',
      'EP-17678-a',
      'EP-18347-shell-cleanup',
      'EP-18347-ownership-anchor',
    ])
      expect(wt(n)).toBe('iu/epos-studentenrolment-backend')
    for (const n of ['tool-b', 'ps-1', 'prom-x', 'prometheus-dashboard'])
      expect(wt(n)).toBe('iu/epos-tool-athena')
    expect(wt('teamchat-runtime-gh')).toBe('iu/epos-ai-teamchat-athena')
    expect(wt('otf-a')).toBe('iu/epos-otf-workspaces')
    expect(wt('dam-monitoring-prod')).toBe('iu/epos-dam-backend')
    expect(wt('import-dashboard-runtime')).toBe('iu/epos-import-dashboard-athena')
    expect(wt('epos.student-enrolment')).toBe('iu/epos.student-enrolment')
    expect(wt('EP-18347-other')).toBeNull()
    expect(wt('unknown-thing')).toBeNull()
  })
})

describe('renameRepo', () => {
  test.each([
    ['iu/prometheus-epx', 'iu/epos-ai-teamchat-athena'],
    ['iu/prometheus-scripts', 'iu/epos-tool-athena'],
    ['iu/epos.student-enrolment', 'iu/epos-studentenrolment-backend'],
    ['iu/se-wt-loa-credits', 'iu/epos-studentenrolment-backend'],
    ['iu/epos.dam', 'iu/epos-dam-backend'],
    ['iu/prometheus-feuer-agent', 'iu/prometheus-feuer-agent'],
    ['ShutterflowOps', 'shutterflow'],
    ['factory-gate-a', 'software-factory'],
    ['factory-gameday3', 'software-factory'],
    ['factory-scratch-x', 'software-factory'],
    ['factory-w3-proof-1', 'software-factory'],
    ['sy-serendipity-codex', 'sy-serendipity'],
    ['linewatch-basalt-2', 'linewatch'],
    ['bun-email-api-v2', 'bun-email-api'],
    ['basalt-expr-trial-v1', 'basalt-ui'],
    ['basalt-dx-trial', 'basalt-ui'],
    ['basalt-ui-obsidian-trial', 'basalt-ui'],
    ['basalt-ui-playground', 'basalt-ui'],
    ['basalt-ui-plan-tune', 'basalt-ui'],
    ['basalt-ui-obsidian', 'basalt-ui-obsidian'],
    ['king-smith-mac', 'king-smith-walkingpad-mac'],
    ['free-planning-poker-x', 'free-planning-poker'],
    ['fan-scratch', 'fan-scratch'],
    ['dispatch-scratch', 'dispatch-scratch'],
    ['photo-flow', 'photo-flow'],
  ])('%s -> %s', (from, to) => {
    expect(renameRepo(from)).toBe(to)
  })
})

describe('classifyRepo', () => {
  const known = new Set([
    'argo',
    'iris',
    'dotfiles',
    'photo-flow',
    'agent-workflows',
    'hermes-agent',
  ])
  const H = '/Users/jkrumm'
  const TEAMCHAT = 'iu/epos-ai-teamchat-athena'
  const cases: Array<[string, RepoInput, string | null]> = [
    // a: paths
    ['source path', { project: `${H}/SourceRoot/argo/apps/api` }, 'argo'],
    [
      'iu path renamed',
      { project: `${H}/IuRoot/prometheus-scripts/analysis` },
      'iu/epos-tool-athena',
    ],
    [
      'iu path kept',
      { project: `${H}/IuRoot/prometheus-feuer-agent` },
      'iu/prometheus-feuer-agent',
    ],
    ['private fold', { project: `${H}/SourceRoot/ShutterflowOps` }, 'shutterflow'],
    [
      'source worktree',
      { project: `${H}/SourceRoot/worktrees/free-planning-poker/factory-141-1` },
      'free-planning-poker',
    ],
    ['iu worktree', { project: `${H}/IuRoot/worktrees/tool-b` }, 'iu/epos-tool-athena'],
    ['iu split worktree', { project: `${H}/IuRoot/worktrees/split-w1` }, null],
    ['hermes checkout', { project: `${H}/.hermes/hermes-agent/gateway` }, 'hermes-agent'],
    ['wip folder', { project: `${H}/IuRoot/prometheus-scripts/wip/athena-context-poc` }, TEAMCHAT],
    [
      'wip folder 2',
      { project: `${H}/IuRoot/prometheus-scripts/wip/waves-2026-10-22-teamchat` },
      TEAMCHAT,
    ],
    ['home dir', { project: H }, null],
    ['tmp path', { project: '/private/tmp/x' }, null],
    // b: bare slugs
    ['work slug', { project: 'epos-tool-athena', workspace: 'work' }, 'iu/epos-tool-athena'],
    ['work token is no IU repo', { project: 'some-channel', workspace: 'work' }, null],
    ['work slug renamed', { project: 'prometheus-epx', workspace: 'work' }, TEAMCHAT],
    ['dotted work slug', { project: 'epos.dam', workspace: 'work' }, 'iu/epos-dam-backend'],
    ['iu slug without workspace', { project: 'epos-otf-workspaces' }, 'iu/epos-otf-workspaces'],
    ['known private slug', { project: 'argo', workspace: 'private' }, 'argo'],
    ['unknown private slug', { project: 'nowhere', workspace: 'private' }, null],
    ['claude-code token', { project: 'claude-code', workspace: 'private' }, null],
    ['cli token', { project: 'cli' }, null],
    ['eval token', { project: 'eval' }, 'agent-workflows'],
    ['host token', { project: 'host' }, 'agent-workflows'],
    ['hermes token', { project: 'hermes' }, 'hermes-agent'],
    ['poc token', { project: 'athena-context-poc', workspace: 'work' }, TEAMCHAT],
    ['waves token', { project: 'waves-2026-10-22-teamchat', workspace: 'work' }, TEAMCHAT],
    ['retired slug', { project: 'photo-flow', workspace: 'private' }, 'photo-flow'],
    // evidence sits between b and c
    ['evidence', { source: 'agent-gateway-iu', evidence: 'dotfiles' }, 'dotfiles'],
    ['project beats evidence', { project: 'argo', evidence: 'dotfiles' }, 'argo'],
    ['evidence is renamed', { evidence: 'iu/prometheus-epx' }, TEAMCHAT],
    // c: source owner
    ['hermes', { source: 'hermes' }, 'hermes-agent'],
    ['athena-teamchat', { source: 'athena-teamchat' }, TEAMCHAT],
    ['research-gateway', { source: 'research-gateway' }, 'research-gateway'],
    ['audio-gateway', { source: 'audio-gateway' }, 'audio-gateway'],
    ['image-gateway', { source: 'image-gateway' }, 'image-gateway'],
    ['email-gateway', { source: 'email-gateway' }, 'email-gateway'],
    ['modelpick', { source: 'modelpick' }, 'modelpick'],
    ['argo source', { source: 'argo' }, 'argo'],
    ['audio-gateway-mini', { source: 'audio-gateway-mini' }, 'audio-gateway'],
    ['audio-gateway-vps', { source: 'audio-gateway-vps' }, 'audio-gateway'],
    ['audio-proxy', { source: 'audio-proxy' }, 'audio-gateway'],
    ['image-gen-gateway', { source: 'image-gen-gateway' }, 'image-gateway'],
    ['agent-gateway-iu', { source: 'agent-gateway-iu' }, 'agent-gateway'],
    [
      'agent-gateway-opencode keeps its work repo',
      { source: 'agent-gateway-opencode', project: `${H}/IuRoot/prometheus-epx` },
      TEAMCHAT,
    ],
    ['agent-gateway-sessions', { source: 'agent-gateway-sessions' }, 'agent-gateway'],
    // d: origin / caller / purpose
    ['iris caller', { source: 'gateway', caller: 'iris' }, 'iris'],
    ['origin beats caller', { source: 'gateway', origin: 'hermes', caller: 'agw' }, 'hermes-agent'],
    ['hermes caller', { source: 'gateway', caller: 'hermes' }, 'hermes-agent'],
    ['modelpick caller', { source: 'gateway', caller: 'modelpick' }, 'modelpick'],
    ['argo caller', { source: 'gateway', caller: 'argo' }, 'argo'],
    [
      'eval caller',
      { source: 'agent-workflows', caller: 'eval', purpose: 'drift' },
      'agent-workflows',
    ],
    [
      'eval purpose',
      { source: 'gateway', caller: 'agw', origin: 'claude-code', purpose: 'eval' },
      'agent-workflows',
    ],
    [
      'claude-code origin says nothing',
      { source: 'gateway', caller: 'agw-opencode', origin: 'claude-code', purpose: 'prod' },
      null,
    ],
    ['oc says nothing', { source: 'gateway', caller: 'oc' }, null],
    ['nothing', { source: 'litellm' }, null],
  ]
  test.each(cases)('%s', (_name, input, expected) => {
    expect(classifyRepo(input, known)).toBe(expected)
  })
})

describe('knownRepos', () => {
  test('reads the directories of both roots and adds the retired ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-'))
    for (const d of ['src/argo', 'src/.hidden', 'src/worktrees', 'iu/epos-x'])
      mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, 'src/notes.md'), '')
    const k = knownRepos({ sourceRoot: join(root, 'src'), iuRoot: join(root, 'iu') })
    expect(k.has('argo')).toBe(true)
    expect(k.has('iu/epos-x')).toBe(true)
    expect(k.has('.hidden')).toBe(false)
    expect(k.has('worktrees')).toBe(false)
    expect(k.has('notes.md')).toBe(false)
    expect(k.has('photo-flow')).toBe(true)
    expect(k.has('nope')).toBe(false)
  })
})

describe('workspaceFor and the issue helpers', () => {
  test('workspace follows the path, else the repo', () => {
    expect(workspaceFor('/Users/x/IuRoot/foo', null)).toBe('work')
    expect(workspaceFor('/Users/x/SourceRoot/foo', 'iu/x')).toBe('private')
    expect(workspaceFor('slug', 'iu/epos-tool-athena')).toBe('work')
    expect(workspaceFor('slug', 'argo')).toBe('private')
    expect(workspaceFor(null, null)).toBeNull()
  })

  test('issue numbers come from lead sessions and factory worktrees', () => {
    expect(issueFromFactorySession('lead-141-2')).toBe('141')
    expect(issueFromFactorySession('dotfiles-w1')).toBeNull()
    expect(
      issueFromPath('/Users/x/SourceRoot/worktrees/free-planning-poker/factory-141-1/src'),
    ).toBe('141')
    expect(issueFromPath('/Users/x/SourceRoot/argo')).toBeNull()
  })
})
