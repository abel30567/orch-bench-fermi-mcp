import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's consumer (e.g. the Grok Bot routine
 * webhook) so it can claim immediately instead of polling on a timer.
 *
 * Config lives in KV `queue:hooks` as a JSON map:
 *   { "grok-bot": { "url": "https://…", "auth_header": "x-api-key", "secret": "GROKBOT_WEBHOOK_KEY" } }
 * The secret is an app-scope vault secret; its allowed_hosts must include the
 * URL's host, mirroring the fetch gateway's rule. Missing config → no-op.
 */
export const QUEUE_HOOKS_KV_KEY = 'queue:hooks'

export interface QueueHookConfig {
	url: string
	auth_header: string
	secret: string
}

export type QueueHookResult =
	| { fired: false; reason: string }
	| { fired: true; ok: boolean; attempts: number; status?: number }

/** Wait before each attempt; the length bounds the attempt count. */
export const DEFAULT_HOOK_DELAYS_MS = [0, 2_000, 8_000]
const ATTEMPT_TIMEOUT_MS = 5_000

async function loadHookConfig(env: Env, queue: string): Promise<QueueHookConfig | null> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KV_KEY)
	if (!raw) return null
	let map: Record<string, Partial<QueueHookConfig>>
	try {
		map = JSON.parse(raw)
	} catch {
		console.warn('[queue-hook] invalid JSON in KV queue:hooks')
		return null
	}
	const cfg = map?.[queue]
	if (!cfg?.url || !cfg.auth_header || !cfg.secret) return null
	return { url: cfg.url, auth_header: cfg.auth_header, secret: cfg.secret }
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

/**
 * Fire the wake hook for one task. Never throws: every failure is logged
 * (without the secret value) and reported in the result. Callers should run
 * it under waitUntil so the enqueue never waits on it.
 */
export async function fireQueueHook(
	env: Env,
	event: { task_id: string; queue: string },
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookResult> {
	const tag = `[queue-hook] queue=${event.queue} task=${event.task_id}`
	try {
		const cfg = await loadHookConfig(env, event.queue)
		if (!cfg) return { fired: false, reason: 'not_configured' }

		let host: string
		try {
			host = new URL(cfg.url).host
		} catch {
			console.warn(`${tag} skipped: invalid url`)
			return { fired: false, reason: 'invalid_url' }
		}
		const secret = await getSecret(cfg.secret, 'app', '', env)
		if (!secret) {
			console.warn(`${tag} skipped: secret ${cfg.secret} not found`)
			return { fired: false, reason: 'secret_not_found' }
		}
		if (!secret.metadata.allowed_hosts.includes(host)) {
			console.warn(`${tag} skipped: secret ${cfg.secret} not approved for host ${host}`)
			return { fired: false, reason: 'host_not_approved' }
		}

		const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })
		let lastStatus: number | undefined
		for (let i = 0; i < delaysMs.length; i++) {
			if (delaysMs[i] > 0) await new Promise((r) => setTimeout(r, delaysMs[i]))
			const attempt = i + 1
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', [cfg.auth_header]: secret.value },
					body,
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				})
				lastStatus = res.status
				await res.body?.cancel()
				if (res.ok) return { fired: true, ok: true, attempts: attempt, status: res.status }
				if (!isRetryable(res.status)) {
					console.warn(`${tag} attempt ${attempt} got ${res.status}; not retrying`)
					return { fired: true, ok: false, attempts: attempt, status: res.status }
				}
				console.warn(`${tag} attempt ${attempt} got ${res.status}`)
			} catch (err) {
				lastStatus = undefined
				console.warn(`${tag} attempt ${attempt} failed: ${(err as Error).name}`)
			}
		}
		console.warn(`${tag} gave up after ${delaysMs.length} attempts`)
		return { fired: true, ok: false, attempts: delaysMs.length, status: lastStatus }
	} catch (err) {
		console.warn(`${tag} error: ${(err as Error).name}`)
		return { fired: false, reason: 'error' }
	}
}
