import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import type { MeetingFundingSnapshot, MeetingFundingSettlement, MeetingFundingPhase,
  CompositeMeetingEntitlementOptions, IDemoRunStore, DemoCapabilityOptions,
  MeetingManager, IEntitlementHook } from '@framers/agentos/io/channels/meetings';
import type { ICompoundCreditStore, SpendExpiryDecision } from '@framers/agentos/safety/runtime';
import type { EgressPolicy } from '@framers/agentos/safety/egress';
/** Installed declarations include the optional lifecycle and durable host contracts. */
export type HostContracts = [MeetingFundingSnapshot, MeetingFundingSettlement, MeetingFundingPhase,
  CompositeMeetingEntitlementOptions, IDemoRunStore, DemoCapabilityOptions,
  ICompoundCreditStore, SpendExpiryDecision, EgressPolicy, IEntitlementHook];
/** Preserve the released manager method as a callable member. */
export type LegacySend = MeetingManager['sendBot'];
const refuse = (): never => { throw new Error('package import attempted network access'); };
net.Socket.prototype.connect = refuse; http.request = refuse; http.get = refuse;
https.request = refuse; https.get = refuse;
// The declared types of dns.lookup and dns.resolve carry a __promisify__ member that a plain function lacks.
dns.lookup = refuse as unknown as typeof dns.lookup; dns.resolve = refuse as unknown as typeof dns.resolve;
globalThis.fetch = refuse; syncBuiltinESMExports();
const meetings = await import('@framers/agentos/io/channels/meetings');
const safety = await import('@framers/agentos/safety/runtime');
const egress = await import('@framers/agentos/safety/egress');
for (const name of ['MeetingManager', 'DemoRunCapability', 'InMemoryDemoRunStore',
  'CompositeMeetingEntitlement', 'meetingFundingUpgradeDdl', 'meetingStoresDdl']) {
  assert.equal(typeof (meetings as Record<string, unknown>)[name], 'function', name);
}
for (const name of ['reserveCompoundCredit', 'recordAttemptUsage', 'settleCompoundCredit',
  'releaseExpiredSpend', 'SqlSpendMeter', 'SqlCompoundCreditStore']) {
  assert.equal(typeof (safety as Record<string, unknown>)[name], 'function', name);
}
assert.equal(typeof egress.checkedRequest, 'function');
assert.equal(typeof egress.checkedStream, 'function');
assert.equal(typeof meetings.MeetingManager.prototype.sendBot, 'function');
console.log('installed meeting contracts pass');
