// Prints the boot fetch fragment for a pin, pointed at a local file:// mirror.
// Usage: bun render-fetch.ts '<pin json>' <baseUrl> <destDir>
import { runnerFetchScript } from '../../src/lib/runner-pin.ts'

const [pinJson, baseUrl, destDir] = process.argv.slice(2)
process.stdout.write(
	`${runnerFetchScript(JSON.parse(pinJson), { baseUrl, destDir, retries: 0 })}\n`,
)
