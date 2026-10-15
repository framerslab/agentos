/**
 * Checked egress: outbound HTTP to destinations a host does not control.
 *
 * @module safety/egress
 */
export { isPublicAddress, REFUSED_IPV4_BLOCKS, REFUSED_IPV6_BLOCKS } from './addresses.js';
export {
  checkDestination,
  checkedRequest,
  checkedStream,
  connectionOptions,
  EgressRefusedError,
  hostedEgressPolicy,
  localEgressPolicy,
  nodeConnector,
} from './CheckedEgress.js';
export type {
  AddressLookup,
  CheckedDestination,
  CheckedRequestInput,
  CheckedResponse,
  CheckedStreamResponse,
  EgressConnectRequest,
  EgressConnectResponse,
  EgressConnector,
  EgressPolicy,
  EgressProfile,
  EgressRefusal,
} from './CheckedEgress.js';
