import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum PollStatus { PENDING = 0, OPEN = 1, CLOSED = 2 }

export type Witnesses<PS> = {
  localSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  openPoll(context: __compactRuntime.CircuitContext<PS>,
           newTitle_0: string,
           options_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  vote(context: __compactRuntime.CircuitContext<PS>, option_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  changeVote(context: __compactRuntime.CircuitContext<PS>, newOption_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  closePoll(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  openPoll(context: __compactRuntime.CircuitContext<PS>,
           newTitle_0: string,
           options_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  vote(context: __compactRuntime.CircuitContext<PS>, option_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  changeVote(context: __compactRuntime.CircuitContext<PS>, newOption_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  closePoll(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  voterPseudonym(sk_0: Uint8Array): Uint8Array;
  adminCommitment(sk_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  voterPseudonym(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  adminCommitment(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  openPoll(context: __compactRuntime.CircuitContext<PS>,
           newTitle_0: string,
           options_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  vote(context: __compactRuntime.CircuitContext<PS>, option_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  changeVote(context: __compactRuntime.CircuitContext<PS>, newOption_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  closePoll(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly status: PollStatus;
  readonly title: { is_some: boolean, value: string };
  readonly optionCount: bigint;
  readonly adminHash: Uint8Array;
  ballots: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  tallies: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): bigint;
    [Symbol.iterator](): Iterator<[bigint, bigint]>
  };
  readonly totalVotes: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
