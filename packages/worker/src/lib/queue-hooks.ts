import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's consumer (e.g. the Grok Bot routine
 * webhook) so it wakes now instead of on its next timer poll.
 *
 * Config lives in KV under `queue:hooks` — a JSON map of queue →
 * `{ url, auth_header, secret }`. `secret` names an app-scope Fermi secret
 * whose value becomes the auth header value; the hook only fires when the
 * URL's host is in that secret's allowed_hosts (same rule as the fetch
 * gateway). No config / no secret → no-op. The secret value is never logged.
 */
export const QUEUE_HOOKS_KV_KEY = 'queue:hooks'

export interface QueueHookConfig {
	url: string
	auth_header: string
	secret: string
	/** Per-attempt timeout (default 5000 ms). */
	timeout_ms?: number
}

export interface QueueHookEvent {
	task_id: string
	queue: string
}

export interface QueueHookResult {
	fired: boolean
	attempts: number
	ok: boolean
	status?: number
	skipped?: string
}

/** One wait per attempt, applied before that attempt (first is immediate). */
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const DEFAULT_TIMEOUT_MS = 5_000

function log(event: string, fields: Record<string, unknown>) {
	console.log(JSON.stringify({ at: 'queue-hook', event, ...fields }))
}

async function loadHookConfig(env: Env, queue: string): Promise<QueueHookConfig | null> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KV_KEY)
	if (!raw) return null
	let map: unknown
	try {
		map = JSON.parse(raw)
	} catch {
		log('config_invalid', { queue })
		return null
	}
	if (!map || typeof map !== 'object') return null
	const cfg = (map as Record<string, Partial<QueueHookConfig> | undefined>)[queue]
	if (
		!cfg ||
		typeof cfg.url !== 'string' ||
		!cfg.url ||
		typeof cfg.secret !== 'string' ||
		!cfg.secret
	) {
		return null
	}
	return {
		url: cfg.url,
		auth_header:
			typeof cfg.auth_header === 'string' && cfg.auth_header ? cfg.auth_header : 'Authorization',
		secret: cfg.secret,
		timeout_ms: typeof cfg.timeout_ms === 'number' ? cfg.timeout_ms : undefined,
	}
}

function retryable(status: number): boolean {
	return status === 429 || status >= 500
}

export async function fireQueueHook(
	env: Env,
	event: QueueHookEvent,
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookResult> {
	const { task_id, queue } = event
	const cfg = await loadHookConfig(env, queue)
	if (!cfg) return { fired: false, attempts: 0, ok: false, skipped: 'not_configured' }

	let url: URL
	try {
		url = new URL(cfg.url)
	} catch {
		log('skipped', { queue, task_id, reason: 'invalid_url' })
		return { fired: false, attempts: 0, ok: false, skipped: 'invalid_url' }
	}

	const secret = await getSecret(cfg.secret, 'app', '', env)
	if (!secret) {
		log('skipped', { queue, task_id, reason: 'secret_not_found', secret: cfg.secret })
		return { fired: false, attempts: 0, ok: false, skipped: 'secret_not_found' }
	}
	if (!secret.metadata.allowed_hosts.includes(url.host)) {
		log('skipped', {
			queue,
			task_id,
			reason: 'host_not_approved',
			secret: cfg.secret,
			host: url.host,
		})
		return { fired: false, attempts: 0, ok: false, skipped: 'host_not_approved' }
	}

	const body = JSON.stringify({ task_id, queue })
	const timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS
	const delays = delaysMs.length > 0 ? delaysMs : [0]
	let attempts = 0
	let lastStatus: number | undefined
	for (const delay of delays) {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
		attempts++
		try {
			const res = await fetch(url.toString(), {
				method: 'POST',
				headers: { 'content-type': 'application/json', [cfg.auth_header]: secret.value },
				body,
				signal: AbortSignal.timeout(timeoutMs),
			})
			lastStatus = res.status
			// Drain the body so the connection is released.
			await res.body?.cancel().catch(() => {})
			if (res.ok) {
				log('delivered', { queue, task_id, host: url.host, attempt: attempts, status: res.status })
				return { fired: true, attempts, ok: true, status: res.status }
			}
			log('attempt_failed', {
				queue,
				task_id,
				host: url.host,
				attempt: attempts,
				status: res.status,
			})
			if (!retryable(res.status)) break
		} catch (e) {
			lastStatus = undefined
			const name = e instanceof Error ? e.name : 'Error'
			log('attempt_failed', { queue, task_id, host: url.host, attempt: attempts, error: name })
		}
	}
	log('gave_up', { queue, task_id, host: url.host, attempts, status: lastStatus })
	return { fired: true, attempts, ok: false, status: lastStatus }
}

export type WaitUntil = (promise: Promise<unknown>) => void

/**
 * Fire-and-forget wrapper used by enqueueTask: never throws, never blocks the
 * caller. With a waitUntil the request lifetime is extended for the hook;
 * without one (Durable Objects, MCP tools) the promise floats.
 */
export function scheduleQueueHook(
	env: Env,
	event: QueueHookEvent,
	waitUntil?: WaitUntil,
	delaysMs?: number[],
): Promise<void> {
	const p = fireQueueHook(env, event, delaysMs).then(
		() => undefined,
		(e) => {
			log('error', {
				queue: event.queue,
				task_id: event.task_id,
				error: e instanceof Error ? e.name : 'Error',
			})
		},
	)
	if (waitUntil) {
		try {
			waitUntil(p)
		} catch {
			// waitUntil unavailable in this context — let the promise float.
		}
	}
	return p
}
