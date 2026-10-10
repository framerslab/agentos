import { describe, expect, it } from 'vitest';

import { isPublicNetworkAddress } from '../networkAddress.js';

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
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
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
