import { countPendingTasks } from '../lib/task-store.ts'

/** Bearer-gated pending count: scoped by ?queue=, else the channel drain's wake signal. */
export async function handleTasksPending(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('authorization') ?? ''
	const token = env.FERMI_BEARER_TOKEN
	if (!token || auth !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
	const queue = new URL(request.url).searchParams.get('queue') ?? undefined
	return Response.json({ pending: await countPendingTasks(env.FERMI_DB, queue) })
}
