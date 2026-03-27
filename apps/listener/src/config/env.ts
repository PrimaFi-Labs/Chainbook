// apps/listener/src/config/env.ts

import * as dotenv from 'dotenv'
import * as path from 'path'

// Load from root .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') })

function require_env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function bool_env(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (value == null) return defaultValue
  return value.toLowerCase() !== 'false'
}

function csv_env(key: string): string[] {
  const value = process.env[key]
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export const env = {
  SOMNIA_RPC_HTTP:                       require_env('SOMNIA_RPC_HTTP'),
  SOMNIA_RPC_WS:                         require_env('SOMNIA_RPC_WS'),
  SOMNIA_REACTIVITY_WS:                  process.env.SOMNIA_REACTIVITY_WS,
  SUPABASE_URL:                          require_env('NEXT_PUBLIC_SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY:             require_env('SUPABASE_SERVICE_ROLE_KEY'),
  ACTIVITY_REGISTRY_ADDRESS:             require_env('NEXT_PUBLIC_ACTIVITY_REGISTRY_ADDRESS'),
  REPUTATION_ENGINE_ADDRESS:             require_env('NEXT_PUBLIC_REPUTATION_ENGINE_ADDRESS'),
  WHALE_THRESHOLD_USD:                   Number(process.env.WHALE_THRESHOLD_USD ?? '100000'),
  ALERT_LARGE_TRADE_USD:                 Number(process.env.ALERT_LARGE_TRADE_USD ?? '25000'),
  SIGNIFICANT_MIN_USD:                   Number(process.env.SIGNIFICANT_MIN_USD ?? '1000'),
  SIGNIFICANT_MIN_SCORE:                 Number(process.env.SIGNIFICANT_MIN_SCORE ?? '20'),
  TRENDING_REFRESH_INTERVAL_MS:          Number(process.env.TRENDING_REFRESH_INTERVAL_MS ?? '60000'),
  REPUTATION_UPDATE_INTERVAL_MS:         Number(process.env.REPUTATION_UPDATE_INTERVAL_MS ?? '300000'),
  LISTENER_BOOTSTRAP_BLOCKS:             Number(process.env.LISTENER_BOOTSTRAP_BLOCKS ?? '50'),
  LISTENER_POLL_INTERVAL_MS:             Number(process.env.LISTENER_POLL_INTERVAL_MS ?? '5000'),
  LISTENER_USE_WS:                       bool_env('LISTENER_USE_WS', true),
  // How long (ms) to remember a processed block before allowing reprocessing.
  // Prevents watchBlocks and the poll interval from double-processing the same block.
  LISTENER_BLOCK_DEDUP_TTL_MS:           Number(process.env.LISTENER_BLOCK_DEDUP_TTL_MS ?? '30000'),
  RPC_TIMEOUT_MS:                        Number(process.env.RPC_TIMEOUT_MS ?? '15000'),
  RPC_RETRY_COUNT:                       Number(process.env.RPC_RETRY_COUNT ?? '3'),
  RPC_RETRY_DELAY_MS:                    Number(process.env.RPC_RETRY_DELAY_MS ?? '1500'),
  TOKEN_METADATA_TTL_MS:                 Number(process.env.TOKEN_METADATA_TTL_MS ?? '3600000'),
  USE_TX_FROM_AS_WALLET:                 bool_env('USE_TX_FROM_AS_WALLET', true),
  NATIVE_TOKEN_SYMBOL:                   process.env.NATIVE_TOKEN_SYMBOL ?? 'STT',
  NATIVE_TOKEN_NAME:                     process.env.NATIVE_TOKEN_NAME ?? 'Somnia Test Token',
  SOMI_ORACLE_ADAPTER_ADDRESS:           process.env.SOMI_ORACLE_ADAPTER_ADDRESS,
  SOMI_ORACLE_DECIMALS:                  Number(process.env.SOMI_ORACLE_DECIMALS ?? '8'),
  REACTIVITY_CONTEXT:                    process.env.REACTIVITY_CONTEXT,
  REACTIVITY_ETH_CALLS_JSON:             process.env.REACTIVITY_ETH_CALLS_JSON,
  REACTIVITY_SPOTLIGHT_ENABLED:          bool_env('REACTIVITY_SPOTLIGHT_ENABLED', false),
  REACTIVITY_SPOTLIGHT_SOURCES:          csv_env('REACTIVITY_SPOTLIGHT_SOURCES'),
  REACTIVITY_SPOTLIGHT_TOPICS:           csv_env('REACTIVITY_SPOTLIGHT_TOPICS'),
  REACTIVITY_BALANCE_DELTA_ENABLED:      bool_env('REACTIVITY_BALANCE_DELTA_ENABLED', true),
  REACTIVITY_BALANCE_RPC_FALLBACK:       bool_env('REACTIVITY_BALANCE_RPC_FALLBACK', false),
  REACTIVITY_SIGNAL_MATCH_WAIT_MS:       Number(process.env.REACTIVITY_SIGNAL_MATCH_WAIT_MS ?? '1200'),
  REACTIVITY_SHOWCASE_HANDLER_ADDRESS:   process.env.REACTIVITY_SHOWCASE_HANDLER_ADDRESS,
  REACTIVITY_SHOWCASE_TOPIC0:            process.env.REACTIVITY_SHOWCASE_TOPIC0,
  MAX_CONCURRENT_RPC_CALLS:              Number(process.env.MAX_CONCURRENT_RPC_CALLS ?? '25'),
  MAX_CONCURRENT_DB_OPERATIONS:          Number(process.env.MAX_CONCURRENT_DB_OPERATIONS ?? '30'),
  PRICE_FEED_CACHE_TTL_MS:               Number(process.env.PRICE_FEED_CACHE_TTL_MS ?? '300000'),
  ENABLE_WALLET_TOKEN_TRACKING:          bool_env('ENABLE_WALLET_TOKEN_TRACKING', false),
  ENABLE_NOTIFICATIONS:                  bool_env('ENABLE_NOTIFICATIONS', false),
  NOTIFICATION_MIN_USD_THRESHOLD:        Number(process.env.NOTIFICATION_MIN_USD_THRESHOLD ?? '1000'),
  // How long (ms) to cache post source lookups in memory before re-reading from DB.
  // Eliminates the pre-upsert SELECT for duplicate events seen within this window.
  POST_SOURCE_CACHE_TTL_MS:              Number(process.env.POST_SOURCE_CACHE_TTL_MS ?? '120000'),
  // Minimum whole-token amount for unpriced ERC20 transfers to be logged as posts.
  // Transfers below this threshold are silently dropped. Does NOT affect MINT,
  // SWAP, NFT_TRADE, LIQUIDITY_*, DAO_VOTE, or CONTRACT_DEPLOY events.
  // STT-priced transfers use USD significance instead and bypass this check.
  ERC20_TRANSFER_MIN_AMOUNT:             Number(process.env.ERC20_TRANSFER_MIN_AMOUNT ?? '100'),
} as const