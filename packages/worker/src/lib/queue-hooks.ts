import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's consumer (e.g. the Grok Bot routine
 * webhook) so it claims right away instead of polling on a timer.
 *
 * Config lives in KV `queue:hooks`:
 *   { "grok-bot": { "url": "https://…", "auth_header": "x-api-key", "secret": "GROKBOT_WEBHOOK_KEY" } }
 * `secret` names an app-scope vault secret; its allowed_hosts must include the
 * URL's host. No config / no secret / host not approved → no-op.
 */

export const QUEUE_HOOKS_KEY = 'queue:hooks'
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const ATTEMPT_TIMEOUT_MS = 5_000

export interface QueueHookConfig {
	url: string
	auth_header: string
	secret: string
}

export type QueueHookOutcome =
	| {
			fired: false
			reason: 'not_configured' | 'bad_config' | 'secret_missing' | 'host_not_approved' | 'error'
	  }
	| { fired: true; ok: boolean; attempts: number; status?: number }

export async function loadQueueHooks(env: Env): Promise<Record<string, QueueHookConfig>> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KEY)
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
	} catch {
		console.warn('[queue-hook] queue:hooks is not valid JSON; hooks disabled')
		return {}
	}
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

/**
 * Fire the wake hook for one enqueued task. Never throws; callers should run
 * it via ctx.waitUntil so it never blocks the enqueue. `delaysMs` holds one
 * wait per attempt (the wait happens before that attempt). Retries on network
 * errors, timeouts, 429 and 5xx; any other status stops.
 */
export async function fireQueueHook(
	env: Env,
	event: { task_id: string; queue: string },
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookOutcome> {
	const tag = `[queue-hook] queue=${event.queue} task=${event.task_id}`
	try {
		const hooks = await loadQueueHooks(env)
		const cfg = hooks[event.queue]
		if (!cfg) return { fired: false, reason: 'not_configured' }
		if (!cfg.url || !cfg.auth_header || !cfg.secret) {
			return { fired: false, reason: 'not_configured' }
		}
		let host: string
		try {
			host = new URL(cfg.url).host
		} catch {
			console.warn(`${tag} skipped: invalid url`)
			return { fired: false, reason: 'bad_config' }
		}
		const rec = await getSecret(cfg.secret, 'app', '', env)
		if (!rec) {
			console.warn(`${tag} skipped: secret ${cfg.secret} not found`)
			return { fired: false, reason: 'secret_missing' }
		}
		if (!rec.metadata.allowed_hosts.includes(host)) {
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
					headers: { 'content-type': 'application/json', [cfg.auth_header]: rec.value },
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
				console.warn(`${tag} attempt ${attempt}/${delaysMs.length} got ${res.status}`)
			} catch (err) {
				lastStatus = undefined
				const name = err instanceof Error ? err.name : 'Error'
				console.warn(`${tag} attempt ${attempt}/${delaysMs.length} failed: ${name}`)
			}
		}
		console.warn(`${tag} gave up after ${delaysMs.length} attempts`)
		return { fired: true, ok: false, attempts: delaysMs.length, status: lastStatus }
	} catch (err) {
		const name = err instanceof Error ? err.name : 'Error'
		console.warn(`${tag} skipped: ${name}`)
		return { fired: false, reason: 'error' }
	}
}
