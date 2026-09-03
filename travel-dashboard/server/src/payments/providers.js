import { readSettings } from '../pricing/settings.js';

/**
 * Payment providers.
 *
 * Two things are deliberately true of every provider here:
 *
 *  1. This application never collects card details. Card providers are reached
 *     through their own hosted checkout, so card numbers never touch this
 *     server and it stays out of PCI scope. There is no card form anywhere in
 *     this codebase, and adding one would be a mistake.
 *  2. A provider that is not configured refuses to create a payment rather than
 *     pretending. Only the manual rails — a bank transfer or cash at the desk —
 *     work out of the box, because those are the ones that need no integration.
 */

export class PaymentProviderError extends Error {
  constructor(code, message, { provider = '', remediation = '' } = {}) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
    this.provider = provider;
    this.remediation = remediation;
  }
}

const env = (name) => {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
};

const money = (minorUnits) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(minorUnits / 100);

/**
 * Bank transfer: the customer moves money and quotes the reference. The agency
 * confirms it landed. This is how most of these sales are actually paid for.
 */
const bankTransfer = {
  id: 'bank_transfer',
  label: 'Bank transfer',
  kind: 'manual',
  connected: true,
  /** Settlement is a person confirming the money arrived, not a callback. */
  automatic: false,
  requirements: [],
  description: 'The customer transfers the amount and quotes the payment reference.',

  createIntent({ intentReference, amountIqdCents, amountUsdCents }) {
    const settings = readSettings();
    const bank = {
      name: env('BANK_NAME') ?? settings.agency_name,
      account: env('BANK_ACCOUNT') ?? '(set BANK_ACCOUNT to show the account number)',
      iban: env('BANK_IBAN') ?? '',
      swift: env('BANK_SWIFT') ?? '',
    };

    const lines = [
      `Amount: ${money(amountIqdCents)} IQD (approximately $${money(amountUsdCents)} USD)`,
      `Payment reference: ${intentReference}`,
      '',
      `Bank: ${bank.name}`,
      `Account: ${bank.account}`,
    ];
    if (bank.iban) lines.push(`IBAN: ${bank.iban}`);
    if (bank.swift) lines.push(`SWIFT: ${bank.swift}`);
    lines.push(
      '',
      'Please quote the payment reference on the transfer so we can match it to your booking.',
      'Your seat is ticketed once the transfer is confirmed.',
    );

    return { instructions: lines.join('\n'), checkoutUrl: '' };
  },
};

/** Cash at the agency counter. */
const cashOffice = {
  id: 'cash_office',
  label: 'Cash at the agency',
  kind: 'manual',
  connected: true,
  automatic: false,
  requirements: [],
  description: 'The customer pays at the counter and a consultant records it.',

  createIntent({ intentReference, amountIqdCents }) {
    const settings = readSettings();
    return {
      instructions: [
        `Amount: ${money(amountIqdCents)} IQD`,
        `Payment reference: ${intentReference}`,
        '',
        `Pay at ${settings.agency_name}.`,
        settings.agency_phone ? `Call ${settings.agency_phone} to arrange a time.` : '',
        '',
        'Your seat is ticketed once payment is received.',
      ].filter(Boolean).join('\n'),
      checkoutUrl: '',
    };
  },
};

/**
 * Declared but not integrated. Each names what an operator must arrange, and
 * refuses to create a payment until the credentials actually exist. Their
 * settlement arrives as a signed webhook, which is why they are `automatic`.
 */
function declared({ id, label, kind, description, requirements, secretEnv }) {
  const provider = {
    id, label, kind, description, requirements,
    automatic: true,
    secretEnv,
    /**
     * Always false: no integration code exists to create a payment with these.
     * A signing secret only makes their *callbacks* verifiable, which is a
     * different thing — reporting them connected because a secret is set would
     * offer the employee a provider that then refuses.
     */
    connected: false,
    /** Whether inbound callbacks from this provider can be verified. */
    get webhookReady() {
      return Boolean(env(secretEnv));
    },
    createIntent() {
      throw new PaymentProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `${label} is not configured, so no payment can be taken through it.`,
        { provider: id, remediation: `Set ${secretEnv} and complete: ${requirements.join('; ')}.` },
      );
    },
  };
  return provider;
}

const card = declared({
  id: 'card_checkout',
  label: 'Card (hosted checkout)',
  kind: 'card',
  description:
    'Redirects the customer to the provider’s own payment page. Card details never reach this system.',
  requirements: [
    'A merchant account with a card acquirer or PSP',
    'API credentials and a webhook signing secret configured on the server',
    'The provider’s hosted checkout enabled so no card data is handled here',
  ],
  secretEnv: 'CARD_WEBHOOK_SECRET',
});

const wallet = declared({
  id: 'mobile_wallet',
  label: 'Mobile wallet / local payment rail',
  kind: 'wallet',
  description: 'A local wallet or bank app the customer already uses.',
  requirements: [
    'A merchant agreement with the wallet operator',
    'Merchant credentials and a webhook signing secret configured on the server',
  ],
  secretEnv: 'WALLET_WEBHOOK_SECRET',
});

const PROVIDERS = new Map([
  [bankTransfer.id, bankTransfer],
  [cashOffice.id, cashOffice],
  [card.id, card],
  [wallet.id, wallet],
]);

export const getProvider = (id) => PROVIDERS.get(id) ?? null;

export const listProviders = () =>
  [...PROVIDERS.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    connected: provider.connected,
    webhook_ready: provider.webhookReady ?? false,
    automatic: provider.automatic,
    requirements: provider.requirements,
    description: provider.description,
  }));

export const defaultProviderId = () => process.env.PAYMENT_PROVIDER ?? bankTransfer.id;

/**
 * The signing secret for a provider's webhooks. Absent means the webhook is
 * refused outright — an unverified callback must never be able to mark an
 * order paid.
 */
export const webhookSecretFor = (providerId) => {
  const provider = getProvider(providerId);
  return provider?.secretEnv ? env(provider.secretEnv) : null;
};
