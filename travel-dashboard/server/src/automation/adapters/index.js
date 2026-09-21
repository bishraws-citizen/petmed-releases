import { easyjetAdapter } from './easyjet.js';
import { mockAdapter } from './mock.js';

/** Every airline the module can search. One live target, plus the test double. */
const ADAPTERS = new Map([
  [easyjetAdapter.id, easyjetAdapter],
  [mockAdapter.id, mockAdapter],
]);

/** Which adapter a search uses when the caller does not name one. */
export const defaultAdapterId = () => process.env.FLIGHT_SEARCH_ADAPTER ?? 'easyjet';

export function getAdapter(id) {
  return ADAPTERS.get(id ?? defaultAdapterId()) ?? null;
}

export const listAdapters = () =>
  [...ADAPTERS.values()].map(({ id, label, airline, verified }) => ({
    id, label, airline, verified,
  }));
