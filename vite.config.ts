import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { cloudflare } from "@cloudflare/vite-plugin"

export default defineConfig(({ mode }) => {
	// Deployment-specific settings, read from the environment or a gitignored
	// .env.local so hostnames and keys stay out of the repo:
	// - WORKER_CUSTOM_DOMAIN: serve only on this domain (workers.dev is off)
	// - WORKER_SSH_PUBLIC_KEY: ssh-ed25519 key allowed to SSH into the
	//   container via `wrangler containers ssh <instance-id>`
	const env = { ...loadEnv(mode, process.cwd(), "WORKER_"), ...process.env }
	const customDomain = env.WORKER_CUSTOM_DOMAIN?.trim()
	// Keep only "<type> <key>", dropping the comment (user@host)
	const sshPublicKey = env.WORKER_SSH_PUBLIC_KEY?.trim().split(/\s+/).slice(0, 2).join(" ")

	return {
		base: "/_admin/",
		plugins: [
			react(),
			cloudflare({
				configPath: "./wrangler.jsonc",
				persistState: false,
				config: (workerConfig) => {
					// Mutate containers in place: returned arrays are concatenated
					// with the existing ones rather than replacing them
					if (sshPublicKey) {
						for (const container of workerConfig.containers ?? []) {
							container.ssh = { enabled: true }
							container.authorized_keys = [{ name: "deploy", public_key: sshPublicKey }]
						}
					}
					return customDomain
						? { workers_dev: false, routes: [{ pattern: customDomain, custom_domain: true }] }
						: undefined
				},
			}),
		],
	}
})
