  import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')!;
const ADMIN_TELEGRAM_ID = 'YOUR_TELEGRAM_ID';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function reply(chatId: number, text: string, extra?: Record<string, unknown>) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }),
  });
}

function formatUSD(n: number) {
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
  return `$${(n/1_000).toFixed(0)}K`;
}

async function getOrCreateUser(telegramId: number, username: string | undefined, firstName: string | undefined) {
  // Check if user exists
  const { data: existing } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (existing) return existing;

  // Determine tier — admin if it's Joshua
  const isAdmin = String(telegramId) === ADMIN_TELEGRAM_ID;
  const tier = isAdmin ? 'admin' : 'free';

  // Create a fake UUID based on telegram ID for profiles table
  const fakeId = `tg-${telegramId}-0000-0000-0000-000000000000`.slice(0, 36);

  // Insert directly into profiles using telegram_id as identifier
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

  // Create subscription
  await supabase.from('subscriptions').insert({ user_id: data.id, tier });

  return data;
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return new Response('OK'); }

  const message = (body.message ?? body.edited_message) as Record<string, unknown> | undefined;
  if (!message) return new Response('OK');

  const chat = message.chat as Record<string, unknown>;
  const chatId = chat.id as number;
  const from = message.from as Record<string, unknown>;
  const telegramId = from.id as number;
  const username = from.username as string | undefined;
  const firstName = from.first_name as string | undefined;
  const text = (message.text as string | undefined) ?? '';

  // Auto register user on every message
  const profile = await getOrCreateUser(telegramId, username, firstName);

  if (!profile) {
    await reply(chatId, '❌ Error setting up your account. Try again in a moment.');
    return new Response('OK');
  }

  const tier = profile.tier as string;
  const isAdmin = tier === 'admin';
  const isPremium = tier === 'premium' || isAdmin;

  // ── /start ─────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    if (isAdmin) {
      await reply(chatId,
        `👑 <b>Welcome back, Joshua.</b>\n\n` +
        `You have full admin access to Leviathan.\n\n` +
        `<b>Your commands:</b>\n` +
        `/stats — platform stats\n` +
        `/recent — latest whale events\n` +
        `/users — user count\n` +
        `/status — your account\n` +
        `/upgrade — upgrade info\n\n` +
        `🐋 Signals are flowing. Everything is live.`
      );
    } else if (isPremium) {
      await reply(chatId,
        `💎 <b>Welcome back to LEVIATHAN</b>\n\n` +
        `Your Premium access is active.\n\n` +
        `<b>Commands:</b>\n` +
        `/status — your account\n` +
        `/watch [address] [chain] — track a wallet\n` +
        `/unwatchall — clear watchlist\n\n` +
        `Real-time signals are being delivered to you automatically.`
      );
    } else {
      await reply(chatId,
        `🐋 <b>Welcome to LEVIATHAN</b>\n\n` +
        `Smart Whale Intelligence across Ethereum, Base & Solana.\n\n` +
        `You're on the <b>Free tier</b>:\n` +
        `• Up to 5 whale alerts daily\n` +
        `• Moves above $500K\n` +
        `• 15-minute delay\n\n` +
        `💎 <b>Upgrade to Premium — $25 USDT/month</b>\n` +
        `• Real-time signals\n` +
        `• Moves above $100K\n` +
        `• Smart signals + confidence %\n` +
        `• Unlimited alerts\n` +
        `• Cluster detection\n` +
        `• Daily 8AM summary\n\n` +
        `Type /upgrade to get started.\n\n` +
        `<b>Commands:</b>\n/status · /upgrade · /help`
      );
    }
    return new Response('OK');
  }

  // ── /help ──────────────────────────────────────────────────
  if (text === '/help') {
    let msg = `🐋 <b>LEVIATHAN Commands</b>\n\n`;
    msg += `/start — welcome message\n`;
    msg += `/status — your account info\n`;
    msg += `/upgrade — upgrade to Premium\n`;
    if (isPremium) {
      msg += `/watch [address] [chain] — track a wallet\n`;
      msg += `/unwatchall — clear your watchlist\n`;
    }
    if (isAdmin) {
      msg += `\n👑 <b>Admin commands:</b>\n`;
      msg += `/stats — platform statistics\n`;
      msg += `/recent — latest whale events\n`;
      msg += `/users — all users list\n`;
    }
    await reply(chatId, msg);
    return new Response('OK');
  }

  // ── /status ────────────────────────────────────────────────
  if (text === '/status') {
    const tierEmoji = isAdmin ? '👑' : isPremium ? '💎' : '🆓';
    const proUntil = profile.pro_until ? `\n⏳ Premium until: <b>${new Date(profile.pro_until).toDateString()}</b>` : '';
    const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
    const { count: todayCount } = await supabase
      .from('telegram_send_log')
      .select('id', { count: 'exact', head: true })
      .eq('telegram_id', telegramId)
      .gte('sent_at', midnight.toISOString());

    await reply(chatId,
      `${tierEmoji} <b>Your Leviathan Account</b>\n\n` +
      `Tier: <b>${tier.toUpperCase()}</b>${proUntil}\n` +
      `Telegram: @${username ?? 'unknown'}\n` +
      `Signals today: <b>${todayCount ?? 0}${tier === 'free' ? '/5' : ''}</b>\n\n` +
      `${tier === 'free' ? '💎 Type /upgrade to go Premium' : '✅ Full access active'}`
    );
    return new Response('OK');
  }

  // ── /upgrade ───────────────────────────────────────────────
  if (text === '/upgrade') {
    if (isPremium && !isAdmin) {
      await reply(chatId, `💎 You already have Premium access!\n\nType /status to see your expiry date.`);
      return new Response('OK');
    }
    if (isAdmin) {
      await reply(chatId, `👑 You're the admin — you have everything already.`);
      return new Response('OK');
    }

    // Create payment intent
    await reply(chatId,
      `💎 <b>Upgrade to Premium — $25 USDT</b>\n\n` +
      `<b>How to pay:</b>\n\n` +
      `1️⃣ Send exactly <b>25 USDT</b> on Solana to:\n` +
      `<code>ETv38hfME7CYHYXg1KqeL9mBtdEtjNsA3R9Csyc5pfPY</code>\n\n` +
      `2️⃣ After sending, reply with:\n` +
      `<code>/paid [your_solana_wallet]</code>\n\n` +
      `Example:\n` +
      `<code>/paid 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>\n\n` +
      `3️⃣ Premium activates automatically within 2 minutes.\n\n` +
      `⚠️ USDT on Solana only. Do not send from an exchange.`
    );
    return new Response('OK');
  }

  // ── /paid [wallet] ─────────────────────────────────────────
  if (text.startsWith('/paid')) {
    const wallet = text.split(' ')[1];
    if (!wallet || wallet.length < 32) {
      await reply(chatId, `❌ Please include your Solana wallet address.\n\nExample: <code>/paid 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU</code>`);
      return new Response('OK');
    }

    // Check for existing pending intent
    const { data: existingIntent } = await supabase
      .from('payment_intents')
      .select('id')
      .eq('sender_wallet', wallet.toLowerCase())
      .eq('status', 'pending')
      .maybeSingle();

    if (existingIntent) {
      await reply(chatId, `⏳ Payment already being monitored. It will activate within 2 minutes of confirming on-chain.`);
      return new Response('OK');
    }

    // Create payment intent
    const { error } = await supabase.from('payment_intents').insert({
      user_id: profile.id,
      sender_wallet: wallet.toLowerCase(),
      expected_usdt: 25,
      status: 'pending',
    });

    if (error) {
      await reply(chatId, `❌ Error registering payment. Try again.`);
      return new Response('OK');
    }

    await reply(chatId,
      `✅ <b>Payment registered!</b>\n\n` +
      `Monitoring wallet: <code>${wallet.slice(0,8)}...${wallet.slice(-6)}</code>\n\n` +
      `Premium will activate automatically within 2 minutes of your 25 USDT transaction confirming on Solana.\n\n` +
      `You'll receive a confirmation message here when it's done.`
    );
    return new Response('OK');
  }

  // ── /watch [address] [chain] (Premium) ────────────────────
  if (text.startsWith('/watch')) {
    if (!isPremium) {
      await reply(chatId, `🔒 Wallet tracking is a Premium feature.\n\nType /upgrade to get access.`);
      return new Response('OK');
    }
    const parts = text.split(' ');
    const address = parts[1];
    const chain = parts[2]?.toLowerCase() ?? 'ethereum';
    if (!address) { await reply(chatId, `Usage: <code>/watch 0xADDRESS ethereum</code>\nChains: ethereum, base, solana`); return new Response('OK'); }
    if (!['ethereum','base','solana'].includes(chain)) { await reply(chatId, `❌ Invalid chain. Use: ethereum, base, solana`); return new Response('OK'); }
    const { error } = await supabase.from('watchlist').insert({ user_id: profile.id, wallet_address: address.toLowerCase(), chain });
    if (error?.message.includes('unique')) await reply(chatId, `ℹ️ Already watching <code>${address.slice(0,10)}...</code> on ${chain}`);
    else if (error) await reply(chatId, `❌ Error adding wallet.`);
    else await reply(chatId, `✅ Now watching <code>${address.slice(0,10)}...</code> on <b>${chain}</b>\n\nYou'll be alerted when this wallet moves $100K+.`);
    return new Response('OK');
  }

  // ── /unwatchall ────────────────────────────────────────────
  if (text === '/unwatchall') {
    await supabase.from('watchlist').delete().eq('user_id', profile.id);
    await reply(chatId, `✅ Watchlist cleared.`);
    return new Response('OK');
  }

  // ── ADMIN COMMANDS ─────────────────────────────────────────
  if (text === '/stats' && isAdmin) {
    const [{ count: totalUsers }, { count: premiumUsers }, { count: totalEvents }, { count: todayEvents }] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('tier', 'premium'),
      supabase.from('whale_events').select('id', { count: 'exact', head: true }),
      supabase.from('whale_events').select('id', { count: 'exact', head: true }).gte('ingested_at', new Date(Date.now()-86400000).toISOString()),
    ]);
    await reply(chatId,
      `👑 <b>LEVIATHAN STATS</b>\n\n` +
      `👥 Total users: <b>${totalUsers}</b>\n` +
      `💎 Premium users: <b>${premiumUsers}</b>\n` +
      `🆓 Free users: <b>${(totalUsers ?? 0) - (premiumUsers ?? 0)}</b>\n` +
      `🐋 Total events: <b>${totalEvents}</b>\n` +
      `📊 Events today: <b>${todayEvents}</b>`
    );
    return new Response('OK');
  }

  if (text === '/users' && isAdmin) {
    const { data: users } = await supabase
      .from('profiles')
      .select('telegram_username, tier, created_at')
      .order('created_at', { ascending: false })
      .limit(10);
    if (!users?.length) { await reply(chatId, 'No users yet.'); return new Response('OK'); }
    const lines = users.map(u => `• @${u.telegram_username ?? 'unknown'} — ${u.tier.toUpperCase()}`);
    await reply(chatId, `👥 <b>Recent Users</b>\n\n${lines.join('\n')}`);
    return new Response('OK');
  }

  if (text === '/recent' && isAdmin) {
    const { data: events } = await supabase
      .from('whale_events')
      .select('chain, token_symbol, amount_usd, signal, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(5);
    if (!events?.length) { await reply(chatId, 'No events yet.'); return new Response('OK'); }
    const lines = events.map(e => `• ${e.chain.toUpperCase()} ${e.token_symbol} ${formatUSD(Number(e.amount_usd))} — ${e.signal ?? 'neutral'}`);
    await reply(chatId, `🐋 <b>Recent Whale Events</b>\n\n${lines.join('\n')}`);
    return new Response('OK');
  }

  // ── Default ────────────────────────────────────────────────
  await reply(chatId,
    `Type /help to see all commands.`
  );
  return new Response('OK');
});
