import { countPendingTasks } from './task-store.ts'

/**
 * GET /admin/tasks/pending[?queue=<name>] — cheap "is there work?" check.
 * Without a queue it is the channel drain's wake signal (non-drain queues
 * excluded); with one it counts only that queue (e.g. grok-bot).
 */
export async function handleAdminTasksPending(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('authorization') ?? ''
	const token = env.FERMI_BEARER_TOKEN
	if (!token || auth !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
	const queue = new URL(request.url).searchParams.get('queue') || undefined
	return Response.json({ pending: await countPendingTasks(env.FERMI_DB, queue) })
}
