/**
 * Headless WhisperPoll deployment to Midnight Preview/Preprod.
 *
 * Flow (mirrors the official Midnight examples):
 *   1. attach to the locally running proof server (docker compose)
 *   2. build a wallet from DEPLOY_SEED (or a persisted generated seed)
 *   3. print the unshielded address; if unfunded, wait while you visit the
 *      faucet website (funding is captcha-gated and intentionally manual)
 *   4. register NIGHT UTXOs for DUST generation and wait for fee DUST
 *   5. prove + submit the deploy transaction via the proof server
 *   6. write a deployment receipt to deploy/deployments/
 *
 * Secrets: the seed lives in DEPLOY_SEED or deploy/.seeds (git-ignored) and is
 * never logged; only a short fingerprint is printed.
 */

import {
  StaticProofServerContainer,
  MidnightWalletProvider,
  initializeMidnightProviders,
} from '@midnight-ntwrk/testkit-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { Logger } from 'pino';
import pino from 'pino';
import * as Rx from 'rxjs';
import fs from 'node:fs';
import path from 'node:path';

import { WhisperPollCompiledContract } from '@whisperpoll/contract';
import type { WhisperPollPrivateState } from '@whisperpoll/contract';
import { createWhisperPollPrivateState } from '@whisperpoll/contract';
import {
  FAUCET_URLS,
  checkProofServer,
  deploymentsDir,
  ensureDirs,
  envConfiguration,
  privateStateStoreName,
  resolveNetwork,
  resolveSeed,
  seedFingerprint,
  zkConfigPath,
  type NetworkName,
} from './config.js';

const baseLog: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * Wrap a logger so the wallet seed never reaches the console — including from
 * third-party code (the wallet SDK logs the master seed at info level).
 * Redaction is exact-match on the known seed value; other 64-hex values
 * (contract addresses, tx hashes) pass through untouched.
 */
function redactingLogger(base: Logger, secrets: string[]): Logger {
  const scrub = (msg: unknown): unknown => {
    if (typeof msg === 'string') {
      let out = msg;
      for (const s of secrets) {
        if (s && out.includes(s)) out = out.split(s).join(`${s.slice(0, 4)}…${s.slice(-4)}[REDACTED]`);
      }
      return out;
    }
    return msg;
  };
  const wrap =
    (fn: (...a: unknown[]) => void) =>
    (...a: unknown[]) =>
      fn(...a.map(scrub));
  return {
    ...base,
    info: wrap(base.info.bind(base)),
    warn: wrap(base.warn.bind(base)),
    error: wrap(base.error.bind(base)),
    debug: wrap(base.debug.bind(base)),
    trace: wrap(base.trace.bind(base)),
    fatal: wrap(base.fatal.bind(base)),
  } as Logger;
}

const randomSecretKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/** How many times to attempt the DUST-registration submission before giving up. */
const DUST_REGISTRATION_ATTEMPTS = 4;

