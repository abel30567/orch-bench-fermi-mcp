import { countPendingTasks } from '../lib/task-store.ts'

/**
 * GET /admin/tasks/pending — without ?queue= this is the channel drain's wake
 * signal; with it, one queue's count so a consumer can skip work when empty.
 */
export async function handleTasksPending(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('authorization') ?? ''
	const token = env.FERMI_BEARER_TOKEN
	if (!token || auth !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
	const queue = new URL(request.url).searchParams.get('queue') ?? undefined
	return Response.json({ pending: await countPendingTasks(env.FERMI_DB, queue) })
}
