import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkJsonlFiles } from './fs-incremental.ts'

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

test('finds .jsonl files at any depth', async () => {
  dir = await mkdtemp(join(tmpdir(), 'walk-'))
  await mkdir(join(dir, 'a', 'b'), { recursive: true })
  await writeFile(join(dir, 'a', 'b', 'x.jsonl'), '{}\n')
  await writeFile(join(dir, 'a', 'ignore.txt'), '')
  expect(await walkJsonlFiles(dir)).toEqual([join(dir, 'a', 'b', 'x.jsonl')])
})

test('a missing root still throws (callers decide)', async () => {
  dir = await mkdtemp(join(tmpdir(), 'walk-'))
  await expect(walkJsonlFiles(join(dir, 'nope'))).rejects.toThrow()
})
