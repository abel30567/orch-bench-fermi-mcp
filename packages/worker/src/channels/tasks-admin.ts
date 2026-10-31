import { countPendingTasks } from '../lib/task-store.ts'

/**
 * GET /admin/tasks/pending[?queue=<name>] — cheap "is there work?" check.
 * No param is the channel drain's wake signal (non-drain queues excluded);
 * ?queue=grok-bot lets a queue's own consumer skip work when it is empty.
 */
export async function handleAdminTasksPending(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('authorization') ?? ''
	const token = env.FERMI_BEARER_TOKEN
	if (!token || auth !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
	const queue = new URL(request.url).searchParams.get('queue') || undefined
	return Response.json({ pending: await countPendingTasks(env.FERMI_DB, queue) })
}
