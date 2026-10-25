import { describe, expect, it } from 'vitest';

import { isPublicNetworkAddress, nat64PrefixesFrom, type Nat64Prefix } from '../networkAddress.js';

describe('isPublicNetworkAddress', () => {
  it.each([
    // IPv4: this network, private, carrier-grade NAT, loopback, link-local (cloud metadata),
    // the IETF block, documentation, benchmarking, multicast and broadcast.
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '192.88.99.2',
    '224.0.0.1',
    '255.255.255.255',
    // IPv6, and the IPv4 addresses it carries.
    '::',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    // The IPv4-compatible form is deprecated: not public whatever it carries.
    '::8.8.8.8',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '64:ff9b:0:1::808:808',
    '2002:c0a8:101::',
    '100::1',
    '2001:db8::1',
    // IETF protocol assignments: Teredo, benchmarking, ORCHID.
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '100:0:0:1::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    'fec0::1',
    'ff02::1',
    // Outside 2000::/3, the one block allocated for global unicast: space no
    // one has been given, which a network can still route to itself.
    '1::1',
    '4000::1',
    '8000::1',
    'e000::1',
    'fe00::1',
    // Not an IP address.
    'localhost',
    '',
    'not-an-address',
    '010.0.0.1',
    '1.2.3',
    '256.1.1.1',
  ])('%s is not public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    // Just outside the ranges that end or start nearby: 192.88.99.0/24, 2001::/23 and 3fff::/20.
    '192.88.98.255',
    '192.88.100.1',
    '2001:200::1',
    '3fff:1000::1',
    '2001:4860:4860::8888',
    '[2606:4700:4700::1111]',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::',
  ])('%s is public', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });
});

// A NAT64 prefix of a network's own (RFC 6052), in global space, at three of
// the six lengths: the IPv4 address sits right after the prefix and passes
// over byte 8.
const NAT64_32: Nat64Prefix = { bytes: [0x26, 0x07, 0xf8, 0xb0], length: 32 };
const NAT64_64: Nat64Prefix = { bytes: [0x26, 0x07, 0xf8, 0xb0, 0x01, 0x22, 0x03, 0x44], length: 64 };
const NAT64_96: Nat64Prefix = { bytes: [0x26, 0x07, 0xf8, 0xb0, 0x01, 0x22, 0x03, 0x44, 0, 0, 0, 0], length: 96 };

describe('isPublicNetworkAddress with the network\'s NAT64 prefixes', () => {
  it.each<[string, Nat64Prefix, string]>([
    ['2607:f8b0:a01:203::', NAT64_32, '10.1.2.3'],
    ['2607:f8b0:122:344:a9:fea9:fe00:0', NAT64_64, '169.254.169.254'],
    ['2607:f8b0:122:344::a9fe:a9fe', NAT64_96, '169.254.169.254'],
    ['2607:f8b0:122:344::7f00:1', NAT64_96, '127.0.0.1'],
  ])('%s is not public under a prefix that makes it %s', (address, prefix) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
    expect(isPublicNetworkAddress(address, { nat64Prefixes: [prefix] })).toBe(false);
  });

  it.each<[string, Nat64Prefix]>([
    // Carries 8.8.8.8.
    ['2607:f8b0:808:808::', NAT64_32],
    ['2607:f8b0:122:344::808:808', NAT64_96],
    // Under no prefix given: the same bytes mean nothing.
    ['2607:f8b1:a01:203::', NAT64_32],
    ['2001:4860:4860::8888', NAT64_96],
  ])('%s stays public', (address, prefix) => {
    expect(isPublicNetworkAddress(address, { nat64Prefixes: [prefix] })).toBe(true);
  });

  // A prefix only adds refusals: a resolver's answer never clears an address
  // its own range refuses, though it carries a public IPv4 address under it.
  it.each<[string, Nat64Prefix]>([
    // The local-use prefix 64:ff9b:1::/48 (RFC 8215), outside 2000::/3.
    ['64:ff9b:1::5db8:d70e', { bytes: [0, 0x64, 0xff, 0x9b, 0, 0x01, 0, 0, 0, 0, 0, 0], length: 96 }],
    // Unique local.
    ['fd00::5db8:d70e', { bytes: [0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], length: 96 }],
  ])('%s stays refused under a prefix that has it carry 93.184.215.14', (address, prefix) => {
    expect(isPublicNetworkAddress(address, { nat64Prefixes: [prefix] })).toBe(false);
  });

  it('takes an index for its second argument as no prefixes, as Array.prototype.every passes one', () => {
    expect(['8.8.8.8', '2001:4860:4860::8888'].every(isPublicNetworkAddress as (address: string) => boolean)).toBe(true);
  });
});

describe('nat64PrefixesFrom', () => {
  // 192.0.0.170, an address of ipv4only.arpa, under the six example prefixes
  // of RFC 6052, section 2.4, laid out as its table lays out 192.0.2.33.
  it.each<[string, number[], Nat64Prefix['length']]>([
    ['2001:db8:c000:aa::', [0x20, 0x01, 0x0d, 0xb8], 32],
    ['2001:db8:1c0:0:aa::', [0x20, 0x01, 0x0d, 0xb8, 0x01], 40],
    ['2001:db8:122:c000:0:aa00::', [0x20, 0x01, 0x0d, 0xb8, 0x01, 0x22], 48],
    ['2001:db8:122:3c0:0:aa::', [0x20, 0x01, 0x0d, 0xb8, 0x01, 0x22, 0x03], 56],
    ['2001:db8:122:344:c0:0:aa00::', [0x20, 0x01, 0x0d, 0xb8, 0x01, 0x22, 0x03, 0x44], 64],
    ['2001:db8:122:344::c000:aa', [0x20, 0x01, 0x0d, 0xb8, 0x01, 0x22, 0x03, 0x44, 0, 0, 0, 0], 96],
  ])('reads the prefix of %s', (address, bytes, length) => {
    expect(nat64PrefixesFrom([address])).toEqual([{ bytes, length }]);
  });

  it('reads the well-known prefix from both of the name\'s addresses once', () => {
    expect(nat64PrefixesFrom(['64:ff9b::c000:aa', '64:ff9b::c000:ab'])).toEqual([
      { bytes: [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], length: 96 },
    ]);
  });

  it('finds no prefix in an answer a DNS64 resolver did not make', () => {
    expect(nat64PrefixesFrom([])).toEqual([]);
    expect(nat64PrefixesFrom(['192.0.0.170', '2606:4700:4700::1111', 'fe80::1%en0', 'not an address'])).toEqual([]);
  });

  it('finds no prefix where byte 8, which the format keeps at zero, is not', () => {
    // The bytes after 2001:db8 spell 192.0.0.170 as a /32 prefix would carry
    // it, but byte 8 is 1: no DNS64 resolver made this address.
    expect(nat64PrefixesFrom(['2001:db8:c000:aa:100::'])).toEqual([]);
    // Under /96 byte 8 is part of the prefix itself.
    expect(nat64PrefixesFrom(['2001:db8:122:344:100::c000:aa'])).toEqual([
      { bytes: [0x20, 0x01, 0x0d, 0xb8, 0x01, 0x22, 0x03, 0x44, 0x01, 0, 0, 0], length: 96 },
    ]);
  });
});
