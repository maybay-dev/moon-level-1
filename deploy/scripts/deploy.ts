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

const log: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const randomSecretKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

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
  log.info(`Network: ${network} — proof server at ${env.proofServer}`);

  const proofServerContainer = new StaticProofServerContainer(6300);

  // 1-2. Wallet from persisted/env seed.
  const { seed, generated } = resolveSeed(network);
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
    await registerDustUtxos(walletProvider, nightToken);
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

/** Register unregistered NIGHT UTXOs for DUST generation. */
async function registerDustUtxos(walletProvider: MidnightWalletProvider, nightToken: string): Promise<void> {
  const wallet = walletProvider.wallet;
  const st = await Rx.firstValueFrom(wallet.state());
  const unregistered = st.unshielded.availableCoins.filter(
    (c) => c.utxo.type === nightToken && c.meta.registeredForDustGeneration === false,
  );
  if (unregistered.length === 0) {
    log.info('All NIGHT UTXOs already registered for DUST generation.');
    return;
  }
  log.info(`Registering ${unregistered.length} NIGHT UTXO(s) for DUST generation…`);
  const keystore = walletProvider.unshieldedKeystore;
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    unregistered,
    keystore.getPublicKey(),
    (payload) => keystore.signData(payload),
  );
  const tx = await wallet.finalizeRecipe(recipe);
  const txId = await wallet.submitTransaction(tx);
  log.info(`DUST registration tx: ${txId}`);
}

/** Wait until spendable DUST exists (fee resource). */
async function waitForDust(walletProvider: MidnightWalletProvider, timeoutMs: number): Promise<void> {
  await Rx.firstValueFrom(
    walletProvider.wallet.state().pipe(
      Rx.map((st) => st.dust.balance(new Date())),
      Rx.filter((d) => d > 0n),
      Rx.timeout({ each: timeoutMs, with: () => Rx.throwError(() => new Error('wait-for-dust timeout')) }),
    ),
  );
  log.info('DUST available.');
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) log.debug(e.stack);
  process.exit(1);
});
