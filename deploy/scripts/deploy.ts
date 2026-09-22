/**
 * Headless WhisperPoll deployment to Midnight Preview/Preprod.
 *
 * Flow:
 *   1. attach to the locally running proof server (docker compose)
 *   2. build a wallet from DEPLOY_SEED (or a persisted generated seed)
 *   3. request faucet funds and wait for NIGHT
 *   4. register NIGHT UTXOs for DUST generation (fee resource)
 *   5. prove + submit the deploy transaction
 *   6. write a deployment receipt to deploy/deployments/
 *
 * Secrets: the seed is read from env or deploy/.seeds (git-ignored). It is
 * never logged; only a short fingerprint is printed.
 */

import {
  StaticProofServerContainer,
  MidnightWalletProvider,
  initializeMidnightProviders,
  FaucetClient,
  syncWallet,
  getInitialUnshieldedState,
} from '@midnight-ntwrk/testkit-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { UnshieldedAddress as UnshieldedAddressClass } from '@midnight-ntwrk/wallet-sdk-address-format';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import type { Logger } from 'pino';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

import { WhisperPollCompiledContract } from '@whisperpoll/contract';
import type { WhisperPollPrivateState } from '@whisperpoll/contract';
import { createWhisperPollPrivateState } from '@whisperpoll/contract';
import {
  NETWORKS,
  checkProofServer,
  ensureDirs,
  deploymentsDir,
  envConfiguration,
  privateStateStoreName,
  resolveNetwork,
  resolveSeed,
  seedFingerprint,
  zkConfigPath,
  type NetworkName,
} from './config.js';

const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});

const randomSecretKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const networkArg = args.find((a) => a.startsWith('--network'))?.split('=')[1] ?? args[args.indexOf('--network') + 1];
  const network: NetworkName = resolveNetwork(networkArg === '--network' ? undefined : networkArg);

  ensureDirs();
  setNetworkId(network);

  const env = envConfiguration(network);
  await checkProofServer(env.proofServer);
  log.info(`Network: ${network} — proof server at ${env.proofServer}`);

  // 1. Attach to the externally managed proof server.
  const proofServerContainer = new StaticProofServerContainer(6300);

  // 2. Wallet (seed from env or persisted generated seed).
  const { seed, generated } = resolveSeed(network);
  log.info(`Wallet seed: ${seedFingerprint(seed)} (${generated ? 'generated, saved to deploy/.seeds' : 'from DEPLOY_SEED/.seeds'})`);

  const walletProvider: MidnightWalletProvider = await MidnightWalletProvider.build(log, env, seed);
  await walletProvider.start();

  try {
    // 3. Funds: faucet + wait.
    const unshieldedState0 = await getInitialUnshieldedState(walletProvider.wallet.unshielded);
    const addr = UnshieldedAddressClass.codec.encode(getNetworkId(), unshieldedState0.address);
    log.info(`Unshielded address: ${addr.toString()}`);

    const balance0 = unshieldedState0.balances[unshieldedToken().raw] ?? 0n;
    if (balance0 === 0n) {
      log.info(`Requesting funds from faucet ${env.faucet} …`);
      await new FaucetClient(env.faucet, log).requestTokens(addr.toString());
    }

    log.info('Waiting for NIGHT funds to be visible (this can take a couple of minutes)…');
    const nightBalance = await waitForBalance(walletProvider.wallet, env, log);
    log.info(`NIGHT balance: ${nightBalance}`);
    if (nightBalance === 0n) {
      throw new Error(
        `Wallet ${addr.toString()} has no NIGHT. Fund it via ${env.faucet} and re-run this script.`,
      );
    }

    // 4. DUST generation (fees) — register all unregistered UTXOs.
    await generateDust(log, walletProvider, seed);

    // 5. Providers + deploy.
    const providers = initializeMidnightProviders<'openPoll' | 'vote' | 'changeVote' | 'closePoll', WhisperPollPrivateState>(
      walletProvider,
      env,
      {
        privateStateStoreName: privateStateStoreName(),
        zkConfigPath: zkConfigPath(),
      },
    );

    log.info('Proving and submitting deploy transaction…');
    const deployed = await deployContract(providers, {
      compiledContract: WhisperPollCompiledContract,
      privateStateId: 'whisperpoll-private-state',
      initialPrivateState: createWhisperPollPrivateState(randomSecretKey()),
    });

    const contractAddress = deployed.deployTxData.public.contractAddress;
    const deployTxHash = deployed.deployTxData.public.txHash;
    const deployerAddress: string = walletProvider.getCoinPublicKey();
    log.info(`✅ Contract deployed at: ${contractAddress}`);
    log.info(`   Deploy tx: ${deployTxHash}`);

    // 6. Receipt.
    const receipt = {
      product: 'WhisperPoll',
      network,
      contractAddress,
      deployTxHash,
      deployerCoinPublicKey: deployerAddress,
      deployerUnshieldedAddress: addr.toString(),
      compiler: 'compact compile 0.31.1 (language_version 0.23)',
      toolchain: {
        compact: '0.31.1',
        'compact-runtime': '0.16.0',
        'midnight-js': '4.1.1',
      },
      endpoints: NETWORKS[network],
      proofServer: env.proofServer,
      deployedAt: new Date().toISOString(),
    };
    const file = path.join(deploymentsDir(), `${network}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    log.info(`Receipt written: ${file}`);
  } finally {
    await walletProvider.stop();
  }
}

/** Poll the wallet until the unshielded NIGHT balance is > 0 (or timeout). */
async function waitForBalance(
  wallet: WalletFacade,
  env: ReturnType<typeof envConfiguration>,
  log: Logger,
  timeoutMs = 10 * 60_000,
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await syncWallet(wallet).catch(() => undefined);
    const st = await getInitialUnshieldedState(wallet.unshielded);
    const b = st.balances[unshieldedToken().raw] ?? 0n;
    if (b > 0n) return b;
    log.info('… still waiting for funds');
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return 0n;
}

/** Register NIGHT UTXOs for DUST generation (the fee resource). */
async function generateDust(log: Logger, walletProvider: MidnightWalletProvider, seed: string): Promise<void> {
  const wallet = walletProvider.wallet;
  const dustState = await wallet.dust.waitForSyncedState();
  const unshieldedState = await getInitialUnshieldedState(wallet.unshielded);
  const utxos = unshieldedState.availableCoins.filter((c) => !c.meta.registeredForDustGeneration);
  if (utxos.length === 0) {
    log.info('No unregistered UTXOs — DUST generation already active.');
    return;
  }
  log.info(`Registering ${utxos.length} NIGHT UTXO(s) for DUST generation…`);
  const { createKeystore } = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
  const { HDWallet, Roles } = await import('@midnight-ntwrk/wallet-sdk-hd');
  const seedBuffer = Buffer.from(seed, 'hex');
  const hdResult = HDWallet.fromSeed(new Uint8Array(seedBuffer));
  if (hdResult.type !== 'seedOk') throw new Error('Invalid seed for HD derivation');
  const hd = hdResult.hdWallet;
  const derived = hd.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (derived.type === 'keyOutOfBounds') throw new Error('Key derivation out of bounds');
  const keystore = createKeystore(derived.key, getNetworkId());

  const recipe = await wallet.registerNightUtxosForDustGeneration(
    utxos,
    keystore.getPublicKey(),
    (payload) => keystore.signData(payload),
    dustState.address,
  );
  const tx = await wallet.finalizeRecipe(recipe);
  const txId = await wallet.submitTransaction(tx);
  log.info(`DUST registration submitted: ${txId}`);
  await syncWallet(wallet).catch(() => undefined);
}

main().catch((e) => {
  log.error(e instanceof Error ? `${e.message}` : e);
  if (e instanceof Error && e.stack) log.debug(e.stack);
  process.exit(1);
});
