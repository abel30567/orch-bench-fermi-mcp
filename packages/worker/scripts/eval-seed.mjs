#!/usr/bin/env node
// Seed a local eval worker (wrangler.eval.jsonc) from a fixture JSON: profile,
// memories, allowlist, pending tasks, conversation history and skills. Applies D1
// migrations, replaces those tables with the fixture's rows via
// `wrangler d1 execute --local`, writes the history through the real conversation
// store (logChannelMessage) on the same local D1, then writes each skill through
// the running worker's `skill_set` tool on /mcp.
//
//   node scripts/eval-seed.mjs test/fixtures/eval/sample.json [--persist-to DIR] \
//     [--url http://127.0.0.1:8787]
//
// Pass the same --persist-to and port as the running `wrangler dev`. See
// "Running the eval target" in the README.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedHistory, seedSkills, seedStatements } from './eval-db.mjs'

const workerDir = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const persistAt = args.indexOf('--persist-to')
const persistTo = persistAt >= 0 ? args.splice(persistAt, 2)[1] : undefined
const persist = persistTo ? ['--persist-to', persistTo] : []
const urlAt = args.indexOf('--url')
const url = urlAt >= 0 ? args.splice(urlAt, 2)[1] : 'http://127.0.0.1:8787'
const [fixturePath] = args
if (!fixturePath) {
	console.error('usage: eval-seed.mjs <fixture.json> [--persist-to DIR] [--url WORKER_URL]')
	process.exit(2)
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const file = join(mkdtempSync(join(tmpdir(), 'fermi-eval-seed-')), 'seed.sql')
writeFileSync(file, `${seedStatements(fixture).join(';\n')};\n`)

const wrangler = (...rest) =>
	execFileSync(
		'npx',
		[
			'wrangler',
			'd1',
			...rest,
			'FERMI_DB',
			'--local',
			'--config',
			'wrangler.eval.jsonc',
			...persist,
		],
		{ cwd: workerDir, stdio: ['ignore', 'inherit', 'inherit'] },
	)
wrangler('migrations', 'apply')
wrangler('execute', '--file', file)
if (fixture.history) {
	// The same local D1 `wrangler d1 execute` just wrote (wrangler keeps it under
	// <persist-to>/v3, resolved from the worker dir), as a real D1 binding.
	const { getPlatformProxy } = await import('wrangler')
	const proxy = await getPlatformProxy({
		configPath: join(workerDir, 'wrangler.eval.jsonc'),
		persist: { path: join(resolve(workerDir, persistTo ?? '.wrangler/state'), 'v3') },
	})
	try {
		await seedHistory(proxy.env.FERMI_DB, fixture)
	} finally {
		await proxy.dispose()
	}
	console.log(`seeded ${fixture.history.length} history turn(s) via logChannelMessage`)
}
if (fixture.skills) {
	await seedSkills(fixture.skills, new URL('/mcp', url).href)
	console.log(`seeded ${fixture.skills.length} skill(s) via skill_set`)
}
