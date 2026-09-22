/**
 * Shared configuration and helpers for WhisperPoll deployment tooling.
 * Headless (non-interactive) — suitable for CI and repeatable deployments.
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export type NetworkName = 'preview' | 'preprod';

export const NETWORKS: Record<
  NetworkName,
  {
    indexer: string;
    indexerWS: string;
    node: string;
    nodeWS: string;
    faucet: string;
  }
> = {
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    nodeWS: 'wss://rpc.preview.midnight.network',
    faucet: 'https://faucet-0.preview.midnight.network',
  },
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    nodeWS: 'wss://rpc.preprod.midnight.network',
    faucet: 'https://faucet-0.preprod.midnight.network',
  },
};

/** Resolve the repo root (two levels above deploy/scripts). */
export const repoRoot = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..');

export const proofServerUrl = (): string =>
  process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';

export const zkConfigPath = (): string =>
  path.join(repoRoot, 'contract', 'src', 'managed', 'whisper-poll');

export const deploymentsDir = (): string => path.join(repoRoot, 'deploy', 'deployments');

export const privateStateStoreName = (): string => 'whisperpoll-private-state';

/** Secret material stays outside git (deploy/.seeds is git-ignored). */
export const seedsDir = (): string => path.join(repoRoot, 'deploy', '.seeds');

export function resolveNetwork(argvNetwork?: string): NetworkName {
  const n = (argvNetwork ?? process.env.WHISPERPOLL_NETWORK ?? 'preview').toLowerCase();
  if (n !== 'preview' && n !== 'preprod') {
    throw new Error(`Unknown network "${n}" — expected preview or preprod`);
  }
  return n;
}

/**
 * Resolve the deployer seed: DEPLOY_SEED env var wins; otherwise a seed is
 * generated once, persisted to deploy/.seeds/<network>.seed (chmod 600) and
 * reused on subsequent runs so the same wallet keeps its funds.
 */
export function resolveSeed(network: NetworkName): { seed: string; generated: boolean } {
  const env = process.env.DEPLOY_SEED?.trim();
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error('DEPLOY_SEED must be 64 hex characters (32 bytes)');
    }
    return { seed: env.toLowerCase(), generated: false };
  }
  fs.mkdirSync(seedsDir(), { recursive: true });
  const seedFile = path.join(seedsDir(), `${network}.seed`);
  if (fs.existsSync(seedFile)) {
    const seed = fs.readFileSync(seedFile, 'utf8').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(seed)) {
      throw new Error(`Corrupt seed file ${seedFile}`);
    }
    return { seed, generated: false };
  }
  const seed = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(seedFile, seed, { mode: 0o600 });
  return { seed, generated: true };
}

/** Never log the seed; print a short fingerprint instead. */
export const seedFingerprint = (seed: string): string =>
  `${seed.slice(0, 4)}…${seed.slice(-4)}`;

/** Build the testkit EnvironmentConfiguration for a network. */
export function envConfiguration(network: NetworkName) {
  const cfg = NETWORKS[network];
  return {
    walletNetworkId: network,
    networkId: network,
    indexer: cfg.indexer,
    indexerWS: cfg.indexerWS,
    node: cfg.node,
    nodeWS: cfg.nodeWS,
    faucet: cfg.faucet,
    proofServer: proofServerUrl(),
  };
}

export async function checkProofServer(url: string): Promise<void> {
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/health', { method: 'POST' });
    if (res.status >= 500) throw new Error(String(res.status));
  } catch {
    throw new Error(
      `Proof server not reachable at ${url}. Start it with:\n` +
        `  docker compose -f deploy/compose.proof-server.yml up -d\n` +
        `and wait ~30-60 s for "listening on 0.0.0.0:6300" in the logs.`,
    );
  }
}

export const ensureDirs = (): void => {
  fs.mkdirSync(deploymentsDir(), { recursive: true });
  fs.mkdirSync(seedsDir(), { recursive: true });
};
