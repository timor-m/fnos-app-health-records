import { createUuid } from './uuid';

/** Keep the same key while retrying an unchanged form after a lost response. */
export function createSubmissionKey() {
  let previous: { signature: string; key: string } | undefined;
  return {
    forRequest(scope: string, payload: unknown) {
      const signature = JSON.stringify([scope, payload]);
      if (previous?.signature !== signature) previous = { signature, key: createUuid() };
      return previous.key;
    },
    reset() { previous = undefined; }
  };
}
