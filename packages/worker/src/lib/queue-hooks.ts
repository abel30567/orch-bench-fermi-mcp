import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to the queue owner's webhook so it can claim right away
 * instead of polling on a timer (e.g. queue `grok-bot` → Grok Bot routine).
 *
 * Config lives in KV under `queue:hooks`:
 *   { "grok-bot": { "url": "https://…", "auth_header": "Authorization", "secret": "GROKBOT_WEBHOOK_KEY" } }
 * The header value is the app-scope secret's value, read from the secrets
 * store. The hook is skipped unless the URL's host is in the secret's
 * allowed_hosts (same rule as the fetch gateway). No config → no-op.
 *
 * Never throws: hook failures must not affect the enqueue. The secret value is
 * never logged.
 */

export const QUEUE_HOOKS_KV_KEY = 'queue:hooks'
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const ATTEMPT_TIMEOUT_MS = 5_000

export interface QueueHookConfig {
	url: string
	auth_header: string
	secret: string
}

export type QueueHookOutcome =
	| { fired: false; reason: string }
	| { fired: true; ok: boolean; attempts: number; status?: number }

export async function loadQueueHooks(env: Env): Promise<Record<string, QueueHookConfig>> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KV_KEY)
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, QueueHookConfig>) : {}
	} catch {
		console.warn('queue-hooks: invalid JSON in queue:hooks, ignoring')
		return {}
	}
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

export async function fireQueueHook(
	env: Env,
	event: { task_id: string; queue: string },
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookOutcome> {
	try {
		const hooks = await loadQueueHooks(env)
		const cfg = Object.hasOwn(hooks, event.queue) ? hooks[event.queue] : undefined
		if (!cfg || !cfg.url || !cfg.auth_header || !cfg.secret) {
			return { fired: false, reason: 'not_configured' }
		}
		let host: string
		try {
			host = new URL(cfg.url).host
		} catch {
			console.warn(`queue-hooks: invalid url for queue ${event.queue}`)
			return { fired: false, reason: 'invalid_url' }
		}
		const secret = await getSecret(cfg.secret, 'app', '', env)
		if (!secret) {
			console.warn(`queue-hooks: secret ${cfg.secret} missing for queue ${event.queue}`)
			return { fired: false, reason: 'secret_missing' }
		}
		if (!secret.metadata.allowed_hosts.includes(host)) {
			console.warn(`queue-hooks: secret ${cfg.secret} not approved for host ${host}`)
			return { fired: false, reason: 'host_not_approved' }
		}

		const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })
		const attempts = Math.max(delaysMs.length, 1)
		let lastStatus: number | undefined
		for (let i = 0; i < attempts; i++) {
			const wait = delaysMs[i] ?? 0
			if (wait > 0) await new Promise((r) => setTimeout(r, wait))
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', [cfg.auth_header]: secret.value },
					body,
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				})
				lastStatus = res.status
				// Drain the body so the connection is released.
				await res.body?.cancel().catch(() => {})
				if (res.ok) return { fired: true, ok: true, attempts: i + 1, status: res.status }
				console.warn(
					`queue-hooks: ${event.queue} task ${event.task_id} attempt ${i + 1}/${attempts} → HTTP ${res.status}`,
				)
				if (!isRetryable(res.status)) {
					return { fired: true, ok: false, attempts: i + 1, status: res.status }
				}
			} catch (err) {
				lastStatus = undefined
				const reason = err instanceof Error ? err.name : 'unknown'
				console.warn(
					`queue-hooks: ${event.queue} task ${event.task_id} attempt ${i + 1}/${attempts} failed (${reason})`,
				)
			}
		}
		console.warn(`queue-hooks: ${event.queue} task ${event.task_id} gave up after ${attempts}`)
		return { fired: true, ok: false, attempts, status: lastStatus }
	} catch (err) {
		console.warn(
			`queue-hooks: ${event.queue} task ${event.task_id} hook error (${err instanceof Error ? err.name : 'unknown'})`,
		)
		return { fired: false, reason: 'error' }
	}
}
