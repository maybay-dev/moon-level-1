/**
 * WhisperPoll private state and witnesses.
 *
 * The only hidden state the contract needs is the caller's 32-byte secret key.
 * It is resolved on the user's machine when a circuit runs, enters the ZK
 * circuit as witness data, and is never disclosed on-chain.
 */

import { Ledger } from './managed/whisper-poll/contract/index.js';
import { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

/** The private state shape: just the voter/admin secret key. */
export type WhisperPollPrivateState = {
  readonly secretKey: Uint8Array;
};

export const createWhisperPollPrivateState = (secretKey: Uint8Array): WhisperPollPrivateState => ({
  secretKey,
});

/**
 * The witnesses object maps each witness declared in whisper-poll.compact to
 * its implementation. Every witness receives a WitnessContext (ledger,
 * privateState, contractAddress) and returns [newPrivateState, returnValue].
 */
export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, WhisperPollPrivateState>): [WhisperPollPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};
