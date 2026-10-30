import { describe, expect, test } from 'bun:test'
import { parseSince } from './cli.ts'

describe('parseSince', () => {
  test('defaults when absent, accepts a calendar day', () => {
    expect(parseSince([])).toBe('2026-04-01')
    expect(parseSince(['--since', '2026-05-17'])).toBe('2026-05-17')
  })

  test('a missing, malformed or impossible value fails naming the flag', () => {
    for (const bad of [
      ['--since'],
      ['--since', '--x'],
      ['--since', '2026-5-1'],
      ['--since', 'yesterday'],
      ['--since', '2026-02-30'],
      ['--since', '2026-13-01'],
    ]) {
      expect(() => parseSince(bad)).toThrow(/--since needs a date as YYYY-MM-DD/)
    }
  })

  test('the CLI exits 2 before connecting', () => {
    const p = Bun.spawnSync(
      ['bun', 'run', 'src/cli.ts', 'prices-seed-history', '--since', 'soon'],
      {
        env: { ...process.env, USAGE_PG_URL: 'postgres://nobody@127.0.0.1:1/none' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(p.exitCode).toBe(2)
    expect(p.stderr.toString()).toContain('--since needs a date')
  })
})
