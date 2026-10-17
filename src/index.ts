import { app } from './app'
import { handleDeliveryBatch } from './delivery/process'
import type { DeliveryMessage } from './delivery/mode'
import { runMaintenance } from './maintenance/maintenance'

export { SenderRpc } from './rpc'

export default {
  fetch: app.fetch,
  queue: (batch, env, _ctx) => handleDeliveryBatch(batch, env),
  scheduled: (_controller, env, ctx) => ctx.waitUntil(runMaintenance(env, (p) => ctx.waitUntil(p))),
} satisfies ExportedHandler<CloudflareBindings, DeliveryMessage>
