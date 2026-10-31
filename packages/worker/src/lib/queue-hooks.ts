import { getSecret } from './secrets-store.ts'

const CONFIG_KEY = 'queue:hooks'
const DEFAULT_DELAYS_MS = [0, 1_000, 4_000]
const ATTEMPT_TIMEOUT_MS = 5_000

interface QueueHook {
	url: string
	auth_header: string
	secret: string
}

async function loadHook(env: Env, queue: string): Promise<QueueHook | null> {
	const raw = await env.FERMI_KV.get(CONFIG_KEY)
	if (!raw) return null
	const hooks = JSON.parse(raw) as Record<string, Partial<QueueHook>>
	const hook = Object.hasOwn(hooks, queue) ? hooks[queue] : null
	// Partially configured means disabled: the receiving side may not exist yet.
	if (!hook?.url || !hook.auth_header || !hook.secret) return null
	return hook as QueueHook
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500
}

/**
 * Outbound wake: POST { task_id, queue } to the URL configured for this queue
 * in KV `queue:hooks`, authenticated with an app-scope secret that must be
 * approved for the URL's host. One attempt per delaysMs entry, each preceded by
 * its wait; network errors, 429 and 5xx retry, anything else stops.
 *
 * Best-effort and never rejects, so it is safe to leave un-awaited. Logs carry
 * only the queue, task id, attempt and status or error name: the URL, the
 * header and error messages can all hold credentials.
 */
export async function fireQueueHook(
	env: Env,
	task: { task_id: string; queue: string },
	delaysMs: number[] = DEFAULT_DELAYS_MS,
): Promise<void> {
	const { task_id, queue } = task
	const label = `queue_hook queue=${queue} task=${task_id}`
	try {
		const hook = await loadHook(env, queue)
		if (!hook) return
		const secret = await getSecret(hook.secret, 'app', '', env)
		if (!secret) {
			console.warn(`${label} skipped: secret not found`)
			return
		}
		if (!secret.metadata.allowed_hosts.includes(new URL(hook.url).host)) {
			console.warn(`${label} skipped: host not approved for secret`)
			return
		}

		for (const [i, delay] of delaysMs.entries()) {
			const attempt = `${i + 1}/${delaysMs.length}`
			if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
			try {
				const res = await fetch(hook.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', [hook.auth_header]: secret.value },
					body: JSON.stringify({ task_id, queue }),
					// A redirect would carry the secret to a host nobody approved.
					redirect: 'manual',
					signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
				})
				if (res.ok) return
				console.warn(`${label} attempt ${attempt} failed: status ${res.status}`)
				if (!isRetryable(res.status)) return
			} catch (err) {
				console.warn(`${label} attempt ${attempt} failed: ${errorName(err)}`)
			}
		}
	} catch (err) {
		console.warn(`${label} aborted: ${errorName(err)}`)
	}
}

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : 'unknown'
}
