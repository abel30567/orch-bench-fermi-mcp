import { getSecret } from './secrets-store.ts'

/**
 * Outbound queue wake hooks. When a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's webhook so an external worker (e.g.
 * Grok Bot on `grok-bot`) claims it immediately instead of polling on a timer.
 *
 * Config lives in KV `queue:hooks`:
 *   { "grok-bot": { "url": "https://...", "auth_header": "x-api-key", "secret": "GROKBOT_WEBHOOK_KEY" } }
 * The secret (app scope) must list the URL's host in allowed_hosts. Its value
 * is only ever placed in the outbound header — never logged.
 */
export const QUEUE_HOOKS_KV_KEY = 'queue:hooks'
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const HOOK_TIMEOUT_MS = 10_000

export interface QueueHookConfig {
	url: string
	auth_header?: string
	secret?: string
}

export type QueueHookResult =
	| { fired: false; reason: string }
	| { fired: true; ok: boolean; attempts: number; status?: number }

async function loadHookConfig(env: Env, queue: string): Promise<QueueHookConfig | null> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KV_KEY)
	if (!raw) return null
	try {
		const map = JSON.parse(raw) as Record<string, QueueHookConfig | undefined>
		const cfg = map?.[queue]
		return cfg && typeof cfg.url === 'string' && cfg.url ? cfg : null
	} catch {
		console.warn('queue hook: invalid queue:hooks config')
		return null
	}
}

/**
 * Fire the wake hook for one task. Never throws; `delaysMs` holds one wait
 * per attempt (so its length bounds the attempts). Retries on network
 * errors, 429 and 5xx; any other status stops.
 */
export async function fireQueueHook(
	env: Env,
	event: { task_id: string; queue: string },
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookResult> {
	try {
		const cfg = await loadHookConfig(env, event.queue)
		if (!cfg) return { fired: false, reason: 'not_configured' }

		let host: string
		try {
			host = new URL(cfg.url).host
		} catch {
			console.warn(`queue hook ${event.queue}: invalid url`)
			return { fired: false, reason: 'invalid_url' }
		}

		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (cfg.secret) {
			const rec = await getSecret(cfg.secret, 'app', '', env)
			if (!rec) {
				console.warn(`queue hook ${event.queue}: secret ${cfg.secret} not found`)
				return { fired: false, reason: 'secret_not_found' }
			}
			if (!rec.metadata.allowed_hosts.includes(host)) {
				console.warn(`queue hook ${event.queue}: secret ${cfg.secret} not approved for ${host}`)
				return { fired: false, reason: 'host_not_approved' }
			}
			headers[cfg.auth_header || 'authorization'] = rec.value
		}

		const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })
		let attempts = 0
		let lastStatus: number | undefined
		for (const delay of delaysMs) {
			if (delay > 0) await new Promise((r) => setTimeout(r, delay))
			attempts++
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers,
					body,
					signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
				})
				lastStatus = res.status
				await res.body?.cancel()
				if (res.ok) return { fired: true, ok: true, attempts, status: res.status }
				const retryable = res.status === 429 || res.status >= 500
				console.warn(
					`queue hook ${event.queue} task ${event.task_id}: attempt ${attempts} got ${res.status}`,
				)
				if (!retryable) return { fired: true, ok: false, attempts, status: res.status }
			} catch (err) {
				lastStatus = undefined
				console.warn(
					`queue hook ${event.queue} task ${event.task_id}: attempt ${attempts} failed: ${
						err instanceof Error ? err.name : 'error'
					}`,
				)
			}
		}
		return { fired: true, ok: false, attempts, status: lastStatus }
	} catch (err) {
		console.warn(`queue hook ${event.queue}: ${err instanceof Error ? err.name : 'error'}`)
		return { fired: false, reason: 'error' }
	}
}
