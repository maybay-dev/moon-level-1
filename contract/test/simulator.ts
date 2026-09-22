/**
 * WhisperPollContractSimulator — drives the REAL compiled WhisperPoll circuits
 * (contract/src/managed/whisper-poll) through @midnight-ntwrk/compact-runtime.
 *
 * This is not a re-implementation of the contract: every state transition goes
 * through the actual ZK circuit code produced by `compact compile`, so tests
 * exercise exactly the business logic that runs on-chain.
 */

import {
  type CircuitContext,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  PollStatus,
  type Ledger,
} from '../src/managed/whisper-poll/contract/index.js';
import { witnesses, type WhisperPollPrivateState } from '../src/witnesses.js';

export { PollStatus };

/** 32-byte secret key material for a user. */
export type SecretKey = Uint8Array;

/** A deterministic key for tests: 32 bytes all equal to `fill`. */
export const testKey = (fill: number): SecretKey => new Uint8Array(32).fill(fill);

export class WhisperPollContractSimulator {
  readonly contract: Contract<WhisperPollPrivateState>;
  circuitContext!: CircuitContext<WhisperPollPrivateState>;

  private constructor(secretKey: SecretKey) {
    this.contract = new Contract<WhisperPollPrivateState>(witnesses);
    void secretKey;
  }

  /** Async factory: initializes the contract's ledger and private state. */
  static async create(secretKey: SecretKey): Promise<WhisperPollContractSimulator> {
    const sim = new WhisperPollContractSimulator(secretKey);
    await sim.reset(secretKey);
    return sim;
  }

  /** Re-initialize the contract state (fresh contract, fresh private state). */
  async reset(secretKey: SecretKey): Promise<void> {
    const ctorCtx = createConstructorContext({ secretKey }, '0'.repeat(64));
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      await this.contract.initialState(ctorCtx);
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      costModel: CostModel.initialCostModel(),
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
    };
  }

  /** Act as a different voter/admin by swapping the private secret key. */
  switchUser(secretKey: SecretKey): void {
    this.circuitContext.currentPrivateState = { secretKey };
  }

  getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  getPrivateState(): WhisperPollPrivateState {
    return this.circuitContext.currentPrivateState;
  }

  // ── Circuit wrappers ────────────────────────────────────────────────────

  async openPoll(title: string, options: bigint): Promise<Ledger> {
    this.circuitContext = (
      await this.contract.impureCircuits.openPoll(this.circuitContext, title, options)
    ).context;
    return this.getLedger();
  }

  async vote(option: bigint): Promise<Ledger> {
    this.circuitContext = (
      await this.contract.impureCircuits.vote(this.circuitContext, option)
    ).context;
    return this.getLedger();
  }

  async changeVote(newOption: bigint): Promise<Ledger> {
    this.circuitContext = (
      await this.contract.impureCircuits.changeVote(this.circuitContext, newOption)
    ).context;
    return this.getLedger();
  }

  async closePoll(): Promise<Ledger> {
    this.circuitContext = (
      await this.contract.impureCircuits.closePoll(this.circuitContext)
    ).context;
    return this.getLedger();
  }

  voterPseudonym(sk: SecretKey): Uint8Array {
    // pureCircuits are plain functions on the compiled module.
    return pureVoterPseudonym(sk);
  }

  adminCommitment(sk: SecretKey): Uint8Array {
    return pureAdminCommitment(sk);
  }

  // ── Read helpers over the generated ledger type ─────────────────────────

  status(): PollStatus {
    return this.getLedger().status;
  }

  title(): string | null {
    const t = this.getLedger().title;
    return t.is_some ? t.value : null;
  }

  optionCount(): bigint {
    return this.getLedger().optionCount;
  }

  adminHash(): Uint8Array {
    return this.getLedger().adminHash;
  }

  totalVotes(): bigint {
    return this.getLedger().totalVotes;
  }

  tally(option: bigint): bigint {
    const t = this.getLedger().tallies;
    return t.member(option) ? t.lookup(option) : 0n;
  }

  ballotOf(pseudonym: Uint8Array): bigint | null {
    const b = this.getLedger().ballots;
    return b.member(pseudonym) ? b.lookup(pseudonym) : null;
  }

  ballotCount(): bigint {
    return this.getLedger().ballots.size();
  }

  allTallies(): Array<[bigint, bigint]> {
    const t = this.getLedger().tallies;
    const out: Array<[bigint, bigint]> = [];
    for (const kv of t) out.push(kv as [bigint, bigint]);
    return out;
  }
}

// The pure circuits are module-level functions in the generated code.
import {
  pureCircuits,
} from '../src/managed/whisper-poll/contract/index.js';

const pureVoterPseudonym = (sk: Uint8Array): Uint8Array => pureCircuits.voterPseudonym(sk);
const pureAdminCommitment = (sk: Uint8Array): Uint8Array => pureCircuits.adminCommitment(sk);
