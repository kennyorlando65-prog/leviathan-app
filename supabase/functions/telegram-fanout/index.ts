import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;
const FREE_THRESHOLD_USD = 500_000;
const FREE_DAILY_LIMIT = 5;
const FREE_DELAY_MINUTES = 15;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function sendTelegram(chatId: bigint, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId.toString(), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json();
  return data.ok;
}

function formatUSD(n: number) {
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  return `$${(n/1_000).toFixed(0)}K`;
}
function chainEmoji(c: string) { return ({ethereum:'⟠',base:'🔵',solana:'◎'})[c]??'🔗'; }
function signalEmoji(s: string) { return ({accumulation:'🟢',sell_pressure:'🔴',neutral:'⚪',cluster:'🟡'})[s]??'⚪'; }
function chainLabel(c: string) { return ({ethereum:'Ethereum',base:'Base',solana:'Solana'})[c]??c; }

function buildFreeMessage(evt: Record<string,unknown>): string {
  const delayed = new Date(new Date(evt.occurred_at as string).getTime() + FREE_DELAY_MINUTES*60*1000);
  return `🐋 <b>LEVIATHAN — Whale Alert</b>\n\n${chainEmoji(evt.chain as string)} <b>${chainLabel(evt.chain as string)}</b> · ${evt.token_symbol}\n💰 <b>${formatUSD(Number(evt.amount_usd))}</b> moved\n↔️ ${(evt.from_label as string).toUpperCase()} → ${(evt.to_label as string).toUpperCase()}\n🕐 ${delayed.toUTCString().slice(0,25)}\n\n<i>⚡ Upgrade to Premium for real-time signals</i>`;
}

function buildPremiumMessage(evt: Record<string,unknown>, username: string): string {
  const fromDisplay = (evt.from_name as string|null) ?? (evt.from_address as string).slice(0,8)+'...';
  const toDisplay = (evt.to_name as string|null) ?? (evt.to_address as string).slice(0,8)+'...';
  let msg = `${signalEmoji(evt.signal as string)} <b>LEVIATHAN SIGNAL</b>${evt.is_cluster?' ⚡ CLUSTER':''}\n\n${chainEmoji(evt.chain as string)} <b>${chainLabel(evt.chain as string)}</b> · ${evt.token_symbol}\n💰 <b>${formatUSD(Number(evt.amount_usd))}</b>\n📤 From: <code>${fromDisplay}</code>\n📥 To: <code>${toDisplay}</code>\n📊 Signal: <b>${(evt.signal as string).replace('_',' ').toUpperCase()}</b>\n🎯 Confidence: <b>${evt.confidence_pct}%</b>\n⏱ ${new Date(evt.occurred_at as string).toUTCString().slice(0,25)}`;
  if (evt.is_cluster) msg += `\n\n⚠️ <b>Multiple wallets moving ${evt.token_symbol} within 5 minutes</b>`;
  msg += `\n\n<i>Licensed to @${username}</i>`;
  return msg;
}

function buildTeaserMessage(evt: Record<string,unknown>): string {
  return `🔒 <b>PREMIUM SIGNAL DETECTED</b>\n\n${chainEmoji(evt.chain as string)} <b>${chainLabel(evt.chain as string)}</b>\n💰 Amount: <b>${formatUSD(Number(evt.amount_usd))}</b>\n📊 Signal: <b>[LOCKED]</b>\n🎯 Confidence: <b>??%</b>\n\n<i>Upgrade to unlock → leviathan-app.vercel.app</i>`;
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get('Authorization')??'').replace('Bearer ','');
  if (token !== CRON_SECRET && token !== SUPABASE_SERVICE_KEY) return new Response('Unauthorized',{status:401});

  const now = new Date();
  const freeDelayCutoff = new Date(now.getTime()-FREE_DELAY_MINUTES*60*1000).toISOString();
  const oneMinAgo = new Date(now.getTime()-60*1000).toISOString();

  const {data:premiumEvents} = await supabase.from('whale_events').select('*').gte('ingested_at',oneMinAgo).gte('amount_usd',100_000).order('occurred_at',{ascending:true});
  const {data:freeEvents} = await supabase.from('whale_events').select('*').lte('occurred_at',freeDelayCutoff).gte('ingested_at',new Date(now.getTime()-(FREE_DELAY_MINUTES+1)*60*1000).toISOString()).gte('amount_usd',FREE_THRESHOLD_USD).order('occurred_at',{ascending:true});

  let sent=0, errors=0;

  if (premiumEvents?.length) {
    const {data:premiumUsers} = await supabase.from('profiles').select('telegram_id,telegram_username').in('tier',['premium','admin']).not('telegram_id','is',null);
    for (const evt of premiumEvents) {
      for (const user of premiumUsers??[]) {
        const {data:already} = await supabase.from('telegram_send_log').select('id').eq('telegram_id',user.telegram_id).eq('whale_event_id',evt.id).maybeSingle();
        if (already) continue;
        const ok = await sendTelegram(BigInt(user.telegram_id), buildPremiumMessage(evt, user.telegram_username??'subscriber'));
        if (ok) { await supabase.from('telegram_send_log').insert({telegram_id:user.telegram_id,whale_event_id:evt.id,tier_sent_as:'premium'}); sent++; } else errors++;
      }
    }
  }

  if (freeEvents?.length) {
    const {data:freeUsers} = await supabase.from('profiles').select('id,telegram_id').eq('tier','free').not('telegram_id','is',null);
    for (const user of freeUsers??[]) {
      const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
      const {count:todayCount} = await supabase.from('telegram_send_log').select('id',{count:'exact',head:true}).eq('telegram_id',user.telegram_id).eq('tier_sent_as','free').gte('sent_at',midnight.toISOString());
      if ((todayCount??0)>=FREE_DAILY_LIMIT) continue;
      for (const evt of freeEvents.slice(0,FREE_DAILY_LIMIT-(todayCount??0))) {
        const {data:already} = await supabase.from('telegram_send_log').select('id').eq('telegram_id',user.telegram_id).eq('whale_event_id',evt.id).maybeSingle();
        if (already) continue;
        const ok = await sendTelegram(BigInt(user.telegram_id), buildFreeMessage(evt));
        if (ok) { await supabase.from('telegram_send_log').insert({telegram_id:user.telegram_id,whale_event_id:evt.id,tier_sent_as:'free'}); sent++; } else errors++;
      }
      if (premiumEvents?.length) {
        const teaser = premiumEvents.find(e=>Number(e.amount_usd)<FREE_THRESHOLD_USD);
        if (teaser) {
          const {data:tAlready} = await supabase.from('telegram_send_log').select('id').eq('telegram_id',user.telegram_id).eq('whale_event_id',teaser.id).maybeSingle();
          if (!tAlready) await sendTelegram(BigInt(user.telegram_id), buildTeaserMessage(teaser));
        }
      }
    }
  }

  return new Response(JSON.stringify({ok:true,sent,errors}),{headers:{'Content-Type':'application/json'}});
});
