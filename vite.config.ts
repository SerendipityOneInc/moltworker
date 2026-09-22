import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { cloudflare } from "@cloudflare/vite-plugin"

export default defineConfig(({ mode }) => {
	// Optional custom domain, read from the environment or a gitignored
	// .env.local so deployment-specific hostnames stay out of the repo.
	// When set, the Worker is served only on that domain (workers.dev is off).
	const env = { ...loadEnv(mode, process.cwd(), "WORKER_"), ...process.env }
	const customDomain = env.WORKER_CUSTOM_DOMAIN?.trim()

	return {
		base: "/_admin/",
		plugins: [
			react(),
			cloudflare({
				configPath: "./wrangler.jsonc",
				persistState: false,
				config: customDomain
					? {
							workers_dev: false,
							routes: [{ pattern: customDomain, custom_domain: true }],
						}
					: undefined,
			}),
		],
	}
})
