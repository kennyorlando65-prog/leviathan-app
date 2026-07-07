import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const ADMIN_TELEGRAM_ID = '7230717710';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

function formatUSD(n: number) {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000).toFixed(0)}K`;
}

async function getOrCreateUser(telegramId: number, username: string | undefined) {
  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (existing) return existing;

  const isAdmin = String(telegramId) === ADMIN_TELEGRAM_ID;
  const tier = isAdmin ? 'admin' : 'free';

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      id: crypto.randomUUID(),
      email: `tg_${telegramId}@leviathan.app`,
      tier,
      telegram_id: telegramId,
      telegram_username: username ?? null,
      telegram_linked_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    console.error('Create user error:', error.message);
    return null;
  }

  await supabase.from('subscriptions').insert({ user_id: data.id, tier });
  return data;
}

Deno.serve(async (req: Request) => {
  // Accept all requests - no secret check
  if (req.method !== 'POST') return new Response('OK');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response('OK'); }

  const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return new Response('OK');

  const chat = message.chat as Record<string, unknown>;
  const chatId = chat.id as number;
  const from = message.from as Record<string, unknown>;
  const telegramId = from.id as number;
  const username = from.username as string | undefined;
  const text = (message.text as string | undefined) ?? '';

  const profile = await getOrCreateUser(telegramId, username);
  if (!profile) {
    await reply(chatId, '❌ Error setting up your account. Try again.');
    return new Response('OK');
  }

  const tier = profile.tier as string;
  const isAdmin = tier === 'admin';
  const isPremium = tier === 'premium' || isAdmin;

  // /start
  if (text.startsWith('/start')) {
    if (isAdmin) {
      await reply(chatId,
        `👑 <b>Welcome back, Joshua.</b>\n\n` +
        `Full admin access active.\n\n` +
        `<b>Admin commands:</b>\n` +
        `/stats — platform stats\n` +
        `/recent — latest whale events\n` +
        `/users — recent users\n` +
        `/status — your account\n\n` +
        `<b>User commands:</b>\n` +
        `/upgrade — upgrade info\n` +
        `/watch [addr] [chain] — track wallet\n` +
        `/help — all commands\n\n` +
        `🐋 Leviathan is live and running.`
      );
    } else if (isPremium) {
      await reply(chatId,
        `💎 <b>Welcome back to LEVIATHAN</b>\n\n` +
        `Your Premium access is active.\n\n` +
        `/status — your account\n` +
        `/watch [address] [chain] — track a wallet\n` +
        `/unwatchall — clear watchlist\n\n` +
        `Real-time signals are being delivered automatically.`
      );
    } else {
      await reply(chatId,
        `🐋 <b>Welcome to LEVIATHAN</b>\n\n` +
        `Smart Whale Intelligence across Ethereum, Base & Solana.\n\n` +
        `<b>Your Free tier includes:</b>\n` +
        `• Up to 5 whale alerts daily\n` +
        `• Moves above $500K\n` +
        `• 15-minute delay\n\n` +
        `💎 <b>Premium — $25 USDT/30 days</b>\n` +
        `• Real-time signals\n` +
        `• Moves above $100K\n` +
        `• Smart signals + confidence %\n` +
        `• Unlimited alerts\n` +
        `• Cluster detection\n` +
        `• Daily 8AM summary\n` +
        `• Wallet tracking\n\n` +
        `Type /upgrade to go Premium.\n` +
        `Type /help to see all commands.`
      );
    }
    return new Response('OK');
  }

  // /help
  if (text === '/help') {
    let msg = `🐋 <b>LEVIATHAN Commands</b>\n\n`;
    msg += `/start — welcome\n/status — your account\n/upgrade — go Premium\n`;
    if (isPremium) msg += `/watch [addr] [chain] — track wallet\n/unwatchall — clear watchlist\n`;
    if (isAdmin) msg += `\n👑 <b>Admin:</b>\n/stats /recent /users`;
    await reply(chatId, msg);
    return new Response('OK');
  }

  // /status
  if (text === '/status') {
    const tierEmoji = isAdmin ? '👑' : isPremium ? '💎' : '🆓';
    const proUntil = profile.pro_until ? `\n⏳ Premium until: <b>${new Date(profile.pro_until).toDateString()}</b>` : '';
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const { count } = await supabase
      .from('telegram_send_log')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_id', telegramId)
      .gte('sent_at', midnight.toISOString());
    await reply(chatId,
      `${tierEmoji} <b>Your Account</b>\n\n` +
      `Tier: <b>${tier.toUpperCase()}</b>${proUntil}\n` +
      `Telegram: @${username ?? 'unknown'}\n` +
      `Signals today: <b>${count ?? 0}${tier === 'free' ? '/5' : ''}</b>\n\n` +
      `${tier === 'free' ? '💎 Type /upgrade to go Premium' : '✅ Full access active'}`
    );
    return new Response('OK');
  }

  // /upgrade
  if (text === '/upgrade') {
    if (isAdmin) { await reply(chatId, `👑 You're the admin — you have everything.`); return new Response('OK'); }
    if (isPremium) { await reply(chatId, `💎 You already have Premium!\n\nType /status to check your expiry.`); return new Response('OK'); }
    await reply(chatId,
      `💎 <b>Upgrade to Premium — $25 USDT</b>\n\n` +
      `1️⃣ Send exactly <b>25 USDT</b> on Solana to:\n` +
      `<code>ETv38hfME7CYHYXg1KqeL9mBtdEtjNsA3R9Csyc5pfPY</code>\n\n` +
      `2️⃣ Then send:\n` +
      `<code>/paid YOUR_SOLANA_WALLET</code>\n\n` +
      `Example:\n` +
      `<code>/paid 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>\n\n` +
      `3️⃣ Premium activates automatically within 2 minutes.\n\n` +
      `⚠️ USDT on Solana only. Do not send from an exchange.`
    );
    return new Response('OK');
  }

  // /paid [wallet]
  if (text.startsWith('/paid')) {
    if (isPremium && !isAdmin) { await reply(chatId, `💎 You already have Premium!`); return new Response('OK'); }
    const wallet = text.split(' ')[1];
    if (!wallet || wallet.length < 32) {
      await reply(chatId, `❌ Include your wallet.\n\nExample: <code>/paid 7xKXtg2CW87d...</code>`);
      return new Response('OK');
    }
    const { data: existing } = await supabase.from('payment_intents').select('id').eq('sender_wallet', wallet.toLowerCase()).eq('status', 'pending').maybeSingle();
    if (existing) { await reply(chatId, `⏳ Already monitoring this wallet. Activates within 2 minutes of payment confirming.`); return new Response('OK'); }
    const { error } = await supabase.from('payment_intents').insert({ user_id: profile.id, sender_wallet: wallet.toLowerCase(), expected_usdt: 25, status: 'pending' });
    if (error) { await reply(chatId, `❌ Error registering payment. Try again.`); return new Response('OK'); }
    await reply(chatId,
      `✅ <b>Payment registered!</b>\n\n` +
      `Monitoring: <code>${wallet.slice(0, 8)}...${wallet.slice(-6)}</code>\n\n` +
      `Premium activates automatically within 2 minutes of your 25 USDT confirming on Solana.\n\n` +
      `You'll get a confirmation message here.`
    );
    return new Response('OK');
  }

  // /watch [address] [chain]
  if (text.startsWith('/watch')) {
    if (!isPremium) { await reply(chatId, `🔒 Wallet tracking is Premium only.\n\nType /upgrade to get access.`); return new Response('OK'); }
    const parts = text.split(' ');
    const address = parts[1]; const chain = parts[2]?.toLowerCase() ?? 'ethereum';
    if (!address) { await reply(chatId, `Usage: <code>/watch 0xADDRESS ethereum</code>\nChains: ethereum, base, solana`); return new Response('OK'); }
    if (!['ethereum', 'base', 'solana'].includes(chain)) { await reply(chatId, `❌ Invalid chain. Use: ethereum, base, solana`); return new Response('OK'); }
    const { error } = await supabase.from('watchlist').insert({ user_id: profile.id, wallet_address: address.toLowerCase(), chain });
    if (error?.message.includes('unique')) await reply(chatId, `ℹ️ Already watching <code>${address.slice(0, 10)}...</code> on ${chain}`);
    else if (error) await reply(chatId, `❌ Error adding wallet.`);
    else await reply(chatId, `✅ Watching <code>${address.slice(0, 10)}...</code> on <b>${chain}</b>\n\nYou'll be alerted when this wallet moves $100K+.`);
    return new Response('OK');
  }

  // /unwatchall
  if (text === '/unwatchall') {
    await supabase.from('watchlist').delete().eq('user_id', profile.id);
    await reply(chatId, `✅ Watchlist cleared.`);
    return new Response('OK');
  }

  // ADMIN: /stats
  if (text === '/stats' && isAdmin) {
    const [{ count: total }, { count: premium }, { count: events }, { count: today }] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('tier', 'premium'),
      supabase.from('whale_events').select('id', { count: 'exact', head: true }),
      supabase.from('whale_events').select('id', { count: 'exact', head: true }).gte('ingested_at', new Date(Date.now() - 86400000).toISOString()),
    ]);
    await reply(chatId,
      `👑 <b>LEVIATHAN STATS</b>\n\n` +
      `👥 Total users: <b>${total}</b>\n` +
      `💎 Premium: <b>${premium}</b>\n` +
      `🆓 Free: <b>${(total ?? 0) - (premium ?? 0)}</b>\n` +
      `🐋 Total events: <b>${events}</b>\n` +
      `📊 Events today: <b>${today}</b>`
    );
    return new Response('OK');
  }

  // ADMIN: /recent
  if (text === '/recent' && isAdmin) {
    const { data: events } = await supabase.from('whale_events').select('chain,token_symbol,amount_usd,signal,occurred_at').order('occurred_at', { ascending: false }).limit(5);
    if (!events?.length) { await reply(chatId, 'No events yet.'); return new Response('OK'); }
    const lines = events.map(e => `• ${e.chain.toUpperCase()} ${e.token_symbol} ${formatUSD(Number(e.amount_usd))} — ${e.signal ?? 'neutral'}`);
    await reply(chatId, `🐋 <b>Recent Events</b>\n\n${lines.join('\n')}`);
    return new Response('OK');
  }

  // ADMIN: /users
  if (text === '/users' && isAdmin) {
    const { data: users } = await supabase.from('profiles').select('telegram_username,tier,created_at').order('created_at', { ascending: false }).limit(10);
    if (!users?.length) { await reply(chatId, 'No users yet.'); return new Response('OK'); }
    const lines = users.map(u => `• @${u.telegram_username ?? 'unknown'} — ${u.tier.toUpperCase()}`);
    await reply(chatId, `👥 <b>Recent Users</b>\n\n${lines.join('\n')}`);
    return new Response('OK');
  }

  // Default
  await reply(chatId, `Type /help to see all commands.`);
  return new Response('OK');
});
