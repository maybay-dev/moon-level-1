/**
 * Interact with a deployed WhisperPoll contract (headless).
 *
 * Actions:
 *   open   — open the poll (first caller becomes admin)
 *   vote   — cast a ballot
 *   change — change your ballot
 *   close  — close the poll (admin only)
 *   tally  — read public ledger state (no transaction)
 *
 * The wallet seed comes from DEPLOY_SEED or deploy/.seeds/<network>.seed —
 * the same wallet that deployed (or voted before) keeps its identities.
 */

import {
  StaticProofServerContainer,
  MidnightWalletProvider,
  initializeMidnightProviders,
  syncWallet,
} from '@midnight-ntwrk/testkit-js';
import { findDeployedContract, deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import type { Logger } from 'pino';
import pino from 'pino';

import {
  ledger as whisperLedger,
  PollStatus,
  type Ledger,
} from '@whisperpoll/contract';
import type { WhisperPollPrivateState } from '@whisperpoll/contract';
import { WhisperPollCompiledContract, createWhisperPollPrivateState } from '@whisperpoll/contract';
import {
  checkProofServer,
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

const USAGE = `Usage:
  tsx scripts/interact.ts --network preview --contract <address> --action tally
  tsx scripts/interact.ts --network preview --contract <address> --action open  --title "Ship v2?" --options 3
  tsx scripts/interact.ts --network preview --contract <address> --action vote  --option 1
  tsx scripts/interact.ts --network preview --contract <address> --action change --option 2
  tsx scripts/interact.ts --network preview --contract <address> --action close
`;

interface Args {
  network: NetworkName;
  contract?: string;
  action: string;
  title?: string;
  options?: bigint;
  option?: bigint;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network = resolveNetwork(get('--network') ?? process.env.WHISPERPOLL_NETWORK);
  const action = get('--action') ?? 'tally';
  const contract = get('--contract');
  if (action !== 'deploy' && !contract) {
    process.stderr.write(USAGE);
    throw new Error('--contract is required for all actions except deploy');
  }
  return {
    network,
    contract,
    action,
    title: get('--title'),
    options: get('--options') ? BigInt(get('--options')!) : undefined,
    option: get('--option') ? BigInt(get('--option')!) : undefined,
  };
}

type CircuitIds = 'openPoll' | 'vote' | 'changeVote' | 'closePoll';

async function main(): Promise<void> {
  const args = parseArgs();
  setNetworkId(args.network);
  const env = envConfiguration(args.network);
  await checkProofServer(env.proofServer);

  const { seed } = resolveSeed(args.network);
  log.info(`Network: ${args.network} — seed ${seedFingerprint(seed)}`);

  const proofServerContainer = new StaticProofServerContainer(6300);
  const walletProvider = await MidnightWalletProvider.build(log, env, seed);
  await walletProvider.start();

  try {
    await syncWallet(walletProvider.wallet, 2000, 30_000).catch(() => undefined);

    const providers = initializeMidnightProviders<CircuitIds, WhisperPollPrivateState>(
      walletProvider,
      env,
      { privateStateStoreName: privateStateStoreName(), zkConfigPath: zkConfigPath() },
    );

    // ── tally: read-only, no wallet needed beyond sync ──────────────────
    if (args.action === 'tally') {
      const state = await providers.publicDataProvider.queryContractState(args.contract!);
      if (state == null) {
        log.info(`No contract state found at ${args.contract}`);
        return;
      }
      printLedger(whisperLedger(state.data));
      return;
    }

    // ── transactional actions ────────────────────────────────────────────
    const found = await findDeployedContract(providers, {
      contractAddress: args.contract!,
      compiledContract: WhisperPollCompiledContract,
      privateStateId: 'whisperpoll-private-state',
      initialPrivateState: createWhisperPollPrivateState(crypto.getRandomValues(new Uint8Array(32))),
    });

    switch (args.action) {
      case 'open': {
        if (args.options === undefined || args.title === undefined) {
          throw new Error('open requires --title and --options (2..4)');
        }
        const tx = await found.callTx.openPoll(args.title, args.options);
        log.info(`✅ Poll opened (tx ${tx.public.txHash})`);
        break;
      }
      case 'vote': {
        if (args.option === undefined) throw new Error('vote requires --option');
        const tx = await found.callTx.vote(args.option);
        log.info(`✅ Vote cast (tx ${tx.public.txHash})`);
        break;
      }
      case 'change': {
        if (args.option === undefined) throw new Error('change requires --option');
        const tx = await found.callTx.changeVote(args.option);
        log.info(`✅ Vote changed (tx ${tx.public.txHash})`);
        break;
      }
      case 'close': {
        const tx = await found.callTx.closePoll();
        log.info(`✅ Poll closed (tx ${tx.public.txHash})`);
        break;
      }
      case 'deploy': {
        const deployed = await deployContract(providers, {
          compiledContract: WhisperPollCompiledContract,
          privateStateId: 'whisperpoll-private-state',
          initialPrivateState: createWhisperPollPrivateState(crypto.getRandomValues(new Uint8Array(32))),
        });
        log.info(`✅ Deployed at ${deployed.deployTxData.public.contractAddress}`);
        break;
      }
      default:
        throw new Error(`Unknown action "${args.action}"`);
    }

    // Show final public state after the transaction.
    const state = await providers.publicDataProvider.queryContractState(args.contract!);
    if (state != null) printLedger(whisperLedger(state.data));
  } finally {
    await walletProvider.stop();
  }
}

function printLedger(l: Ledger): void {
  const statusName = PollStatus[l.status] ?? String(l.status);
  const lines: string[] = [
    `status      : ${statusName}`,
    `title       : ${l.title.is_some ? l.title.value : '(none)'}`,
    `options     : ${l.optionCount}`,
    `totalVotes  : ${l.totalVotes}`,
  ];
  const tallies: string[] = [];
  for (const kv of l.tallies) tallies.push(`  option ${kv[0]}: ${kv[1]}`);
  if (tallies.length) lines.push('tallies     :', ...tallies);
  lines.push(`adminHash   : ${toHex(l.adminHash).slice(0, 16)}…`);
  process.stdout.write('\n' + lines.join('\n') + '\n\n');
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) log.debug(e.stack);
  process.exit(1);
});