/** Exponential backoff between submission attempts: 5s, 15s, 45s. */
const submissionBackoffMs = (attempt: number): number => 5_000 * 3 ** (attempt - 1);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function argValue(flag: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const network: NetworkName = resolveNetwork(argValue('--network'));
  const waitMinutes = Number(argValue('--wait-minutes') ?? '20');

  ensureDirs();
  setNetworkId(network);

  const env = envConfiguration(network);
  await checkProofServer(env.proofServer);
  baseLog.info(`Network: ${network} — proof server at ${env.proofServer}`);

  const proofServerContainer = new StaticProofServerContainer(6300);

  // 1-2. Wallet from persisted/env seed.
  const { seed, generated } = resolveSeed(network);
  const log = redactingLogger(baseLog, [seed]);
  log.info(
    `Wallet seed: ${seedFingerprint(seed)} (${generated ? 'generated, saved to deploy/.seeds' : 'from DEPLOY_SEED/.seeds'})`,
  );

  const walletProvider: MidnightWalletProvider = await MidnightWalletProvider.build(log, env, seed);
  await walletProvider.start(false); // no auto fund-wait; we orchestrate below

  try {
    const nightToken = unshieldedToken().raw;

    // 3. Addresses + funding.
    const state0 = await firstState(walletProvider);
    const unshieldedAddress = walletProvider.unshieldedKeystore.getBech32Address().asString();
    log.info(`Coin public key (shielded identity): ${state0.address.coinPublicKeyString()}`);
    log.info(`Unshielded address (fund this):     ${unshieldedAddress}`);

    // The unshielded view catches up asynchronously after start(), so reading the
    // balance straight away reports 0 for a wallet that is in fact funded.
    await waitForUnshieldedSync(log, walletProvider, 60_000);
    let balance = await currentBalance(walletProvider, nightToken);
    if (balance === 0n) {
      log.warn('Wallet has no NIGHT yet.');
      log.info('👉 Open the faucet, paste the address above, and request tokens:');
      log.info(`   ${FAUCET_URLS[network]}`);
      log.info(`Waiting up to ${waitMinutes} minute(s) for funds… (Ctrl-C to retry later; the seed is kept)`);
      try {
        balance = await waitForBalance(walletProvider, nightToken, waitMinutes * 60_000);
      } catch {
        balance = 0n; // timeout — handled below with a friendly message
      }
    }
    if (balance === 0n) {
      throw new Error(
        `No funds after waiting. Re-run this command after funding ${unshieldedAddress} via ${FAUCET_URLS[network]}.`,
      );
    }
    log.info(`NIGHT balance: ${balance}`);

    // 4. DUST (fee resource): register UTXOs, then wait for dust > 0.
    await registerDustUtxos(log, walletProvider, nightToken);
    await waitForDust(walletProvider, 10 * 60_000);

    // 5. Deploy.
    const providers = initializeMidnightProviders<
      'openPoll' | 'vote' | 'changeVote' | 'closePoll',
      WhisperPollPrivateState
    >(walletProvider, env, {
      privateStateStoreName: privateStateStoreName(),
      zkConfigPath: zkConfigPath(),
    });

    log.info('Proving and submitting deploy transaction (1-3 min)…');
    const deployed = await deployContract(providers, {
      compiledContract: WhisperPollCompiledContract,
      privateStateId: 'whisperpoll-private-state',
      initialPrivateState: createWhisperPollPrivateState(randomSecretKey()),
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    const deployTxHash = deployed.deployTxData.public.txHash;
    log.info(`✅ Contract deployed at: ${contractAddress}`);
    log.info(`   Deploy tx: ${deployTxHash}`);

    // 6. Receipt.
    const receipt = {
      product: 'WhisperPoll',
      network,
      contractAddress,
      deployTxHash,
      deployerCoinPublicKey: state0.address.coinPublicKeyString(),
      deployerUnshieldedAddress: unshieldedAddress,
      compiler: 'compact compile 0.31.1 (pragma language_version 0.23)',
      toolchain: {
        compactc: '0.31.1',
        '@midnight-ntwrk/compact-runtime': '0.16.0',
        '@midnight-ntwrk/midnight-js-*': '4.1.1',
      },
      endpoints: {
        indexer: env.indexer,
        node: env.node,
        proofServer: env.proofServer,
      },
      deployedAt: new Date().toISOString(),
    };
    const file = path.join(deploymentsDir(), `${network}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    log.info(`Receipt written: ${file}`);
    process.stdout.write(`\nWHISPERPOLL_CONTRACT_ADDRESS=${contractAddress}\n\n`);
  } finally {
    await walletProvider.stop();
  }
}

/** Snapshot of the wallet's facade state. */
async function firstState(walletProvider: MidnightWalletProvider) {
  return Rx.firstValueFrom(walletProvider.wallet.shielded.state);
}

/**
 * Best-effort wait for the unshielded view to finish catching up, so an already
 * funded wallet is not reported as empty. If it does not complete in time we log
 * and carry on — the funding wait below still resolves once the balance arrives.
 */
async function waitForUnshieldedSync(
  log: Logger,
  walletProvider: MidnightWalletProvider,
  timeoutMs: number,
): Promise<void> {
  try {
    await Rx.firstValueFrom(
      walletProvider.wallet.state().pipe(
        Rx.filter((st) => st.unshielded.progress?.isStrictlyComplete() === true),
        Rx.timeout({
          each: timeoutMs,
          with: () => Rx.throwError(() => new Error('unshielded-sync timeout')),
        }),
      ),
    );
  } catch {
    log.warn(
      `Unshielded view did not finish syncing within ${Math.round(timeoutMs / 1000)}s; ` +
        'continuing — if this wallet is funded the balance appears shortly.',
    );
  }
}

/** Current unshielded NIGHT balance (0 if unknown). */
async function currentBalance(walletProvider: MidnightWalletProvider, nightToken: string): Promise<bigint> {
  try {
    const st = await Rx.firstValueFrom(walletProvider.wallet.state());
    return st.unshielded.balances[nightToken] ?? 0n;
  } catch {
    return 0n;
  }
}

/** Subscribe once and resolve when the unshielded NIGHT balance is positive. */
async function waitForBalance(
  walletProvider: MidnightWalletProvider,
  nightToken: string,
  timeoutMs: number,
): Promise<bigint> {
  return Rx.firstValueFrom(
    walletProvider.wallet.state().pipe(
      Rx.map((st) => st.unshielded.balances[nightToken] ?? 0n),
      Rx.filter((b) => b > 0n),
      Rx.timeout({ each: timeoutMs, with: () => Rx.throwError(() => new Error('wait-for-funds timeout')) }),
    ),
  );
}

/**
 * Register unregistered NIGHT UTXOs for DUST generation.
 *
 * The node client disconnects its websocket right after a submission, so a submit
 * issued moments after wallet start can lose that race and fail with a transport
 * error ("disconnected … Normal Closure") rather than a rejection. The work is
 * idempotent — state is re-read each attempt, so a registration that did land ends
 * the loop — so retrying with backoff is safe and cheaper than a manual re-run.
 */
async function registerDustUtxos(
  log: Logger,
  walletProvider: MidnightWalletProvider,
  nightToken: string,
): Promise<void> {
  const wallet = walletProvider.wallet;
  const keystore = walletProvider.unshieldedKeystore;

  for (let attempt = 1; attempt <= DUST_REGISTRATION_ATTEMPTS; attempt++) {
    const st = await Rx.firstValueFrom(wallet.state());
    const unregistered = st.unshielded.availableCoins.filter(
      (c) => c.utxo.type === nightToken && c.meta.registeredForDustGeneration === false,
    );
    if (unregistered.length === 0) {
      log.info('All NIGHT UTXOs already registered for DUST generation.');
      return;
    }

    log.info(
      `Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation… ` +
        `(attempt ${attempt}/${DUST_REGISTRATION_ATTEMPTS})`,
    );
    try {
      const recipe = await wallet.registerNightUtxosForDustGeneration(
        unregistered,
        keystore.getPublicKey(),
        (payload) => keystore.signData(payload),
      );
      const tx = await wallet.finalizeRecipe(recipe);
      const txId = await wallet.submitTransaction(tx);
      log.info(`DUST registration tx: ${txId}`);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === DUST_REGISTRATION_ATTEMPTS) throw e;
      const delay = submissionBackoffMs(attempt);
      log.warn(
        `DUST registration submission failed (${msg}); retrying in ${Math.round(delay / 1000)}s…`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Wait until spendable DUST exists (fee resource).
 *
 * DUST is generated from registered NIGHT over time, so this can take a few
 * minutes on a public testnet. Progress is logged periodically (throttled) so a
 * slow accrual is distinguishable from a stalled wallet — the state stream is
 * otherwise silent and a hang looks identical to normal waiting.
 */
async function waitForDust(walletProvider: MidnightWalletProvider, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastLog = 0;
  const isComplete = (progress: unknown): boolean =>
    typeof (progress as { isStrictlyComplete?: unknown } | undefined)?.isStrictlyComplete === 'function'
      ? ((progress as { isStrictlyComplete: () => boolean }).isStrictlyComplete() as boolean)
      : false;
  await Rx.firstValueFrom(
    walletProvider.wallet.state().pipe(
      Rx.tap((st) => {
        const now = Date.now();
        if (now - lastLog < 15_000) return;
        lastLog = now;
        baseLog.info(
          `Waiting for spendable DUST… balance=${st.dust.balance(new Date())} ` +
            `dustSynced=${isComplete(st.dust.state.progress)} ` +
            `unshieldedSynced=${isComplete(st.unshielded.progress)} ` +
            `(${Math.round((now - startedAt) / 1000)}s elapsed)`,
        );
      }),
      Rx.map((st) => st.dust.balance(new Date())),
      Rx.filter((d) => d > 0n),
      Rx.timeout({ each: timeoutMs, with: () => Rx.throwError(() => new Error('wait-for-dust timeout')) }),
    ),
  );
  baseLog.info('DUST available.');
}

main().catch((e) => {
  baseLog.error(e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) baseLog.debug(e.stack);
  process.exit(1);
});
