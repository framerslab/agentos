/** One synthetic transcript, the meanings a grounded answer keeps, and answers that must pass or fail. */
export interface GroundingFixture {
  id: string;
  source: string;
  required: readonly string[];
  accepted: readonly string[];
  rejected: readonly string[];
}

/** The public synthetic fixtures for semantic acceptance; their first names are fixtures, not account data. */
export const GROUNDING_FIXTURES: readonly GroundingFixture[] = [
  {
    id: 'unowned-review',
    source: [
      '[1] Dana: The launch is planned for Friday at 14:00, but it is not approved.',
      '[2] Sam: We still need the security review. Nobody has agreed to own it.',
      '[3] Dana: Who will own the security review? We have no answer yet.',
    ].join('\n'),
    required: [
      'Friday at 14:00 is a plan, not an approval.',
      'The security review remains needed and unowned.',
      'The question about its owner is still unanswered.',
    ],
    accepted: [
      'The launch is planned for Friday at 14:00 and is not approved. The security review is still needed and nobody has agreed to own it. Who will own it is still unanswered.',
      'Open question: who will own the security review? There is no answer yet and nobody has agreed to own it. The review is still needed. The launch is planned for Friday at 14:00 and is not approved.',
    ],
    rejected: [
      'The launch is planned for Friday at 14:00 and is not approved. The security review is still needed and has no owner. Suggestion: hire an outside reviewer.',
      'The launch is planned for Friday at 14:00 and is not approved. Dana will own the security review.',
    ],
  },
  {
    id: 'conditional-invoice',
    source: [
      '[1] Dana: We will send the invoice only after the payment arrives.',
      '[2] Sam: The payment has not arrived. Its arrival date is unknown.',
      '[3] Dana: The invoice is for 240 dollars. There is no agreed deadline for sending it.',
    ].join('\n'),
    required: [
      'Payment must arrive before the invoice is sent.',
      'Payment has not arrived and its date remains unknown.',
      'The invoice is for 240 dollars and has no agreed sending deadline.',
    ],
    accepted: [
      'The invoice will be sent only after the payment arrives. The payment has not arrived and its arrival date is unknown. The invoice is for 240 dollars, and no deadline for sending it has been agreed.',
      'The invoice is for 240 dollars. It will be sent only once the payment has arrived; the payment has not arrived and its arrival date is unknown. There is no agreed deadline for sending the invoice.',
    ],
    rejected: [
      'The invoice will be sent only after the payment arrives. The payment has not arrived, its date is unknown and no sending deadline is agreed. Recommendation: add a late-payment fee.',
      'The invoice will be sent before the payment arrives. The payment has not arrived, its date is unknown and there is no agreed deadline.',
    ],
  },
];
