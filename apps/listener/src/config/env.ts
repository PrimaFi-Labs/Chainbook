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
  SOMNIA_RPC_HTTP:                    require_env('SOMNIA_RPC_HTTP'),
  SOMNIA_RPC_WS:                      require_env('SOMNIA_RPC_WS'),
  SOMNIA_REACTIVITY_WS:               process.env.SOMNIA_REACTIVITY_WS,
  SUPABASE_URL:                       require_env('NEXT_PUBLIC_SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY:          require_env('SUPABASE_SERVICE_ROLE_KEY'),
  ACTIVITY_REGISTRY_ADDRESS:          require_env('NEXT_PUBLIC_ACTIVITY_REGISTRY_ADDRESS'),
  REPUTATION_ENGINE_ADDRESS:          require_env('NEXT_PUBLIC_REPUTATION_ENGINE_ADDRESS'),
  WHALE_THRESHOLD_USD:                Number(process.env.WHALE_THRESHOLD_USD ?? '100000'),
  ALERT_LARGE_TRADE_USD:              Number(process.env.ALERT_LARGE_TRADE_USD ?? '25000'),
  SIGNIFICANT_MIN_USD:                Number(process.env.SIGNIFICANT_MIN_USD ?? '1000'),
  SIGNIFICANT_MIN_SCORE:              Number(process.env.SIGNIFICANT_MIN_SCORE ?? '20'),
  TRENDING_REFRESH_INTERVAL_MS:       Number(process.env.TRENDING_REFRESH_INTERVAL_MS ?? '60000'),
  REPUTATION_UPDATE_INTERVAL_MS:      Number(process.env.REPUTATION_UPDATE_INTERVAL_MS ?? '300000'),
  LISTENER_BOOTSTRAP_BLOCKS:          Number(process.env.LISTENER_BOOTSTRAP_BLOCKS ?? '50'),
  LISTENER_POLL_INTERVAL_MS:          Number(process.env.LISTENER_POLL_INTERVAL_MS ?? '5000'),
  LISTENER_USE_WS:                    bool_env('LISTENER_USE_WS', true),
  RPC_TIMEOUT_MS:                     Number(process.env.RPC_TIMEOUT_MS ?? '15000'),
  RPC_RETRY_COUNT:                    Number(process.env.RPC_RETRY_COUNT ?? '3'),
  RPC_RETRY_DELAY_MS:                 Number(process.env.RPC_RETRY_DELAY_MS ?? '1500'),
  TOKEN_METADATA_TTL_MS:              Number(process.env.TOKEN_METADATA_TTL_MS ?? '3600000'),
  USE_TX_FROM_AS_WALLET:              bool_env('USE_TX_FROM_AS_WALLET', true),
  NATIVE_TOKEN_SYMBOL:                process.env.NATIVE_TOKEN_SYMBOL ?? 'STT',
  NATIVE_TOKEN_NAME:                  process.env.NATIVE_TOKEN_NAME ?? 'Somnia Test Token',
  SOMI_ORACLE_ADAPTER_ADDRESS:        process.env.SOMI_ORACLE_ADAPTER_ADDRESS,
  SOMI_ORACLE_DECIMALS:               Number(process.env.SOMI_ORACLE_DECIMALS ?? '8'),
  REACTIVITY_CONTEXT:                 process.env.REACTIVITY_CONTEXT,
  REACTIVITY_ETH_CALLS_JSON:          process.env.REACTIVITY_ETH_CALLS_JSON,
  REACTIVITY_SPOTLIGHT_ENABLED:       bool_env('REACTIVITY_SPOTLIGHT_ENABLED', false),
  REACTIVITY_SPOTLIGHT_SOURCES:       csv_env('REACTIVITY_SPOTLIGHT_SOURCES'),
  REACTIVITY_SPOTLIGHT_TOPICS:        csv_env('REACTIVITY_SPOTLIGHT_TOPICS'),
  REACTIVITY_BALANCE_DELTA_ENABLED:   bool_env('REACTIVITY_BALANCE_DELTA_ENABLED', true),
  REACTIVITY_BALANCE_RPC_FALLBACK:    bool_env('REACTIVITY_BALANCE_RPC_FALLBACK', false),
  REACTIVITY_SIGNAL_MATCH_WAIT_MS:    Number(process.env.REACTIVITY_SIGNAL_MATCH_WAIT_MS ?? '1200'),
  REACTIVITY_SHOWCASE_HANDLER_ADDRESS: process.env.REACTIVITY_SHOWCASE_HANDLER_ADDRESS,
  REACTIVITY_SHOWCASE_TOPIC0:         process.env.REACTIVITY_SHOWCASE_TOPIC0,
  // ===== Resource Optimization Flags =====
  ENABLE_WALLET_TOKEN_TRACKING:       bool_env('ENABLE_WALLET_TOKEN_TRACKING', false), // DISABLED by default (saves 30% RPC)
  ENABLE_NOTIFICATIONS:               bool_env('ENABLE_NOTIFICATIONS', false), // DISABLED by default (saves 25% DB)
  NOTIFICATION_MIN_USD_THRESHOLD:     Number(process.env.NOTIFICATION_MIN_USD_THRESHOLD ?? '5000'), // Only notify for $5k+
  MAX_CONCURRENT_RPC_CALLS:           Number(process.env.MAX_CONCURRENT_RPC_CALLS ?? '10'), // Concurrency limit
  MAX_CONCURRENT_DB_OPERATIONS:       Number(process.env.MAX_CONCURRENT_DB_OPERATIONS ?? '15'), // DB concurrency
  TOKEN_METADATA_TTL_MS:              Number(process.env.TOKEN_METADATA_TTL_MS ?? '86400000'), // 24h cache (up from 1h)
  PRICE_FEED_CACHE_TTL_MS:            Number(process.env.PRICE_FEED_CACHE_TTL_MS ?? '300000'), // 5m cache (up from 1m)
} as const
