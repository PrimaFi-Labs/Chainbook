// apps/listener/src/lib/walletTokens.ts

import { supabase } from '../config/supabase.js'
import { publicClientHttp } from '../config/chain.js'
import { toUsd } from './priceFeed.js'

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

export async function updateWalletTokenHolding(
  walletAddress: string,
  tokenAddress: string,
  decimals: number | null,
): Promise<void> {
  try {
    const balance = await publicClientHttp.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [walletAddress as `0x${string}`],
    })

    await supabase.from('wallet_token_holdings').upsert(
      {
        wallet_address: walletAddress.toLowerCase(),
        token_address: tokenAddress.toLowerCase(),
        balance_raw: balance.toString(),
        decimals: decimals ?? null,
        balance_usd: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'wallet_address,token_address' },
    )
  } catch (err) {
    console.error('[Holdings] Failed to update token holding:', err)
  }
}

export async function updateWalletNativeBalanceUsd(walletAddress: string): Promise<void> {
  try {
    const balance = await publicClientHttp.getBalance({
      address: walletAddress as `0x${string}`,
    })
    const usd = await toUsd(balance, 'somnia-network', 18)
    await supabase
      .from('wallets')
      .update({ wallet_balance_usd: usd })
      .eq('address', walletAddress.toLowerCase())
  } catch (err) {
    console.error('[Holdings] Failed to update native balance:', err)
  }
}

export async function upsertMintedToken(
  walletAddress: string,
  tokenAddress: string,
  kind: 'CREATED' | 'MINTED',
  txHash: string,
): Promise<void> {
  try {
    await supabase.from('minted_tokens').upsert(
      {
        wallet_address: walletAddress.toLowerCase(),
        token_address: tokenAddress.toLowerCase(),
        kind,
        tx_hash: txHash,
      },
      { onConflict: 'wallet_address,token_address,kind,tx_hash' },
    )
  } catch (err) {
    console.error('[MintedTokens] Failed to upsert minted token:', err)
  }
}