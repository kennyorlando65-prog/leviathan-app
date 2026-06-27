import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
}

function formatUSD(n: number) {
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  return `$${(n/1_000).toFixed(0)}K`;
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  let body: Record<string,unknown>;
  try { body = await req.json(); } catch { return new Response('OK'); }

  const message = (body.message ?? body.edited_message) as Record<string,unknown>|undefined;
  if (!message) return new Response('OK');

  const chat = message.chat as Record<string,unknown>;
  const chatId = chat.id as number;
  const from = message.from as Record<string,unknown>;
  const telegramId = from.id as number;
  const username = from.username as string|undefined;
  const text = (message.text as string|undefined) ?? '';

  if (text.startsWith('/start')) {
    const bindToken = text.split(' ')[1] ?? null;
    if (bindToken) {
      const {data:profile} = await supabase.from('profiles').select('id,tier,email').eq('telegram_bind_token',bindToken).gt('telegram_bind_expires_at',new Date().toISOString()).maybeSingle();
      if (!profile) { await reply(chatId,'❌ <b>Link expired.</b>\n\nGenerate a new link from the website.'); return new Response('OK'); }
      const {data:existing} = await supabase.from('profiles').select('id').eq('telegram_id',telegramId).neq('id',profile.id).maybeSingle();
      if (existing) { await reply(chatId,'❌ This Telegram account is already linked to another account.'); return new Response('OK'); }
      await supabase.from('profiles').update({ telegram_id:telegramId, telegram_username:username??null, telegram_linked_at:new Date().toISOString(), telegram_bind_token:null, telegram_bind_expires_at:null }).eq('id',profile.id);
      const tierEmoji = profile.tier==='premium'?'💎':profile.tier==='admin'?'👑':'🆓';
      await reply(chatId,`🐋 <b>Welcome to LEVIATHAN</b>\n\n✅ Account linked!\n${tierEmoji} Tier: <b>${(profile.tier as string).toUpperCase()}</b>\n📧 ${profile.email}\n\n${profile.tier==='free'?'You\'ll receive up to <b>5 whale alerts daily</b> for moves above <b>$500K</b>, delayed 15 minutes.\n\n💎 Upgrade: leviathan-app.vercel.app':'✅ <b>Premium active.</b> Real-time signals enabled.\n\nCommands: /status · /watch [addr] [chain] · /unwatchall'}`);
      return new Response('OK');
    }
    await reply(chatId,'🐋 <b>LEVIATHAN</b> — Smart Whale Intelligence\n\nConnect your account at:\n<b>leviathan-app.vercel.app</b>');
    return new Response('OK');
  }

  const {data:profile} = await supabase.from('profiles').select('id,tier,email,pro_until').eq('telegram_id',telegramId).maybeSingle();
  if (!profile) { await reply(chatId,'🐋 Link your account first at <b>leviathan-app.vercel.app</b>'); return new Response('OK'); }

  if (text === '/status') {
    const tierEmoji = profile.tier==='premium'?'💎':profile.tier==='admin'?'👑':'🆓';
    const proUntil = profile.pro_until?`\n⏳ Premium until: <b>${new Date(profile.pro_until).toDateString()}</b>`:'';
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
    const {count:todayCount} = await supabase.from('telegram_send_log').select('id',{count:'exact',head:true}).eq('telegram_id',telegramId).gte('sent_at',midnight.toISOString());
    await reply(chatId,`👤 <b>Your Leviathan Account</b>\n\n${tierEmoji} Tier: <b>${(profile.tier as string).toUpperCase()}</b>\n📧 ${profile.email}${proUntil}\n📊 Signals today: <b>${todayCount??0}${profile.tier==='free'?'/5':''}</b>\n\n${profile.tier==='free'?'💎 Upgrade: leviathan-app.vercel.app':'✅ Full access active'}`);
    return new Response('OK');
  }

  if (text.startsWith('/watch')) {
    if (profile.tier==='free') { await reply(chatId,'🔒 <b>Wallet tracking is Premium only.</b>\n\nUpgrade at leviathan-app.vercel.app'); return new Response('OK'); }
    const parts = text.split(' ');
    const address = parts[1]; const chain = parts[2]?.toLowerCase()?? 'ethereum';
    if (!address) { await reply(chatId,'Usage: <code>/watch 0xADDRESS ethereum</code>\nChains: ethereum, base, solana'); return new Response('OK'); }
    if (!['ethereum','base','solana'].includes(chain)) { await reply(chatId,'❌ Invalid chain. Use: ethereum, base, solana'); return new Response('OK'); }
    const {error} = await supabase.from('watchlist').insert({ user_id:profile.id, wallet_address:address.toLowerCase(), chain });
    if (error?.message.includes('unique')) await reply(chatId,`ℹ️ Already watching <code>${address.slice(0,10)}...</code> on ${chain}`);
    else if (error) await reply(chatId,'❌ Error adding to watchlist.');
    else await reply(chatId,`✅ Now watching <code>${address.slice(0,10)}...</code> on <b>${chain}</b>\n\nYou'll be alerted when this wallet moves $100K+.`);
    return new Response('OK');
  }

  if (text === '/unwatchall') {
    await supabase.from('watchlist').delete().eq('user_id',profile.id);
    await reply(chatId,'✅ Watchlist cleared.');
    return new Response('OK');
  }

  if (text === '/stats' && profile.tier === 'admin') {
    const [{count:totalUsers},{count:premiumUsers},{count:totalEvents},{count:todayEvents}] = await Promise.all([
      supabase.from('profiles').select('id',{count:'exact',head:true}),
      supabase.from('profiles').select('id',{count:'exact',head:true}).eq('tier','premium'),
      supabase.from('whale_events').select('id',{count:'exact',head:true}),
      supabase.from('whale_events').select('id',{count:'exact',head:true}).gte('ingested_at',new Date(Date.now()-86400000).toISOString()),
    ]);
    await reply(chatId,`👑 <b>LEVIATHAN ADMIN</b>\n\n👥 Total users: <b>${totalUsers}</b>\n💎 Premium: <b>${premiumUsers}</b>\n🐋 Total events: <b>${totalEvents}</b>\n📊 Today: <b>${todayEvents}</b>`);
    return new Response('OK');
  }

  if (text === '/recent' && profile.tier === 'admin') {
    const {data:events} = await supabase.from('whale_events').select('chain,token_symbol,amount_usd,signal,occurred_at').order('occurred_at',{ascending:false}).limit(5);
    if (!events?.length) { await reply(chatId,'No events yet.'); return new Response('OK'); }
    const lines = events.map(e=>`• ${e.chain.toUpperCase()} ${e.token_symbol} ${formatUSD(Number(e.amount_usd))} — ${e.signal??'neutral'}`);
    await reply(chatId,`🐋 <b>Recent Events</b>\n\n${lines.join('\n')}`);
    return new Response('OK');
  }

  await reply(chatId,`Commands:\n/status — your account\n/watch [addr] [chain] — track wallet (Premium)\n/unwatchall — clear watchlist${profile.tier==='admin'?'\n/stats — admin stats\n/recent — recent events':''}`);
  return new Response('OK');
});
