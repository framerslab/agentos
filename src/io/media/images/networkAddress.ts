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
 * Whether an IPv6 address, as its eight groups, is off the public internet.
 *
 * Only 2000::/3 is allocated for global unicast (IANA, "Internet Protocol
 * Version 6 Address Space"), so everything outside it is refused: the
 * unspecified and loopback addresses, the deprecated IPv4-compatible form
 * (::/96), discard and dummy (100::/63), SRv6 segment identifiers
 * (5f00::/16), unique local (fc00::/7), link-local (fe80::/10), site-local
 * (fec0::/10), multicast (ff00::/8), and space no one has been given, which
 * a network can still route to itself. Two forms outside 2000::/3 reach an
 * IPv4 address and are judged by it: IPv4-mapped (::ffff:0:0/96) and the
 * NAT64 well-known prefix (64:ff9b::/96; the rest of 64:ff9b::/32, the
 * local-use 64:ff9b:1::/48 included, is refused).
 *
 * Inside 2000::/3 the special blocks of the IANA IPv6 Special-Purpose
 * Address Registry are refused: 6to4 (2002::/16) by the address it carries,
 * the IETF protocol assignments (2001::/23, Teredo, benchmarking and ORCHID
 * among them) and documentation (2001:db8::/32 and 3fff::/20) outright. A
 * few globally reachable anycast blocks inside 2001::/23 go with the rest,
 * since no image is served from them.
 */
function isNonPublicIPv6(groups: readonly number[]): boolean {
  const [g0, g1, , , , g5, g6, g7] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const carried = (high: number, low: number) => isNonPublicIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  if (zeros(0, 5) && g5 === 0xffff) return carried(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && zeros(2, 5)) return carried(g6, g7);
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2002) return carried(g1, groups[2]);
  if (g0 === 0x2001 && (g1 <= 0x01ff || g1 === 0xdb8)) return true;
  return g0 === 0x3fff && g1 <= 0x0fff;
}

/**
 * A NAT64 prefix (RFC 6052): an IPv6 address under it carries an IPv4
 * address, and the network's NAT64 gateway connects to that address. Besides
 * the well-known prefix 64:ff9b::/96 a network can use one of its own, which
 * looks like any other global address.
 */
export interface Nat64Prefix {
  /** The prefix's bytes: `length / 8` of them. */
  readonly bytes: readonly number[];
  /** The prefix's length in bits, one of the six RFC 6052 allows. */
  readonly length: 32 | 40 | 48 | 56 | 64 | 96;
}

/** The prefix lengths of RFC 6052, section 2.2. */
const NAT64_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;

/** The sixteen bytes of an IPv6 address, from its eight groups. */
function ipv6Bytes(groups: readonly number[]): number[] {
  return groups.flatMap((group) => [group >> 8, group & 255]);
}

/**
 * The IPv4 address that an IPv6 address carries under a NAT64 prefix of
 * `length` bits (RFC 6052, section 2.2): the four bytes that follow the
 * prefix, passing over byte 8, which the format keeps at zero.
 */
function embeddedIPv4(bytes: readonly number[], length: number): number[] {
  const parts: number[] = [];
  for (let index = length / 8; parts.length < 4; index += 1) {
    if (index !== 8) parts.push(bytes[index]);
  }
  return parts;
}

/**
 * The NAT64 prefixes that `addresses` reveal, when they are the IPv6
 * addresses a resolver gave for `ipv4only.arpa` (RFC 7050). That name has
 * two addresses, both IPv4: 192.0.0.170 and 192.0.0.171. An IPv6 answer was
 * therefore made by a DNS64 resolver, from the network's NAT64 prefix, and
 * the place of one of those two addresses in it gives the prefix and its
 * length. Byte 8 must be zero where the format reserves it (every length but
 * 96), so bytes that only happen to spell one of the two addresses around a
 * non-zero byte 8 name no prefix. Text that is not an IPv6 address is passed
 * over.
 *
 * @example
 * ```ts
 * nat64PrefixesFrom(['64:ff9b::c000:aa']); // [{ bytes: [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], length: 96 }]
 * nat64PrefixesFrom([]);                   // []: the network has no DNS64
 * ```
 */
export function nat64PrefixesFrom(addresses: readonly string[]): Nat64Prefix[] {
  const found = new Map<string, Nat64Prefix>();
  for (const address of addresses) {
    const groups = ipv6Groups(address.trim().toLowerCase());
    if (!groups) continue;
    const bytes = ipv6Bytes(groups);
    for (const length of NAT64_PREFIX_LENGTHS) {
      if (length !== 96 && bytes[8] !== 0) continue;
      const [a, b, c, d] = embeddedIPv4(bytes, length);
      if (a === 192 && b === 0 && c === 0 && (d === 170 || d === 171)) {
        const prefix = bytes.slice(0, length / 8);
        found.set(`${prefix.join('.')}/${length}`, { bytes: prefix, length });
      }
    }
  }
  return [...found.values()];
}

/** Options for {@link isPublicNetworkAddress}. */
export interface PublicNetworkAddressOptions {
  /**
   * NAT64 prefixes of the network the connection is made from, besides the
   * well-known one: an IPv6 address under one of them is public only when
   * the IPv4 address it carries is. {@link nat64PrefixesFrom} reads them
   * from a resolver's answer.
   */
  nat64Prefixes?: readonly Nat64Prefix[];
}

/**
 * Whether `address`, an IPv4 or IPv6 address as text, is on the public
 * internet: not this machine, a private or link-local network, or a
 * documentation, benchmarking, multicast, reserved or unallocated range, and
 * for an IPv6 address that carries an IPv4 one (IPv4-mapped, NAT64, 6to4),
 * not one whose IPv4 address is any of those. Brackets around an IPv6
 * address are allowed. Text that is not an IP address is not public, and
 * neither is an IPv6 address with a zone (`fe80::1%en0`).
 *
 * @param address - The address as text.
 * @param options - {@link PublicNetworkAddressOptions}: the network's own
 *   NAT64 prefixes, when it has any.
 *
 * @example
 * ```ts
 * isPublicNetworkAddress('8.8.8.8');            // true
 * isPublicNetworkAddress('169.254.169.254');    // false: link-local, cloud metadata
 * isPublicNetworkAddress('[::ffff:127.0.0.1]'); // false: loopback, IPv4-mapped
 * isPublicNetworkAddress('4000::1');            // false: outside 2000::/3
 * ```
 */
export function isPublicNetworkAddress(address: string, options: PublicNetworkAddressOptions = {}): boolean {
  const text = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v4 = ipv4Parts(text);
  if (v4) return !isNonPublicIPv4(v4);
  if (!text.includes(':')) return false;
  const groups = ipv6Groups(text);
  if (groups === undefined || isNonPublicIPv6(groups)) return false;
  // A second argument that is not an options object (an index, when the
  // function is passed to Array.prototype.every) names no prefix.
  const prefixes = options?.nat64Prefixes;
  if (!prefixes?.length) return true;
  const bytes = ipv6Bytes(groups);
  return !prefixes.some(
    (prefix) =>
      prefix.bytes.every((byte, index) => bytes[index] === byte) &&
      isNonPublicIPv4(embeddedIPv4(bytes, prefix.length)),
  );
}
