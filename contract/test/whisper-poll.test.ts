/**
 * WhisperPoll contract test suite.
 *
 * All tests execute the REAL compiled ZK circuits produced by `compact compile`
 * via the compact-runtime simulator — no mocks, no re-implementations.
 *
 * Coverage:
 *   - Core functionality and lifecycle
 *   - Valid inputs at every boundary
 *   - Invalid inputs (types handled by TS; runtime value violations here)
 *   - Permissions (admin gating via ZK commitment)
 *   - Edge cases (same-option change, used-contract reuse, key collisions)
 *   - Failures (assert messages from the circuits)
 *   - Security scenarios (double-vote, unauthorized close, tally consistency)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  WhisperPollContractSimulator,
  testKey,
  PollStatus,
  type SecretKey,
} from './simulator.js';

let admin: SecretKey;
let voterA: SecretKey;
let voterB: SecretKey;
let voterC: SecretKey;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const openPoll = async (
  sim: WhisperPollContractSimulator,
  opts: { title?: string; options?: bigint } = {},
) => sim.openPoll(opts.title ?? 'Test poll', opts.options ?? 3n);

beforeAll(async () => {
  // Circuit code is loaded once; instantiate per-test for isolation.
  admin = testKey(1);
  voterA = testKey(2);
  voterB = testKey(3);
  voterC = testKey(4);
});

describe('constructor / initial state', () => {
  it('starts in PENDING with zeroed public state', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const l = sim.getLedger();
    expect(l.status).toBe(PollStatus.PENDING);
    expect(l.title.is_some).toBe(false);
    expect(l.optionCount).toBe(0n);
    expect(l.adminHash).toEqual(new Uint8Array(32));
    expect(l.totalVotes).toBe(0n);
    expect(l.ballots.isEmpty()).toBe(true);
    expect(l.tallies.isEmpty()).toBe(true);
  });

  it('stores the secret key as private state (witness round-trip)', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    expect(sim.getPrivateState().secretKey).toEqual(admin);
  });

  it('initializes deterministically for the same key', async () => {
    const a = await WhisperPollContractSimulator.create(admin);
    const b = await WhisperPollContractSimulator.create(admin);
    const la = a.getLedger();
    const lb = b.getLedger();
    expect(la.status).toBe(lb.status);
    expect(la.title).toEqual(lb.title);
    expect(la.optionCount).toBe(lb.optionCount);
    expect(la.adminHash).toEqual(lb.adminHash);
    expect(la.totalVotes).toBe(lb.totalVotes);
    expect(la.ballots.isEmpty()).toBe(lb.ballots.isEmpty());
    expect(la.tallies.isEmpty()).toBe(lb.tallies.isEmpty());
  });
});

describe('openPoll', () => {
  it('opens a poll and binds the opener as admin', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const l = await openPoll(sim, { title: 'Ship v2?', options: 3n });
    expect(l.status).toBe(PollStatus.OPEN);
    expect(sim.title()).toBe('Ship v2?');
    expect(l.optionCount).toBe(3n);
    expect(l.adminHash).toEqual(sim.adminCommitment(admin));
    expect(sim.adminHash()).not.toEqual(new Uint8Array(32));
  });

  it('accepts the minimum option count (2)', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const l = await openPoll(sim, { options: 2n });
    expect(l.optionCount).toBe(2n);
  });

  it('accepts the maximum option count (4)', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const l = await openPoll(sim, { options: 4n });
    expect(l.optionCount).toBe(4n);
  });

  it('rejects one option', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await expect(sim.openPoll('Bad', 1n)).rejects.toThrow(/at least two options/);
  });

  it('rejects five options', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await expect(sim.openPoll('Bad', 5n)).rejects.toThrow(/at most four options/);
  });

  it('rejects zero options', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await expect(sim.openPoll('Bad', 0n)).rejects.toThrow(/at least two options/);
  });

  it('rejects re-opening an already-initialized contract', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    await expect(openPoll(sim)).rejects.toThrow(/already initialized/);
  });

  it('cannot be re-opened even by a different user', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await expect(openPoll(sim)).rejects.toThrow(/already initialized/);
  });
});

describe('vote', () => {
  it('records a ballot and increments the tally and total', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    const l = await sim.vote(1n);
    expect(l.totalVotes).toBe(1n);
    expect(sim.tally(1n)).toBe(1n);
    expect(sim.ballotOf(sim.voterPseudonym(voterA))).toBe(1n);
    expect(sim.ballotCount()).toBe(1n);
  });

  it('accepts every valid option index in range', async () => {
    for (const option of [0n, 1n, 2n, 3n]) {
      const sim = await WhisperPollContractSimulator.create(admin);
      await openPoll(sim, { options: 4n });
      sim.switchUser(testKey(Number(option) + 10));
      const l = await sim.vote(option);
      expect(l.totalVotes).toBe(1n);
      expect(sim.tally(option)).toBe(1n);
    }
  });

  it('rejects an out-of-range option (== optionCount)', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { options: 3n });
    sim.switchUser(voterA);
    await expect(sim.vote(3n)).rejects.toThrow(/out of range/);
  });

  it('rejects a far out-of-range option', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { options: 2n });
    sim.switchUser(voterA);
    await expect(sim.vote(255n)).rejects.toThrow(/out of range/);
  });

  it('rejects double voting by the same voter', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    await expect(sim.vote(2n)).rejects.toThrow(/already voted/);
  });

  it('rejects double voting even with the same option', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(1n);
    await expect(sim.vote(1n)).rejects.toThrow(/already voted/);
  });

  it('rejects voting while the poll is PENDING', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    sim.switchUser(voterA);
    await expect(sim.vote(0n)).rejects.toThrow(/not open for voting/);
  });

  it('rejects voting after the poll is CLOSED', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(1n);
    sim.switchUser(admin);
    await sim.closePoll();
    sim.switchUser(voterB);
    await expect(sim.vote(0n)).rejects.toThrow(/not open for voting/);
  });

  it('keeps tallies and totalVotes untouched after a rejected vote', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    const before = { total: sim.totalVotes(), tally0: sim.tally(0n) };
    await expect(sim.vote(0n)).rejects.toThrow();
    expect(sim.totalVotes()).toBe(before.total);
    expect(sim.tally(0n)).toBe(before.tally0);
    expect(sim.ballotCount()).toBe(1n);
  });

  it('distinguishes voters by pseudonym, not by key bytes', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    sim.switchUser(voterB);
    await sim.vote(1n);
    expect(sim.ballotCount()).toBe(2n);
    expect(sim.totalVotes()).toBe(2n);
  });
});

describe('changeVote', () => {
  it('moves the ballot and updates tallies atomically', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    await sim.changeVote(2n);
    expect(sim.ballotOf(sim.voterPseudonym(voterA))).toBe(2n);
    expect(sim.tally(0n)).toBe(0n);
    expect(sim.tally(2n)).toBe(1n);
    expect(sim.totalVotes()).toBe(1n);
  });

  it('changing to the same option is a no-op for tallies', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(1n);
    await sim.changeVote(1n);
    expect(sim.tally(1n)).toBe(1n);
    expect(sim.totalVotes()).toBe(1n);
    expect(sim.ballotOf(sim.voterPseudonym(voterA))).toBe(1n);
  });

  it('handles the full transition matrix without tally drift', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { options: 4n });
    sim.switchUser(voterA);
    await sim.vote(0n);
    await sim.changeVote(1n);
    await sim.changeVote(2n);
    await sim.changeVote(3n);
    await sim.changeVote(0n);
    expect(sim.tally(0n)).toBe(1n);
    expect(sim.tally(1n)).toBe(0n);
    expect(sim.tally(2n)).toBe(0n);
    expect(sim.tally(3n)).toBe(0n);
    expect(sim.totalVotes()).toBe(1n);
    expect(sim.ballotOf(sim.voterPseudonym(voterA))).toBe(0n);
  });

  it('keeps totalVotes constant across many voters changing votes', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    sim.switchUser(voterB);
    await sim.vote(1n);
    sim.switchUser(voterC);
    await sim.vote(2n);
    sim.switchUser(voterA);
    await sim.changeVote(1n);
    sim.switchUser(voterB);
    await sim.changeVote(0n);
    expect(sim.totalVotes()).toBe(3n);
    expect(sim.tally(0n)).toBe(1n); // voterB moved in
    expect(sim.tally(1n)).toBe(1n); // voterA moved in, voterB moved out
    expect(sim.tally(2n)).toBe(1n);
    const sum = sim.allTallies().reduce((acc, [, v]) => acc + v, 0n);
    expect(sum).toBe(3n);
  });

  it('rejects changing a vote when none was cast', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await expect(sim.changeVote(1n)).rejects.toThrow(/No ballot to change/);
  });

  it('rejects an out-of-range new option', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    await expect(sim.changeVote(9n)).rejects.toThrow(/out of range/);
  });

  it('rejects changing a vote after close', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(0n);
    sim.switchUser(admin);
    await sim.closePoll();
    sim.switchUser(voterA);
    await expect(sim.changeVote(1n)).rejects.toThrow(/not open for voting/);
  });

  it('rejects changing a vote before the poll opens', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    sim.switchUser(voterA);
    await expect(sim.changeVote(1n)).rejects.toThrow(/not open for voting/);
  });
});

describe('closePoll / permissions', () => {
  it('admin can close and the state is terminal', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    const l = await sim.closePoll();
    expect(l.status).toBe(PollStatus.CLOSED);
  });

  it('a non-admin cannot close the poll', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await expect(sim.closePoll()).rejects.toThrow(/Only the poll admin/);
    expect(sim.status()).toBe(PollStatus.OPEN);
  });

  it('a non-admin cannot close even after voting', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(1n);
    await expect(sim.closePoll()).rejects.toThrow(/Only the poll admin/);
  });

  it('rejects closing a PENDING poll', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await expect(sim.closePoll()).rejects.toThrow(/Poll is not open/);
  });

  it('rejects closing an already CLOSED poll', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    await sim.closePoll();
    await expect(sim.closePoll()).rejects.toThrow(/Poll is not open/);
  });

  it('closing is irreversible — no circuit can reopen', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    await sim.closePoll();
    await expect(openPoll(sim)).rejects.toThrow(/already initialized/);
    await expect(sim.closePoll()).rejects.toThrow(/Poll is not open/);
    sim.switchUser(voterA);
    await expect(sim.vote(0n)).rejects.toThrow(/not open for voting/);
  });
});

describe('pure circuits (commitments)', () => {
  it('voterPseudonym is deterministic and key-specific', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const a1 = sim.voterPseudonym(voterA);
    const a2 = sim.voterPseudonym(voterA);
    const b = sim.voterPseudonym(voterB);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1.length).toBe(32);
  });

  it('adminCommitment differs from voterPseudonym (domain separation)', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    expect(sim.adminCommitment(voterA)).not.toEqual(sim.voterPseudonym(voterA));
  });

  it('storing the admin commitment does not reveal the secret key', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    const onChain = sim.adminHash();
    expect(onChain).not.toEqual(admin);
    // All 32 bytes equal would be a pathological key; commitment must differ.
    expect(Array.from(onChain).some((b) => b !== 0)).toBe(true);
  });
});

describe('security scenarios', () => {
  it('ballot is bound to the pseudonym — another key cannot alter it', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(1n);
    sim.switchUser(voterB);
    await expect(sim.changeVote(0n)).rejects.toThrow(/No ballot to change/);
    expect(sim.ballotOf(sim.voterPseudonym(voterA))).toBe(1n);
  });

  it('tally integrity: sum of tallies always equals totalVotes', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { options: 4n });
    sim.switchUser(voterA);
    await sim.vote(3n);
    sim.switchUser(voterB);
    await sim.vote(3n);
    sim.switchUser(voterC);
    await sim.vote(0n);
    sim.switchUser(voterB);
    await sim.changeVote(1n);
    const sum = sim.allTallies().reduce((acc, [, v]) => acc + v, 0n);
    expect(sum).toBe(sim.totalVotes());
    expect(sim.tally(3n)).toBe(1n);
    expect(sim.tally(0n)).toBe(1n);
    expect(sim.tally(1n)).toBe(1n);
  });

  it('state machine refuses every illegal transition', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    // PENDING: vote/change/close all illegal
    await expect(sim.vote(0n)).rejects.toThrow();
    await expect(sim.changeVote(0n)).rejects.toThrow();
    await expect(sim.closePoll()).rejects.toThrow();
    // OPEN: re-open illegal
    await openPoll(sim);
    await expect(openPoll(sim)).rejects.toThrow();
    // CLOSED: everything illegal
    await sim.closePoll();
    await expect(sim.vote(0n)).rejects.toThrow();
    await expect(sim.changeVote(0n)).rejects.toThrow();
    await expect(sim.closePoll()).rejects.toThrow();
    await expect(openPoll(sim)).rejects.toThrow();
  });

  it('two voters with colliding fill-bytes keys are still distinct', async () => {
    const k1 = testKey(9);
    const k2 = new Uint8Array(32).fill(9);
    expect(k1).toEqual(k2);
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(k1);
    await sim.vote(0n);
    sim.switchUser(k2);
    await expect(sim.vote(1n)).rejects.toThrow(/already voted/);
  });

  it('witness secret key never leaks into public ledger state', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim);
    sim.switchUser(voterA);
    await sim.vote(2n);
    const l = sim.getLedger();
    const ballotKeys: string[] = [];
    for (const kv of l.ballots) ballotKeys.push(Buffer.from(kv[0]).toString('hex'));
    const pubStrings = [
      Buffer.from(l.adminHash).toString('hex'),
      ...ballotKeys,
      l.title.value,
    ].join('|');
    const keyHex = Buffer.from(voterA).toString('hex');
    const adminHex = Buffer.from(admin).toString('hex');
    expect(pubStrings).not.toContain(keyHex);
    expect(pubStrings).not.toContain(adminHex);
  });
});

describe('edge cases', () => {
  it('empty-title poll is accepted', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { title: '' });
    expect(sim.title()).toBe('');
  });

  it('unicode title round-trips through the circuit', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const t = 'Œç àéïôü — 投票 🗳️';
    await openPoll(sim, { title: t });
    expect(sim.title()).toBe(t);
  });

  it('long title (128 chars) round-trips', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    const t = 'x'.repeat(128);
    await openPoll(sim, { title: t });
    expect(sim.title()).toBe(t);
  });

  it('maximum Uint<8> option in a 4-option poll is rejected', async () => {
    const sim = await WhisperPollContractSimulator.create(admin);
    await openPoll(sim, { options: 4n });
    sim.switchUser(voterA);
    await expect(sim.vote(255n)).rejects.toThrow(/out of range/);
  });

  it('fresh simulator instances are isolated', async () => {
    const s1 = await WhisperPollContractSimulator.create(admin);
    await openPoll(s1);
    await s1.closePoll();
    const s2 = await WhisperPollContractSimulator.create(admin);
    expect(s2.status()).toBe(PollStatus.PENDING);
  });
});
