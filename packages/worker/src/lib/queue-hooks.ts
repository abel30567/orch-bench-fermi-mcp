import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's consumer (e.g. the Grok Bot routine
 * webhook) so it claims right away instead of polling on a timer.
 *
 * Config lives in KV `queue:hooks`:
 *   { "grok-bot": { "url": "https://…", "auth_header": "Authorization", "secret": "GROKBOT_WEBHOOK_KEY" } }
 * The secret (app scope) supplies the header value and must list the URL's
 * host in its allowed_hosts. Missing config/secret → no-op.
 */
export const QUEUE_HOOKS_KV_KEY = 'queue:hooks'

export interface QueueHookConfig {
	url: string
	auth_header: string
	secret: string
}

export interface QueueHookEvent {
	task_id: string
	queue: string
}

export interface QueueHookResult {
	fired: boolean
	attempts: number
	status?: number
	skipped?: 'no_config' | 'bad_config' | 'secret_missing' | 'host_not_approved'
	error?: string
}

/**
 * Passed to enqueueTask so the hook can run after the insert. Stateless
 * request/cron paths must supply waitUntil; Durable Objects may omit it.
 */
export interface QueueHookContext {
	env: Env
	waitUntil?: (promise: Promise<unknown>) => void
}

/** Hook context for a Worker execution context; none without one. */
export function queueHookContext(
	env: Env,
	ctx?: { waitUntil(promise: Promise<unknown>): void },
): QueueHookContext | undefined {
	return ctx ? { env, waitUntil: (p) => ctx.waitUntil(p) } : undefined
}

// One wait per attempt: try now, then back off.
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const ATTEMPT_TIMEOUT_MS = 5_000

async function loadHookConfig(env: Env, queue: string): Promise<QueueHookConfig | null | 'bad'> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KV_KEY)
	if (!raw) return null
	let map: Record<string, Partial<QueueHookConfig>>
	try {
		map = JSON.parse(raw)
	} catch {
		return 'bad'
	}
	const cfg = map?.[queue]
	if (!cfg) return null
	if (!cfg.url || !cfg.auth_header || !cfg.secret) return 'bad'
	return { url: cfg.url, auth_header: cfg.auth_header, secret: cfg.secret }
}

function log(event: QueueHookEvent, msg: string, extra: Record<string, unknown> = {}) {
	// Never log the secret or the header value.
	console.log(JSON.stringify({ at: 'queue_hook', ...event, msg, ...extra }))
}

export async function fireQueueHook(
	env: Env,
	event: QueueHookEvent,
	delaysMs: number[] = DEFAULT_HOOK_DELAYS_MS,
): Promise<QueueHookResult> {
	const cfg = await loadHookConfig(env, event.queue)
	if (!cfg) return { fired: false, attempts: 0, skipped: 'no_config' }
	if (cfg === 'bad') {
		log(event, 'bad_config')
		return { fired: false, attempts: 0, skipped: 'bad_config' }
	}
	let host: string
	try {
		host = new URL(cfg.url).host
	} catch {
		log(event, 'bad_config')
		return { fired: false, attempts: 0, skipped: 'bad_config' }
	}
	const secret = await getSecret(cfg.secret, 'app', '', env)
	if (!secret) {
		log(event, 'secret_missing', { secret: cfg.secret })
		return { fired: false, attempts: 0, skipped: 'secret_missing' }
	}
	if (!secret.metadata.allowed_hosts.includes(host)) {
		log(event, 'host_not_approved', { secret: cfg.secret, host })
		return { fired: false, attempts: 0, skipped: 'host_not_approved' }
	}

	const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })
	let attempts = 0
	let lastStatus: number | undefined
	let lastError: string | undefined
	for (const delay of delaysMs) {
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
		attempts++
		try {
			const res = await fetch(cfg.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', [cfg.auth_header]: secret.value },
				body,
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
			})
			lastStatus = res.status
			lastError = undefined
			await res.body?.cancel()
			if (res.ok) {
				log(event, 'delivered', { host, attempt: attempts, status: res.status })
				return { fired: true, attempts, status: res.status }
			}
			if (res.status !== 429 && res.status < 500) {
				log(event, 'rejected', { host, attempt: attempts, status: res.status })
				return { fired: false, attempts, status: res.status }
			}
			log(event, 'retryable_status', { host, attempt: attempts, status: res.status })
		} catch (err) {
			lastStatus = undefined
			lastError = err instanceof Error ? err.name : 'unknown'
			log(event, 'network_error', { host, attempt: attempts, error: lastError })
		}
	}
	log(event, 'gave_up', { host, attempts, status: lastStatus, error: lastError })
	return { fired: false, attempts, status: lastStatus, error: lastError }
}

/**
 * Fire-and-forget wrapper used by enqueueTask: never throws, never blocks the
 * caller. Registered with waitUntil when the caller has an execution context.
 */
export function scheduleQueueHook(hook: QueueHookContext, event: QueueHookEvent): void {
	const run = fireQueueHook(hook.env, event).catch((err) => {
		log(event, 'hook_crashed', { error: err instanceof Error ? err.name : 'unknown' })
	})
	hook.waitUntil?.(run)
}
