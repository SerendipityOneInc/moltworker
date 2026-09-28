import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { cloudflare } from "@cloudflare/vite-plugin"

export default defineConfig(({ mode }) => {
	// Optional custom domains, read from the environment or a gitignored
	// .env.local so deployment-specific hostnames stay out of the repo.
	// - WORKER_CUSTOM_DOMAIN: the Worker is served only on that domain
	//   (workers.dev is off)
	// - WORKER_GATEWAY_WS_DOMAIN: extra domain that serves gateway WebSockets
	//   only, for native clients that can't pass Cloudflare Access
	//   (see src/routes/gateway-ws.ts)
	const env = { ...loadEnv(mode, process.cwd(), "WORKER_"), ...process.env }
	const customDomain = env.WORKER_CUSTOM_DOMAIN?.trim()
	const gatewayWsDomain = env.WORKER_GATEWAY_WS_DOMAIN?.trim()

	return {
		base: "/_admin/",
		plugins: [
			react(),
			cloudflare({
				configPath: "./wrangler.jsonc",
				persistState: false,
				config: {
					...(customDomain && {
						workers_dev: false,
						routes: [
							{ pattern: customDomain, custom_domain: true },
							...(gatewayWsDomain
								? [{ pattern: gatewayWsDomain, custom_domain: true }]
								: []),
						],
					}),
					...(gatewayWsDomain && { vars: { GATEWAY_WS_HOSTNAME: gatewayWsDomain } }),
				},
			}),
		],
	}
})
