/** Leave room under the Free plan's 50-query budget for auth, logging and maintenance. */
export const DIRECT_BATCH_LIMIT = 4
export const MAINTENANCE_SCAN_LIMIT = 20
export const EXPIRED_LEASE_LIMIT = 2
export const MAX_DISPATCHES = 12
export const DELIVERY_LIFETIME_MS = 24 * 60 * 60_000
