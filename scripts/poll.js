const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ETH_RPC = process.env.ETH_RPC;
const BASE_RPC = process.env.BASE_RPC;
const SOL_RPC = process.env.SOL_RPC;
const COINGECKO_KEY = process.env.COINGECKO_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const priceCache = {};

const FREE_THRESHOLD = 500_000;
const PREMIUM_THRESHOLD = 100_000;

async function getPrice(symbol) {
  const now = Date.now();
  if (priceCache[symbol] && now - priceCache[symbol].ts < 60_000) return priceCache[symbol].price;
  const ids = { ETH: 'ethereum', USDT: 'tether', USDC: 'usd-coin', SOL: 'solana' };
  const id = ids[symbol.toUpperCase()] || symbol.toLowerCase();
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_KEY}`);
    const d = await r.json();
    const price = d[id]?.usd || 0;
    priceCache[symbol] = { price, ts: now };
    return price;
  } catch { return priceCache[symbol]?.price || 0; }
}

async function isSeen(txHash, chain) {
  const { data } = await supabase.from('seen_transactions').select('tx_hash').eq('tx_hash', txHash).eq('chain', chain).maybeSingle();
  return !!data;
}

async function markSeen(txHash, chain) {
  await supabase.from('seen_transactions').insert({ tx_hash: txHash, chain }).throwOnError();
}

async function getLabel(address, chain) {
  const { data } = await supabase.from('wallet_labels').select('label,name').eq('address', address.toLowerCase()).eq('chain', chain).maybeSingle();
  return { label: data?.label || 'unknown', name: data?.name || null };
}

function computeSignal(fromLabel, toLabel, amountUsd) {
  const boost = Math.min(35, Math.floor(amountUsd / 1_000_000) * 5);
  if (toLabel === 'cex' && fromLabel !== 'cex') return { signal: 'sell_pressure', confidence_pct: Math.min(95, 60 + boost) };
  if (fromLabel === 'cex' && toLabel !== 'cex') return { signal: 'accumulation', confidence_pct: Math.min(95, 60 + boost) };
  return { signal: 'neutral', confidence_pct: 50 };
}

async function saveEvent(evt) {
  const { error } = await supabase.from('whale_events').insert(evt);
  if (error && !error.message.includes('duplicate')) console.error('insert error:', error.message);
  else if (!error) await fanoutToTelegram(evt);
}

async function fanoutToTelegram(evt) {
  const amountUsd = Number(evt.amount_usd);
  const chain = evt.chain;
  const symbol = evt.token_symbol;
  const chainEmoji = { ethereum: '⟠', base: '🔵', solana: '◎' }[chain] || '🔗';

  function formatUSD(n) {
    if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
    return `$${(n/1_000).toFixed(0)}K`;
  }

  // Get premium + admin users
  const { data: premiumUsers } = await supabase.from('profiles').select('telegram_id,telegram_username').in('tier', ['premium', 'admin']).not('telegram_id', 'is', null);

  for (const user of premiumUsers || []) {
    const { data: already } = await supabase.from('telegram_send_log').select('id').eq('telegram_id', user.telegram_id).eq('whale_event_id', evt.id || '').maybeSingle();
    if (already) continue;

    const fromDisplay = evt.from_name || (evt.from_address?.slice(0, 8) + '...');
    const toDisplay = evt.to_name || (evt.to_address?.slice(0, 8) + '...');
    const signalEmoji = { accumulation: '🟢', sell_pressure: '🔴', neutral: '⚪', cluster: '🟡' }[evt.signal] || '⚪';

    const msg = `${signalEmoji} <b>LEVIATHAN SIGNAL</b>${evt.is_cluster ? ' ⚡ CLUSTER' : ''}\n\n${chainEmoji} <b>${chain.toUpperCase()}</b> · ${symbol}\n💰 <b>${formatUSD(amountUsd)}</b>\n📤 From: <code>${fromDisplay}</code>\n📥 To: <code>${toDisplay}</code>\n📊 Signal: <b>${(evt.signal || 'neutral').replace('_', ' ').toUpperCase()}</b>\n🎯 Confidence: <b>${evt.confidence_pct}%</b>\n\n<i>Licensed to @${user.telegram_username || 'subscriber'}</i>`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegram_id.toString(), text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  }

  // Free users — only if above free threshold and delayed
  const occurredAt = new Date(evt.occurred_at).getTime();
const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
if (amountUsd >= FREE_THRESHOLD && occurredAt <= fifteenMinAgo) {
    const { data: freeUsers } = await supabase.from('profiles').select('telegram_id').eq('tier', 'free').not('telegram_id', 'is', null);
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);

    for (const user of freeUsers || []) {
      const { count } = await supabase.from('telegram_send_log').select('id', { count: 'exact', head: true }).eq('telegram_id', user.telegram_id).eq('tier_sent_as', 'free').gte('sent_at', midnight.toISOString());
      if ((count || 0) >= 5) continue;

      const msg = `🐋 <b>LEVIATHAN — Whale Alert</b>\n\n${chainEmoji} <b>${chain.toUpperCase()}</b> · ${symbol}\n💰 <b>${formatUSD(amountUsd)}</b> moved\n\n<i>⚡ Upgrade to Premium for real-time signals with wallet intelligence</i>`;

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: user.telegram_id.toString(), text: msg, parse_mode: 'HTML', disable_web_page_preview: true })
      });

      await supabase.from('telegram_send_log').insert({ telegram_id: user.telegram_id, whale_event_id: evt.id || crypto.randomUUID(), tier_sent_as: 'free' });
    }
  }
}

async function pollEVM(chain, rpc) {
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

    for (const log of logsData.result || []) {
      const txHash = log.transactionHash;
      if (await isSeen(txHash, chain)) continue;

      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);
      const amount = Number(BigInt(log.data)) / Math.pow(10, token.dec);
      const price = await getPrice(token.sym);
      const amountUsd = amount * price;

      if (amountUsd < PREMIUM_THRESHOLD) { await markSeen(txHash, chain); continue; }

      const fi = await getLabel(from, chain);
      const ti = await getLabel(to, chain);
      const dir = fi.label === 'dex' || ti.label === 'dex' ? 'swap' : fi.label === 'bridge' || ti.label === 'bridge' ? 'bridge' : 'transfer';
      const sig = computeSignal(fi.label, ti.label, amountUsd);

      await saveEvent({
        chain, tx_hash: txHash, block_number: parseInt(log.blockNumber, 16),
        token_symbol: token.sym, token_address: token.addr,
        amount_raw: amount, amount_usd: amountUsd,
        from_address: from.toLowerCase(), to_address: to.toLowerCase(),
        from_label: fi.label, to_label: ti.label, from_name: fi.name, to_name: ti.name,
        direction: dir, signal: sig.signal, confidence_pct: sig.confidence_pct,
        is_cluster: false, occurred_at: new Date().toISOString(),
      });
      await markSeen(txHash, chain);
    }
  }
  console.log(`[${chain}] polled`);
}

async function pollSolana() {
  const mints = [
    { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', sym: 'USDT' },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sym: 'USDC' }
  ];

  for (const { mint, sym } of mints) {
    const sr = await fetch(SOL_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [mint, { limit: 25 }] }) });
    const sd = await sr.json();

    for (const s of sd.result || []) {
      const txHash = s.signature;
      if (await isSeen(txHash, 'solana')) continue;

      const tr = await fetch(SOL_RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getTransaction', params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }) });
      const td = await tr.json();
      const tx = td.result;
      if (!tx) { await markSeen(txHash, 'solana'); continue; }

      for (const ix of tx.transaction?.message?.instructions || []) {
        if (ix.program !== 'spl-token') continue;
        if (!['transfer', 'transferChecked'].includes(ix.parsed?.type)) continue;
        const info = ix.parsed?.info;
        if (!info) continue;

        const amount = Number(info.tokenAmount?.uiAmount || info.amount || 0);
        const price = await getPrice(sym);
        const amountUsd = amount * price;
        if (amountUsd < PREMIUM_THRESHOLD) break;

        const from = info.authority || info.source || 'unknown';
        const to = info.destination || 'unknown';
        const fi = await getLabel(from, 'solana');
        const ti = await getLabel(to, 'solana');
        const sig = computeSignal(fi.label, ti.label, amountUsd);

        await saveEvent({
          chain: 'solana', tx_hash: txHash, block_number: tx.slot,
          token_symbol: sym, token_address: mint,
          amount_raw: amount, amount_usd: amountUsd,
          from_address: from, to_address: to,
          from_label: fi.label, to_label: ti.label, from_name: fi.name, to_name: ti.name,
          direction: 'transfer', signal: sig.signal, confidence_pct: sig.confidence_pct,
          is_cluster: false, occurred_at: new Date(tx.blockTime * 1000).toISOString(),
        });
        await markSeen(txHash, 'solana');
        break;
      }
    }
  }
  console.log('[solana] polled');
}

async function main() {
  console.log('🐋 Leviathan polling started...');
  await Promise.all([
    pollEVM('ethereum', ETH_RPC),
    pollEVM('base', BASE_RPC),
    pollSolana()
  ]);
  console.log('✅ Poll complete');
}

main().catch(console.error);
