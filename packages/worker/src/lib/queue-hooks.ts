import { getSecret } from './secrets-store.ts'

const HOOKS_KV_KEY = 'queue:hooks'
// Worst case (three attempts, each timing out) stays inside waitUntil's 30s window.
const DEFAULT_DELAYS_MS = [0, 1_000, 5_000]
const ATTEMPT_TIMEOUT_MS = 5_000

interface QueueHook {
	url: string
	auth_header: string
	secret: string
}

export interface QueueHookEvent {
	task_id: string
	queue: string
}

async function loadHook(env: Env, queue: string): Promise<QueueHook | null> {
	const raw = await env.FERMI_KV.get(HOOKS_KV_KEY)
	if (!raw) return null
	const hooks = JSON.parse(raw) as Record<string, Partial<QueueHook>> | null
	const hook = hooks?.[queue]
	if (!hook?.url || !hook.auth_header || !hook.secret) return null
	return hook as QueueHook
}

// Logs carry names and statuses only: fetch error messages and the hook URL
// are never logged, so nothing sensitive can reach them.
function logHook(event: QueueHookEvent, outcome: string, detail: Record<string, unknown> = {}) {
	console.warn('queue_hook', { ...event, outcome, ...detail })
}

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : 'unknown'
}

/**
 * Outbound wake: tell a queue's external consumer that a task is waiting, so
 * it doesn't have to poll. Config is the KV key `queue:hooks`, a JSON map of
 * queue → { url, auth_header, secret }; the secret is app-scoped and its value
 * is sent as the auth_header header. No config, no call.
 *
 * Best-effort, like wakeMacDaemon: never throws, so an enqueue can't fail on
 * it. delaysMs holds one wait per attempt; network errors, 429 and 5xx retry,
 * anything else stops.
 */
export async function fireQueueHook(
	env: Env,
	event: QueueHookEvent,
	delaysMs: number[] = DEFAULT_DELAYS_MS,
): Promise<void> {
	try {
		const hook = await loadHook(env, event.queue)
		if (!hook) return

		const secret = await getSecret(hook.secret, 'app', '', env)
		if (!secret) {
			logHook(event, 'secret_not_found', { secret: hook.secret })
			return
		}
		const host = new URL(hook.url).host
		if (!secret.metadata.allowed_hosts.includes(host)) {
			logHook(event, 'host_not_approved', { secret: hook.secret, host })
			return
		}

		const headers = new Headers({ 'content-type': 'application/json' })
		headers.set(hook.auth_header, secret.value)
		const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })

		for (const [index, delayMs] of delaysMs.entries()) {
			const attempt = index + 1
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
			try {
				// redirect: manual — following one would carry the secret header to a
				// host that allowed_hosts never approved.
				const res = await fetch(hook.url, {
					method: 'POST',
					headers,
					body,
					redirect: 'manual',
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				})
				if (res.status !== 429 && res.status < 500) {
					if (!res.ok) logHook(event, 'rejected', { attempt, status: res.status })
					return
				}
				logHook(event, 'retryable_status', { attempt, status: res.status })
			} catch (err) {
				logHook(event, 'network_error', { attempt, error: errorName(err) })
			}
		}
		logHook(event, 'gave_up', { attempts: delaysMs.length })
	} catch (err) {
		logHook(event, 'failed', { error: errorName(err) })
	}
}
