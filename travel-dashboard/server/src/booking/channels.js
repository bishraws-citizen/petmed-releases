/**
 * Authorized booking channels.
 *
 * Ticketing is deliberately separated from the flight-search automation. That
 * automation is a *shopping* tool: it reads published fares from a public
 * website. Issuing a ticket is a different act with a different relationship
 * behind it — the agency needs ticketing authority, and the airline expects the
 * sale to arrive through a channel it recognises.
 *
 * Industry guidance supports agency sales through GDS and NDC channels, with
 * ticketing authority depending on the agency/airline relationship. So the
 * booking stage is modelled as a pluggable channel rather than "drive the
 * website harder": the same order can later be issued through an agent portal
 * by a human, through a GDS, or through an NDC connection (direct, via an
 * aggregator, or via a GDS), without the order model changing.
 *
 * Nothing here purchases a ticket. Automated channels are declared but not
 * connected, and say so rather than pretending.
 */

export class BookingChannelError extends Error {
  constructor(code, message, { channel = '', remediation = '' } = {}) {
    super(message);
    this.name = 'BookingChannelError';
    this.code = code;
    this.channel = channel;
    this.remediation = remediation;
  }
}

/**
 * @typedef {object} BookingChannel
 * @property {string} id
 * @property {string} label
 * @property {string} kind          'manual' | 'gds' | 'ndc'
 * @property {boolean} automated    can it issue without a person in the loop
 * @property {boolean} connected    is it actually wired up in this deployment
 * @property {string[]} requirements what an operator must have before enabling it
 * @property {(order, context) => Promise<object>} issue
 */

/** The only channel that works today: a person issues the ticket. */
const manualAgentPortal = {
  id: 'manual_agent_portal',
  label: 'Agent portal (issued by staff)',
  kind: 'manual',
  automated: false,
  connected: true,
  requirements: ['An agent login with the airline or consolidator'],
  description:
    'A consultant issues the ticket in the airline or consolidator portal and records the PNR here.',
  async issue() {
    // Nothing to automate here: a person issues the ticket and records the result.
    return {
      automated: false,
      requiresHuman: true,
      message: 'Issue the ticket in the agent portal, then record the PNR and ticket numbers on the order.',
    };
  },
};

const notConnected = (channel) => async () => {
  throw new BookingChannelError(
    'CHANNEL_NOT_CONNECTED',
    `${channel.label} is not connected in this deployment, so no ticket can be issued through it.`,
    {
      channel: channel.id,
      remediation: `Complete: ${channel.requirements.join('; ')}.`,
    },
  );
};

const gds = {
  id: 'gds',
  label: 'GDS (Amadeus / Sabre / Travelport)',
  kind: 'gds',
  automated: true,
  connected: false,
  requirements: [
    'A GDS agreement and office ID',
    'Ticketing authority for the marketing carrier',
    'GDS API credentials configured on the server',
  ],
  description:
    'Books and issues through the agency’s GDS. The order already carries everything a PNR build needs.',
};
gds.issue = notConnected(gds);

const ndc = {
  id: 'ndc',
  label: 'NDC (direct, aggregator, or via GDS)',
  kind: 'ndc',
  automated: true,
  connected: false,
  requirements: [
    'An NDC agreement with the airline, or onboarding with an NDC aggregator',
    'Seller credentials and an agency identifier the airline recognises',
    'A form of payment the airline accepts for NDC orders',
  ],
  description:
    'Airline-native offers and orders over NDC, reached directly, through an aggregator, or through a GDS.',
};
ndc.issue = notConnected(ndc);

const CHANNELS = new Map([
  [manualAgentPortal.id, manualAgentPortal],
  [gds.id, gds],
  [ndc.id, ndc],
]);

export const listChannels = () =>
  [...CHANNELS.values()].map(({ id, label, kind, automated, connected, requirements, description }) => ({
    id, label, kind, automated, connected, requirements, description,
  }));

export const getChannel = (id) => CHANNELS.get(id) ?? null;

/** The channel used when nobody picks one — always the human one. */
export const defaultChannelId = () => process.env.BOOKING_CHANNEL ?? manualAgentPortal.id;

/**
 * Hands an order to a channel. Automated channels refuse until connected, so a
 * deployment can never quietly believe it booked something it did not.
 */
export async function issueThroughChannel(channelId, order, context = {}) {
  const channel = getChannel(channelId);
  if (!channel) {
    throw new BookingChannelError('UNKNOWN_CHANNEL', `No booking channel named "${channelId}".`);
  }
  return channel.issue(order, context);
}
