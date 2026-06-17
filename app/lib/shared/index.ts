/**
 * Shared contracts for Bordmap (types, enums, geo helpers).
 *
 * Import from `#/lib/shared` (alias) or `@/lib/shared`. This barrel is the
 * single entry point the frontend and the Convex backend both consume so the
 * `route` contract never forks. Skeleton laid in L0; fleshed out in L2.
 */
export * from './enums'
export * from './geo'
export * from './route'
