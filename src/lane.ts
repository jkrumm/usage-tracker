// Lane vocabulary for usage.sessions / usage.records (decision U2) and the mapping from today's SQLite
// `sub_tool` (+ source + raw). Pure: the Wave 2 writers call laneFor for every record and session.

export const LANES = [
  'interactive',
  'wave_mother',
  'lead',
  'worker',
  'fan_worker',
  'subagent',
  'hermes',
  'iris',
  'agw_workflow',
  'other',
] as const
export type Lane = (typeof LANES)[number]

export interface LaneDetail {
  subagent_type?: string
  /** The factory role (`FACTORY_ROLE`) of the session or of the session tree a subagent belongs to. */
  role?: string
  workflow?: string
  step?: string
  route?: string
  /** Where inside the lane the record came from (a Hermes surface: slack, cron, cli, ...). */
  surface?: string
  /** The unmapped sub_tool, kept verbatim for `other` and for the fleet/legacy aliases. */
  raw?: string
}
export interface LaneInfo {
  lane: Lane
  detail: LaneDetail | null
}

/** Retired gateways whose rows are workflow runs; the source names the workflow, sub_tool its step. */
const WORKFLOW_SOURCES = new Set([
  'agent-workflows',
  'agent-gateway-opencode',
  'agent-gateway-sessions',
  'agent-gateway-iu',
  'litellm',
  'research-gateway',
  'audio-gateway',
  'audio-gateway-vps',
  'audio-proxy',
])
/** Sources where a missing sub_tool means a human at a terminal, as claude-code/opencode always were. */
const INTERACTIVE_BY_DEFAULT = new Set(['claude-code', 'opencode', 'codex', 'astra'])

/**
 * The lane of a factory-spawned session, from its FACTORY_ROLE (software-factory `config/roles.json`). The runner sets
 * USAGE_LANE=wave on every pane whatever the role, so the role beats the lane; the one refinement kept is `fan`
 * (`rd fan`'s USAGE_LANE), which splits fan-out workers from fleet workers. `mother` and `wave` are the same lane
 * (the session that runs a chain); `mechanical` has none of its own and is a worker whose role stays in the detail.
 * A role with no lane (an unknown or future one) returns null and the session keeps its USAGE_LANE / entrypoint lane.
 */
export function laneForRole(role: string, usageLane: string | null): Lane | null {
  switch (role) {
    case 'mother':
    case 'wave':
      return 'wave_mother'
    case 'lead':
      return 'lead'
    case 'worker':
      return usageLane === 'fan' ? 'fan_worker' : 'worker'
    case 'mechanical':
      return 'worker'
  }
  return null
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/** `review:angle` -> workflow review, step angle; `agent-gateway:review` -> workflow review. */
function workflowDetail(source: string, subTool: string | null): LaneDetail {
  const path = (subTool ?? '').replace(/^agent-gateway:/, '')
  // The retired research/audio gateways have no workflow vocabulary of their own: the source is the workflow.
  if (/^(?:research|audio)-gateway|^audio-proxy/.test(source)) {
    return path ? { workflow: source, step: path } : { workflow: source }
  }
  const [head, ...rest] = path.split(':')
  if (!head) return { workflow: source }
  return rest.length > 0 ? { workflow: head, step: rest.join(':') } : { workflow: head }
}

/**
 * Precedence: the record's own claims (a subagent type, an agw workflow in raw), then the source, then the
 * sub_tool. Unknown values map to `other` with the raw string in detail.raw; a null sub_tool is `interactive`
 * for the sources a human drives and `other` elsewhere.
 *
 *   interactive, desktop                  -> interactive
 *   wave                                  -> wave_mother   (`rd wave`: the session that runs the wave chain)
 *   fan                                   -> fan_worker    (`rd fan`: one worktree session per change)
 *   fleet                                 -> worker        (the work-machine fleet's sessions; raw kept)
 *   lead, worker                          -> lead, worker  (claude-code; the retired research-gateway uses them
 *                                            for its own roles and maps to agw_workflow by source)
 *   agent-gateway:<x>, review:*, dispatch, check, ...
 *     from the agent-gateway sources, litellm, ... -> agw_workflow  (workflow = x, step = rest)
 *   source hermes                         -> hermes        (detail.surface = slack | cron | cli | ...)
 *   source iris                           -> iris
 *   raw.subagentType                      -> subagent      (detail.subagent_type, and detail.role of its tree)
 *   raw.factoryRole                       -> laneForRole   (detail.role; beats sub_tool, which is USAGE_LANE)
 *   everything else                       -> other
 */
export function laneFor(
  subTool: string | null,
  source: string,
  raw?: Record<string, unknown> | null,
): LaneInfo {
  const role = str(raw?.factoryRole)
  const subagentType = str(raw?.subagentType)
  if (subagentType)
    return {
      lane: 'subagent',
      detail: role ? { subagent_type: subagentType, role } : { subagent_type: subagentType },
    }

  const roleLane = role ? laneForRole(role, subTool) : null
  if (role && roleLane) return { lane: roleLane, detail: { role } }
  const info = laneWithoutRole(subTool, source, raw)
  // A role with no lane of its own is still the session's role.
  return role ? { lane: info.lane, detail: { ...info.detail, role } } : info
}

function laneWithoutRole(
  subTool: string | null,
  source: string,
  raw?: Record<string, unknown> | null,
): LaneInfo {
  const workflow = str(raw?.workflow)
  if (workflow || source === 'agent-workflows') {
    const detail: LaneDetail = { ...workflowDetail(source, subTool) }
    if (workflow) detail.workflow = workflow
    const step = str(raw?.step)
    if (step) detail.step = step
    const route = str(raw?.route)
    if (route) detail.route = route
    return { lane: 'agw_workflow', detail }
  }

  if (source === 'hermes') return { lane: 'hermes', detail: subTool ? { surface: subTool } : null }
  if (source === 'iris') return { lane: 'iris', detail: subTool ? { surface: subTool } : null }
  if (WORKFLOW_SOURCES.has(source))
    return { lane: 'agw_workflow', detail: workflowDetail(source, subTool) }

  if (!subTool) {
    return INTERACTIVE_BY_DEFAULT.has(source)
      ? { lane: 'interactive', detail: null }
      : { lane: 'other', detail: null }
  }
  switch (subTool) {
    case 'interactive':
    case 'desktop':
      return { lane: 'interactive', detail: null }
    case 'wave':
      return { lane: 'wave_mother', detail: null }
    case 'fan':
      return { lane: 'fan_worker', detail: null }
    case 'fleet':
      return { lane: 'worker', detail: { raw: subTool } }
    case 'lead':
      return { lane: 'lead', detail: null }
    case 'worker':
      return { lane: 'worker', detail: null }
  }
  if (subTool.startsWith('agent-gateway:'))
    return { lane: 'agw_workflow', detail: workflowDetail(source, subTool) }
  return { lane: 'other', detail: { raw: subTool } }
}
