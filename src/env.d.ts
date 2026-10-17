// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
interface Secrets {
  ENCRYPTION_KEY: string
  ADMIN_PASSWORD: string
}
interface CloudflareBindings extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}
