import { fetchMock } from 'cloudflare:test'
import { beforeAll, beforeEach } from 'vitest'
import { applyMigrations } from '../setup-d1.ts'
import { macBridgeReply } from './fake-mac.ts'
import { resetTables } from './tool-call.ts'

// Runs once per test file. The project shares one D1 (see vitest.contract.config.ts),
// so this brings its schema up to date. Outbound HTTP is refused unless a test mocks it;
// the macOS bridge answers through macBridgeReply() (fake-mac.ts).
beforeAll(async () => {
	await applyMigrations()
	fetchMock.activate()
	fetchMock.disableNetConnect()
	fetchMock
		.get('http://mac.test')
		.intercept({ path: () => true, method: () => true })
		.reply((opts) => macBridgeReply(opts))
		.persist()
})

// Tables no test file resets itself; other files clear what they use.
beforeEach(() => resetTables('hooks', 'retrievers', 'audit'))
