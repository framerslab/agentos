/** Explicit authenticated reference bootstrap; importing this entry never starts listening. */
export { createReferenceServer } from './server.js';
/** Host configuration and lifecycle handles. */
export type { ReferenceServerOptions, ReferenceServer } from './server.js';
/** Framework-neutral adapter for hosts reusing the reference HTTP routing contract. */
export { ReferenceRoutes, ReferenceHttpError } from './routes.js';
/** Parsed request, response and authorized route dependencies. */
export type { ReferenceRequest, ReferenceResponse, ReferenceRouteOptions } from './routes.js';
