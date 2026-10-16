/**
 * @fileoverview The addresses a hosted destination may never resolve to: every block of IANA's IPv4 and IPv6
 * special-purpose address registries, multicast on both families, the deprecated site-local block, the IPv4-compatible
 * block, and every mapped or translated IPv6 form whatever address it embeds. The rule narrows the library's
 * public-address rule (`isPublicNetworkAddress`), which also refuses the IPv6 space outside 2000::/3 that IANA keeps
 * reserved, so an address it refuses is refused here too. A `net.BlockList` matches a subnet whatever the address's
 * spelling.
 *
 * @module safety/egress/addresses
 */
import { BlockList, isIP } from 'node:net';
import { isPublicNetworkAddress } from '../../io/media/images/networkAddress.js';

/** IPv4 blocks refused, as `[network, prefix]`. */
export const REFUSED_IPV4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** IPv6 blocks refused, as `[network, prefix]`. */
export const REFUSED_IPV6_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['100:0:0:1::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const V4 = new BlockList();
for (const [network, prefix] of REFUSED_IPV4_BLOCKS) V4.addSubnet(network, prefix, 'ipv4');
const V6 = new BlockList();
for (const [network, prefix] of REFUSED_IPV6_BLOCKS) V6.addSubnet(network, prefix, 'ipv6');

/**
 * True for an address outside every refused block that the library's public-address rule also takes; false for a
 * refused one and for anything that is not an address.
 */
export function isPublicAddress(address: string): boolean {
  // a scoped address (`fe80::1%eth0`) names an interface, never a public destination
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !V4.check(address, 'ipv4') && isPublicNetworkAddress(address);
  if (family === 6) return !V6.check(address, 'ipv6') && isPublicNetworkAddress(address);
  return false;
}
