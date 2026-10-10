/**
 * @file networkAddress.ts
 * Whether an IP address is on the public internet, for code that fetches a
 * URL an untrusted source gave and must not reach this machine or the
 * networks it sits on.
 */

/**
 * Whether an IPv4 address, as its four numbers, is off the public internet:
 * "this network" (0/8), private (10/8, 172.16/12, 192.168/16), carrier-grade
 * NAT (100.64/10), loopback (127/8), link-local (169.254/16, where cloud
 * metadata services answer), the IETF protocol block (192.0.0/24), the 6to4
 * relay anycast block (192.88.99/24), the documentation (192.0.2/24,
 * 198.51.100/24, 203.0.113/24) and benchmarking (198.18/15) ranges, and
 * everything from 224.0.0.0 up: multicast, reserved and broadcast. The list
 * follows the IANA IPv4 Special-Purpose Address Registry's blocks that are
 * not globally reachable.
 */
function isNonPublicIPv4([a, b, c]: readonly number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/**
 * The four numbers of a dotted-decimal IPv4 address, or `undefined` when the
 * text is not one. A number with a leading zero is not read: some resolvers
 * take `010` as octal 8, others as decimal 10.
 */
function ipv4Parts(text: string): number[] | undefined {
  const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(text);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/** The eight 16-bit groups of an IPv6 address, or `undefined` when the text is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  // A trailing dotted IPv4 address (::ffff:1.2.3.4) is the last two groups.
  const dotted = /^(.*:)([^:]*\.[^:]*)$/.exec(text);
  if (dotted) {
    const parts = ipv4Parts(dotted[2]);
    if (!parts) return undefined;
    const [w, x, y, z] = parts;
    text = `${dotted[1]}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Whether an IPv6 address, as its eight groups, is off the public internet,
 * the IPv4 address it carries included: unspecified and loopback,
 * IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96), NAT64
 * (64:ff9b::/96 by the address it carries; 64:ff9b:1::/48 and the rest of
 * 64:ff9b::/32 outright), 6to4 (2002::/16), discard and dummy (100::/63),
 * the IETF protocol assignments (2001::/23, Teredo, benchmarking and ORCHID
 * among them), documentation (2001:db8::/32 and 3fff::/20), SRv6 segment
 * identifiers (5f00::/16), unique local (fc00::/7), link-local (fe80::/10),
 * site-local (fec0::/10) and multicast (ff00::/8). The list follows the IANA
 * IPv6 Special-Purpose Address Registry's blocks that are not globally
 * reachable; a few globally reachable anycast blocks inside 2001::/23 are
 * refused with the rest, since no image is served from them.
 */
function isNonPublicIPv6(groups: readonly number[]): boolean {
  const [g0, g1, g2, g3, , g5, g6, g7] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const carried = (high: number, low: number) => isNonPublicIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  if (zeros(0, 6)) return (g6 === 0 && g7 <= 1) || carried(g6, g7);
  if (zeros(0, 5) && g5 === 0xffff) return carried(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || !zeros(2, 6) || carried(g6, g7);
  if (g0 === 0x2002) return carried(g1, g2);
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 <= 1) return true;
  if (g0 === 0x2001 && (g1 <= 0x01ff || g1 === 0xdb8)) return true;
  if (g0 === 0x3fff && g1 <= 0x0fff) return true;
  if (g0 === 0x5f00) return true;
  return (
    (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00
  );
}

/**
 * Whether `address`, an IPv4 or IPv6 address as text, is on the public
 * internet: not this machine, a private or link-local network, or a
 * documentation, benchmarking, multicast or reserved range, and for an IPv6
 * address that carries an IPv4 one (IPv4-mapped, IPv4-compatible, NAT64,
 * 6to4), not one whose IPv4 address is any of those. Brackets around an IPv6
 * address are allowed. Text that is not an IP address is not public, and
 * neither is an IPv6 address with a zone (`fe80::1%en0`).
 *
 * @example
 * ```ts
 * isPublicNetworkAddress('8.8.8.8');            // true
 * isPublicNetworkAddress('169.254.169.254');    // false: link-local, cloud metadata
 * isPublicNetworkAddress('[::ffff:127.0.0.1]'); // false: loopback, IPv4-mapped
 * ```
 */
export function isPublicNetworkAddress(address: string): boolean {
  const text = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v4 = ipv4Parts(text);
  if (v4) return !isNonPublicIPv4(v4);
  if (!text.includes(':')) return false;
  const groups = ipv6Groups(text);
  return groups !== undefined && !isNonPublicIPv6(groups);
}
