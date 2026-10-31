#!/usr/bin/env node
// Seed a local eval worker (wrangler.eval.jsonc) from a fixture JSON: profile,
// memories, allowlist, pending tasks, conversation history and skills. Applies D1
// migrations, replaces those tables with the fixture's rows via
// `wrangler d1 execute --local`, writes the history through the worker's own
// conversation store (logChannelMessage) over the same local D1, then writes each
// skill through the running worker's `skill_set` tool on /mcp.
//
//   node scripts/eval-seed.mjs test/fixtures/eval/sample.json [--persist-to DIR] \
//     [--url http://127.0.0.1:8787]
//
// Pass the same --persist-to and port as the running `wrangler dev`. See
// "Running the eval target" in the README.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedHistory, seedSkills, seedStatements } from './eval-db.mjs'

const args = process.argv.slice(2)
const persistAt = args.indexOf('--persist-to')
const persist = persistAt >= 0 ? ['--persist-to', args.splice(persistAt, 2)[1]] : []
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

const wrangler = (...rest) => wranglerD1(rest, ['ignore', 'inherit', 'inherit'])
const wranglerD1 = (rest, stdio) =>
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
		{ cwd: new URL('..', import.meta.url), stdio, encoding: 'utf8' },
	)

const literal = (value) => {
	if (value === null || value === undefined) return 'NULL'
	if (typeof value === 'number') return String(value)
	return `'${String(value).replaceAll("'", "''")}'`
}

// The slice of D1Database the conversation store uses, one
// `wrangler d1 execute --local --command` per statement with bound values inlined.
const localD1 = {
	prepare(query) {
		const statement = (params) => {
			const run = async () => {
				let next = 0
				const command = query.replace(/\?(\d*)/g, (_, n) =>
					literal(params[n ? Number(n) - 1 : next++]),
				)
				const out = wranglerD1(
					['execute', '--json', '--command', command],
					['ignore', 'pipe', 'inherit'],
				)
				return JSON.parse(out)[0]
			}
			return {
				bind: (...values) => statement(values),
				run,
				all: run,
				first: async () => (await run()).results[0] ?? null,
			}
		}
		return statement([])
	},
}

wrangler('migrations', 'apply')
wrangler('execute', '--file', file)
if (fixture.history) {
	await seedHistory(localD1, fixture)
	console.log(
		`seeded ${fixture.history.length} history turn(s) for ${fixture.channel}:${fixture.chat_id}`,
	)
}
if (fixture.skills) {
	await seedSkills(fixture.skills, new URL('/mcp', url).href)
	console.log(`seeded ${fixture.skills.length} skill(s) via skill_set`)
}
