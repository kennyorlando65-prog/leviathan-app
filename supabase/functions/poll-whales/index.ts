import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ETH_RPC = Deno.env.get('ETH_RPC_URL')!;
const BASE_RPC = Deno.env.get('BASE_RPC_URL')!;
const SOL_RPC = Deno.env.get('SOL_RPC_URL')!;
const COINGECKO_KEY = Deno.env.get('COINGECKO_API_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;
const PREMIUM_THRESHOLD_USD = 100_000;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const priceCache: Record<string, { price: number; ts: number }> = {};

async function getPrice(symbol: string): Promise<number> {
  const now = Date.now();
  if (priceCache[symbol] && now - priceCache[symbol].ts < 60_000) return priceCache[symbol].price;
  const ids: Record<string,string> = { ETH:'ethereum',USDT:'tether',USDC:'usd-coin',SOL:'solana',WETH:'weth',BTC:'bitcoin',WBTC:'wrapped-bitcoin' };
  const id = ids[symbol.toUpperCase()] ?? symbol.toLowerCase();
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_KEY}`);
    const d = await r.json();
    const price = d[id]?.usd ?? 0;
    priceCache[symbol] = { price, ts: now };
    return price;
  } catch { return priceCache[symbol]?.price ?? 0; }
}

async function isSeen(txHash: string, chain: string): Promise<boolean> {
  const { data } = await supabase.from('seen_transactions').select('tx_hash').eq('tx_hash', txHash).eq('chain', chain).maybeSingle();
  return !!data;
}

async function markSeen(txHash: string, chain: string) {
  await supabase.from('seen_transactions').insert({ tx_hash: txHash, chain });
}

async function getLabel(address: string, chain: string) {
  const { data } = await supabase.from('wallet_labels').select('label,name').eq('address', address.toLowerCase()).eq('chain', chain).maybeSingle();
  return { label: data?.label ?? 'unknown', name: data?.name ?? null };
}

function computeSignal(fromLabel: string, toLabel: string, amountUsd: number) {
  const boost = Math.min(35, Math.floor(amountUsd / 1_000_000) * 5);
  if (toLabel === 'cex' && fromLabel !== 'cex') return { signal: 'sell_pressure', confidence_pct: Math.min(95, 60 + boost) };
  if (fromLabel === 'cex' && toLabel !== 'cex') return { signal: 'accumulation', confidence_pct: Math.min(95, 60 + boost) };
  return { signal: 'neutral', confidence_pct: 50 };
}

async function checkCluster(chain: string, symbol: string, amountUsd: number) {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase.from('whale_events').select('id,amount_usd').eq('chain', chain).eq('token_symbol', symbol).gte('occurred_at', since).gte('amount_usd', PREMIUM_THRESHOLD_USD);
  if (data && data.length >= 2) {
    const total = data.reduce((s, e) => s + Number(e.amount_usd), 0) + amountUsd;
    const { data: c } = await supabase.from('cluster_events').insert({ chain, token_symbol: symbol, total_usd: total, event_count: data.length + 1, signal: 'cluster', confidence_pct: Math.min(95, 70 + data.length * 5) }).select('id').single();
    return c?.id ?? null;
  }
  return null;
}

async function saveEvent(evt: Record<string, unknown>) {
  const { error } = await supabase.from('whale_events').insert(evt);
  if (error && !error.message.includes('duplicate')) console.error('insert:', error.message);
}

async function pollEVM(chain: 'ethereum' | 'base', rpc: string) {
  const tokens = chain === 'ethereum'
    ? [{ addr: '0xdac17f958d2ee523a2206206994597c13d831ec7', sym: 'USDT', dec: 6 }, { addr: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', sym: 'USDC', dec: 6 }]
    : [{ addr: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', sym: 'USDT', dec: 6 }, { addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', sym: 'USDC', dec: 6 }];
  const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const bnRes = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
  const bnData = await bnRes.json();
  const latest = parseInt(bnData.result, 16);
  const fromBlock = '0x' + (latest - 3).toString(16);
  for (const token of tokens) {
    const logsRes = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_getLogs', params: [{ fromBlock, toBlock: 'latest', address: token.addr, topics: [TOPIC] }] }) });
    const logsData = await logsRes.json();
    for (const log of logsData.result ?? []) {
      const txHash = log.transactionHash;
      if (await isSeen(txHash, chain)) continue;
      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);
      const amount = Number(BigInt(log.data)) / Math.pow(10, token.dec);
      const price = await getPrice(token.sym);
      const amountUsd = amount * price;
      if (amountUsd < PREMIUM_THRESHOLD_USD) { await markSeen(txHash, chain); continue; }
      const fi = await getLabel(from, chain); const ti = await getLabel(to, chain);
      const dir = fi.label === 'dex' || ti.label === 'dex' ? 'swap' : fi.label === 'bridge' || ti.label === 'bridge' ? 'bridge' : 'transfer';
      const sig = computeSignal(fi.label, ti.label, amountUsd);
      const cid = await checkCluster(chain, token.sym, amountUsd);
      await saveEvent({ chain, tx_hash: txHash, block_number: parseInt(log.blockNumber, 16), token_symbol: token.sym, token_address: token.addr, amount_raw: amount, amount_usd: amountUsd, from_address: from.toLowerCase(), to_address: to.toLowerCase(), from_label: fi.label, to_label: ti.label, from_name: fi.name, to_name: ti.name, direction: dir, signal: sig.signal, confidence_pct: sig.confidence_pct, is_cluster: !!cid, cluster_id: cid, occurred_at: new Date().toISOString(), raw_metadata: { blockNumber: log.blockNumber } });
      await markSeen(txHash, chain);
    }
  }
  console.log(`[${chain}] poll complete`);
}

async function pollSolana() {
  const mints = [{ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', sym: 'USDT' }, { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sym: 'USDC' }];
  for (const { mint, sym } of mints) {
    const sr = await fetch(SOL_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mint, { limit: 30 }] }) });
    const sd = await sr.json();
    for (const s of sd.result ?? []) {
      const txHash = s.signature;
      if (await isSeen(txHash, 'solana')) continue;
      const tr = await fetch(SOL_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getTransaction', params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }) });
      const td = await tr.json();
      const tx = td.result;
      if (!tx) { await markSeen(txHash, 'solana'); continue; }
      for (const ix of tx.transaction?.message?.instructions ?? []) {
        if (ix.program !== 'spl-token') continue;
        if (!['transfer', 'transferChecked'].includes(ix.parsed?.type)) continue;
        const info = ix.parsed?.info; if (!info) continue;
        const amount = Number(info.tokenAmount?.uiAmount ?? info.amount ?? 0);
        const price = await getPrice(sym);
        const amountUsd = amount * price;
        if (amountUsd < PREMIUM_THRESHOLD_USD) break;
        const from = info.authority ?? info.source ?? 'unknown';
        const to = info.destination ?? 'unknown';
        const fi = await getLabel(from, 'solana'); const ti = await getLabel(to, 'solana');
        const sig = computeSignal(fi.label, ti.label, amountUsd);
        const cid = await checkCluster('solana', sym, amountUsd);
        await saveEvent({ chain: 'solana', tx_hash: txHash, block_number: tx.slot, token_symbol: sym, token_address: mint, amount_raw: amount, amount_usd: amountUsd, from_address: from, to_address: to, from_label: fi.label, to_label: ti.label, from_name: fi.name, to_name: ti.name, direction: 'transfer', signal: sig.signal, confidence_pct: sig.confidence_pct, is_cluster: !!cid, cluster_id: cid, occurred_at: new Date(tx.blockTime * 1000).toISOString(), raw_metadata: { signature: txHash } });
        await markSeen(txHash, 'solana'); break;
      }
    }
  }
  console.log('[solana] poll complete');
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  if (token !== CRON_SECRET && token !== SUPABASE_SERVICE_KEY) return new Response('Unauthorized', { status: 401 });
  try {
    await Promise.all([pollEVM('ethereum', ETH_RPC), pollEVM('base', BASE_RPC), pollSolana()]);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
