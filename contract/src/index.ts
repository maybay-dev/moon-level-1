/**
 * Binds the compiled WhisperPoll contract to its witness implementations for
 * use with @midnight-ntwrk/midnight-js (deployment / callTx).
 */

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import * as CompiledWhisperPoll from './managed/whisper-poll/contract/index.js';
import * as Witnesses from './witnesses.js';

export * from './managed/whisper-poll/contract/index.js';
export * from './witnesses.js';

export const WhisperPollCompiledContract = CompiledContract.make<
  CompiledWhisperPoll.Contract<Witnesses.WhisperPollPrivateState>
>('WhisperPoll', CompiledWhisperPoll.Contract).pipe(
  CompiledContract.withWitnesses(Witnesses.witnesses),
  CompiledContract.withCompiledFileAssets('./managed/whisper-poll'),
);
