import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function formatUSD(n: number) {
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  return `$${(n/1_000).toFixed(0)}K`;
}

async function sendTelegram(chatId: bigint, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId.toString(), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get('Authorization')??'').replace('Bearer ','');
  if (token !== CRON_SECRET && token !== SUPABASE_SERVICE_KEY) return new Response('Unauthorized',{status:401});

  const since = new Date(Date.now()-24*60*60*1000).toISOString();

  const [{data:events},{count:totalCount},{data:chainData},{data:signalData}] = await Promise.all([
    supabase.from('whale_events').select('chain,token_symbol,amount_usd,signal').gte('occurred_at',since).order('amount_usd',{ascending:false}).limit(3),
    supabase.from('whale_events').select('id',{count:'exact',head:true}).gte('occurred_at',since),
    supabase.from('whale_events').select('chain').gte('occurred_at',since),
    supabase.from('whale_events').select('signal').gte('occurred_at',since).not('signal','is',null),
  ]);

  if (!events?.length) return new Response(JSON.stringify({ok:true,note:'no_events'}));

  const chainCounts: Record<string,number> = {};
  for (const e of chainData??[]) chainCounts[e.chain]=(chainCounts[e.chain]??0)+1;
  const dominantChain = Object.entries(chainCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]??'ethereum';

  const signalCounts: Record<string,number> = {};
  for (const e of signalData??[]) if(e.signal) signalCounts[e.signal]=(signalCounts[e.signal]??0)+1;
  const sentiment = (signalCounts['accumulation']??0)>(signalCounts['sell_pressure']??0)?'🟢 Bullish Bias':(signalCounts['sell_pressure']??0)>(signalCounts['accumulation']??0)?'🔴 Bearish Bias':'⚪ Neutral';

  const topMovers = events.slice(0,3).map((e,i)=>`${i+1}. ${e.chain.toUpperCase()} ${e.token_symbol} — <b>${formatUSD(Number(e.amount_usd))}</b>${e.signal?` (${e.signal.replace('_',' ')})`:''}`).join('\n');

  const summary = `🐋 <b>LEVIATHAN — Daily Summary</b>\n${new Date().toDateString()}\n\n📊 <b>24H Overview</b>\nTotal whale moves: <b>${totalCount}</b>\nDominant chain: <b>${dominantChain.toUpperCase()}</b>\nSentiment: <b>${sentiment}</b>\n\n🏆 <b>Top Movers</b>\n${topMovers}\n\n${signalCounts['accumulation']?`🟢 Accumulation: <b>${signalCounts['accumulation']}</b>\n`:''}${signalCounts['sell_pressure']?`🔴 Sell pressure: <b>${signalCounts['sell_pressure']}</b>\n`:''}${signalCounts['cluster']?`⚡ Clusters: <b>${signalCounts['cluster']}</b>\n`:''}\n<i>Stay sharp. The whales don't sleep.</i>`;

  const {data:users} = await supabase.from('profiles').select('telegram_id').in('tier',['premium','admin']).not('telegram_id','is',null);
  let sent = 0;
  for (const user of users??[]) { await sendTelegram(BigInt(user.telegram_id), summary); sent++; }

  return new Response(JSON.stringify({ok:true,sent}),{headers:{'Content-Type':'application/json'}});
});
