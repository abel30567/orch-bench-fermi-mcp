import { getSecret } from './secrets-store.ts'

/**
 * Outbound wake hooks: when a task lands on a configured queue, POST
 * `{ task_id, queue }` to that queue's consumer (e.g. the Grok Bot routine
 * webhook) so it doesn't have to poll. Config lives in KV `queue:hooks`:
 *
 *   { "grok-bot": { "url": "https://…", "auth_header": "x-api-key", "secret": "GROKBOT_WEBHOOK_KEY" } }
 *
 * The auth header value comes from the app-scope secret, which must list the
 * URL's host in allowed_hosts (same rule as the fetch gateway). Best-effort:
 * never throws, so an enqueue never fails because of a hook.
 */
export const QUEUE_HOOKS_KEY = 'queue:hooks'
export const DEFAULT_HOOK_DELAYS_MS = [0, 1_000, 4_000]
const HOOK_TIMEOUT_MS = 5_000

export interface QueueHookConfig {
	url: string
	auth_header?: string
	secret?: string
}

export type QueueHookResult =
	| { fired: false; reason: string }
	| { fired: true; ok: boolean; attempts: number; status?: number }

async function loadHookConfig(env: Env, queue: string): Promise<QueueHookConfig | null> {
	const raw = await env.FERMI_KV.get(QUEUE_HOOKS_KEY)
	if (!raw) return null
	let map: unknown
	try {
		map = JSON.parse(raw)
	} catch {
		console.warn('[queue-hook] invalid JSON in queue:hooks')
		return null
	}
	if (!map || typeof map !== 'object') return null
	const cfg = (map as Record<string, unknown>)[queue]
	if (!cfg || typeof cfg !== 'object') return null
	const { url, auth_header, secret } = cfg as Record<string, unknown>
	if (typeof url !== 'string' || !url) return null
	return {
		url,
		auth_header: typeof auth_header === 'string' && auth_header ? auth_header : undefined,
		secret: typeof secret === 'string' && secret ? secret : undefined,
	}
}

function shouldRetry(status: number): boolean {
	return status === 429 || status >= 500
}

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
			console.warn(`[queue-hook] ${event.queue}: invalid url`)
			return { fired: false, reason: 'invalid_url' }
		}

		const headers: Record<string, string> = { 'content-type': 'application/json' }
		if (cfg.secret) {
			const rec =
				(await getSecret(cfg.secret, 'app', '', env)) ??
				(await getSecret(cfg.secret, 'user', '', env))
			if (!rec) {
				console.warn(`[queue-hook] ${event.queue}: secret ${cfg.secret} not found`)
				return { fired: false, reason: 'secret_not_found' }
			}
			if (!rec.metadata.allowed_hosts.includes(host)) {
				console.warn(`[queue-hook] ${event.queue}: secret ${cfg.secret} not approved for ${host}`)
				return { fired: false, reason: 'host_not_approved' }
			}
			headers[cfg.auth_header ?? 'authorization'] = rec.value
		}

		const body = JSON.stringify({ task_id: event.task_id, queue: event.queue })
		const attempts = Math.max(delaysMs.length, 1)
		let status: number | undefined
		for (let i = 0; i < attempts; i++) {
			const delay = delaysMs[i] ?? 0
			if (delay > 0) await new Promise((r) => setTimeout(r, delay))
			try {
				const res = await fetch(cfg.url, {
					method: 'POST',
					headers,
					body,
					signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
				})
				status = res.status
				await res.body?.cancel()
				if (res.ok) return { fired: true, ok: true, attempts: i + 1, status }
				if (!shouldRetry(res.status)) {
					console.warn(`[queue-hook] ${event.queue}: task ${event.task_id} got ${res.status}`)
					return { fired: true, ok: false, attempts: i + 1, status }
				}
				console.warn(
					`[queue-hook] ${event.queue}: task ${event.task_id} attempt ${i + 1} got ${res.status}`,
				)
			} catch (e) {
				status = undefined
				console.warn(
					`[queue-hook] ${event.queue}: task ${event.task_id} attempt ${i + 1} failed: ${e instanceof Error ? e.name : 'error'}`,
				)
			}
		}
		console.warn(`[queue-hook] ${event.queue}: task ${event.task_id} gave up after ${attempts}`)
		return { fired: true, ok: false, attempts, status }
	} catch (e) {
		console.warn(`[queue-hook] ${event.queue}: ${e instanceof Error ? e.name : 'error'}`)
		return { fired: false, reason: 'error' }
	}
}
