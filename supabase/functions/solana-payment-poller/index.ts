import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SOL_RPC = Deno.env.get('SOL_RPC_URL')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;
const RECEIVING_WALLET = Deno.env.get('SOLANA_RECEIVING_WALLET')!;
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const EXPECTED_USDT = 25;
const TOLERANCE = 0.5;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function sendTelegram(chatId: bigint, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId.toString(), text, parse_mode: 'HTML' }),
  });
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get('Authorization')??'').replace('Bearer ','');
  if (token !== CRON_SECRET && token !== SUPABASE_SERVICE_KEY) return new Response('Unauthorized',{status:401});

  const taRes = await fetch(SOL_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenAccountsByOwner', params:[RECEIVING_WALLET,{mint:USDT_MINT},{encoding:'jsonParsed'}] }),
  });
  const taData = await taRes.json();
  const tokenAccounts = taData.result?.value ?? [];
  if (tokenAccounts.length === 0) return new Response(JSON.stringify({ok:true,note:'no_token_account'}));

  const tokenAccountAddress = tokenAccounts[0].pubkey;

  const sigsRes = await fetch(SOL_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:2, method:'getSignaturesForAddress', params:[tokenAccountAddress,{limit:25}] }),
  });
  const sigsData = await sigsRes.json();
  const signatures = sigsData.result ?? [];

  const {data:pendingIntents} = await supabase.from('payment_intents').select('*, profiles(telegram_id,email)').eq('status','pending').gt('expires_at',new Date().toISOString());
  if (!pendingIntents?.length) return new Response(JSON.stringify({ok:true,note:'no_pending_intents'}));

  let confirmed = 0;

  for (const sig of signatures) {
    const txSig = sig.signature;
    const {data:alreadyUsed} = await supabase.from('payment_intents').select('id').eq('tx_signature',txSig).maybeSingle();
    if (alreadyUsed) continue;

    const txRes = await fetch(SOL_RPC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', id:3, method:'getTransaction', params:[txSig,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}] }),
    });
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx || tx.meta?.err) continue;

    for (const ix of tx.transaction?.message?.instructions ?? []) {
      if (ix.program !== 'spl-token') continue;
      if (!['transfer','transferChecked'].includes(ix.parsed?.type)) continue;
      const info = ix.parsed?.info;
      if (!info) continue;
      if (info.destination !== tokenAccountAddress) continue;

      const amountRaw = Number(info.tokenAmount?.amount ?? info.amount ?? 0);
      const amountUSDT = amountRaw / 1_000_000;
      if (amountUSDT < EXPECTED_USDT - TOLERANCE || amountUSDT > EXPECTED_USDT + TOLERANCE + 100) continue;

      const senderAuthority = info.authority ?? null;
      if (!senderAuthority) continue;

      const matchedIntent = pendingIntents.find(i => i.sender_wallet.toLowerCase() === senderAuthority.toLowerCase());
      if (!matchedIntent) continue;

      await supabase.from('payment_intents').update({ status:'confirmed', tx_signature:txSig, amount_received:amountUSDT }).eq('id',matchedIntent.id);

      const proUntil = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      await supabase.from('profiles').update({ tier:'premium', pro_until:proUntil, payment_method:'usdt_solana' }).eq('id',matchedIntent.user_id);
      await supabase.from('subscriptions').update({ tier:'premium', pro_until:proUntil, payment_method:'usdt_solana' }).eq('user_id',matchedIntent.user_id);
      await supabase.from('admin_audit_log').insert({ action:'payment_confirmed', target_user_id:matchedIntent.user_id, metadata:{ tx_signature:txSig, amount_usdt:amountUSDT, sender:senderAuthority } });

      const telegramId = matchedIntent.profiles?.telegram_id;
      if (telegramId) {
        await sendTelegram(BigInt(telegramId), `✅ <b>Payment Confirmed!</b>\n\n💰 Received: <b>${amountUSDT.toFixed(2)} USDT</b>\n💎 <b>Premium activated for 30 days</b>\n\nYou now have:\n• Real-time signals\n• Wallet intelligence\n• Smart signals + confidence %\n• Cluster detection\n• Daily summaries\n\nUse /status to check your account.`);
      }
      confirmed++;
      break;
    }
  }

  return new Response(JSON.stringify({ok:true,confirmed}),{headers:{'Content-Type':'application/json'}});
});
