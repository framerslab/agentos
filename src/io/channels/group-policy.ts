/**
 * Pure group-chat policy evaluation. No I/O, no LLM calls.
 *
 * Enforcement points: ChannelRouter.handleInboundMessage (core inbound path)
 * and host security gates that receive group context (e.g. chat responders).
 * DMs bypass policy entirely; group/channel/thread conversations are gated by
 * activation mode, allow/deny lists, and always-on loop protections.
 */
import type { GroupPolicy } from './types.js';

export type { GroupPolicy, GroupActivation } from './types.js';

/** Inputs the evaluator needs about one inbound message. */
export interface GroupPolicyInput {
  /** True for group/channel/thread conversations; DMs bypass policy. */
  isGroup: boolean;
  /** Platform-native sender ID. */
  senderId: string;
  /** Platform marks the sender as a bot/automated account. */
  senderIsBot: boolean;
  /** Mentioned platform user IDs, if the adapter extracts them. */
  mentions: string[] | undefined;
  /** Adapter reliably populates `mentions`. */
  supportsMentions: boolean;
  /** The agent's own platform user ID (self-echo guard), when known. */
  botUserId?: string;
  /** Owner from the binding config, when present. */
  bindingOwnerUserId?: string;
}

/** Machine-readable drop reasons (audit-logged, never sent to the sender). */
export type GroupPolicyReason =
  | 'self-echo'
  | 'bot-loop-protection'
  | 'deny-list'
  | 'not-on-allow-list'
  | 'mention-required'
  | 'mention-gating-unsupported'
  | 'owner-only'
  | 'owner-unconfigured';

export interface GroupPolicyResult {
  verdict: 'allow' | 'drop';
  reason?: GroupPolicyReason;
}

const ALLOW: GroupPolicyResult = { verdict: 'allow' };
const drop = (reason: GroupPolicyReason): GroupPolicyResult => ({ verdict: 'drop', reason });

/**
 * Evaluate an inbound group message against a policy. `policy` may be
 * undefined (legacy bindings): activation is treated as 'always' and only the
 * always-on protections (self-echo, bot-loop) apply.
 */
export function evaluateGroupPolicy(
  policy: GroupPolicy | undefined,
  input: GroupPolicyInput
): GroupPolicyResult {
  if (!input.isGroup) return ALLOW;

  // Always-on protections (even with no policy configured).
  if (input.botUserId && input.senderId === input.botUserId) return drop('self-echo');
  const loopProtection = policy?.botLoopProtection !== false;
  if (loopProtection && input.senderIsBot) return drop('bot-loop-protection');

  if (!policy) return ALLOW;

  if (policy.denyFrom?.includes(input.senderId)) return drop('deny-list');
  if (policy.allowFrom && policy.allowFrom.length > 0 && !policy.allowFrom.includes(input.senderId)) {
    return drop('not-on-allow-list');
  }

  switch (policy.activation) {
    case 'always':
      return ALLOW;
    case 'mention': {
      // Mentions can only be gated when the adapter reports mention support AND
      // we know the agent's own platform user id to match against. Missing
      // either means we cannot evaluate mention gating — fail closed as
      // "unsupported" rather than the misleading "mention-required".
      if (!input.supportsMentions || !input.botUserId) return drop('mention-gating-unsupported');
      const mentioned = (input.mentions ?? []).includes(input.botUserId);
      return mentioned ? ALLOW : drop('mention-required');
    }
    case 'owner-only': {
      const owners = [input.bindingOwnerUserId, ...(policy.ownerIds ?? [])].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      );
      if (owners.length === 0) return drop('owner-unconfigured');
      return owners.includes(input.senderId) ? ALLOW : drop('owner-only');
    }
  }
}
