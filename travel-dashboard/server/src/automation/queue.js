/**
 * Runs search jobs one at a time.
 *
 * Each job drives a real browser, so running several at once would both exhaust
 * the server and hammer the airline. Serialising is also the polite thing to do
 * towards the site being searched.
 */
let tail = Promise.resolve();
let queued = 0;

export function enqueue(job) {
  queued += 1;
  const result = tail.then(job, job).finally(() => {
    queued -= 1;
  });
  // The chain must not break when a job rejects, or the queue would stall.
  tail = result.catch(() => {});
  return result;
}

export const queueDepth = () => queued;
