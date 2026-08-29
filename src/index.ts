import { Bot, InlineKeyboard, Context } from "grammy";
import { config } from "dotenv";
import http from "http";
import { Pool } from "pg";
config();

type MyContext = Context;

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

const ADMINS = process.env.ADMIN_IDS?.split(',').map(Number) || [];
const FEE = 3; // 3%

// ============ DATABASE (Neon Postgres) ============
// Everything the bot needs to "remember" — deal state and recent group
// messages — is stored here instead of plain in-memory variables. This
// means a Render redeploy/restart no longer wipes an in-progress deal
// or the message cache used for amount detection.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_state (
      id INT PRIMARY KEY DEFAULT 1,
      group_id BIGINT,
      step TEXT NOT NULL DEFAULT 'idle',
      CHECK (id = 1)
    );
  `);
  await pool.query(`
    INSERT INTO bot_state (id, group_id, step)
    VALUES (1, NULL, 'idle')
    ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_group_messages_chat_id
    ON group_messages (chat_id, created_at DESC);
  `);
}

type Step = 'idle' | 'awaiting_link' | 'awaiting_network';

async function getState(): Promise<{ groupId: number | null; step: Step }> {
  const { rows } = await pool.query('SELECT group_id, step FROM bot_state WHERE id = 1');
  const row = rows[0];
  return { groupId: row?.group_id ?? null, step: (row?.step as Step) ?? 'idle' };
}

async function setState(fields: { groupId?: number | null; step?: Step }) {
  const current = await getState();
  const groupId = fields.groupId !== undefined ? fields.groupId : current.groupId;
  const step = fields.step !== undefined ? fields.step : current.step;
  await pool.query('UPDATE bot_state SET group_id = $1, step = $2 WHERE id = 1', [groupId, step]);
}

const MAX_HISTORY_PER_GROUP = 10;

async function recordGroupMessage(chatId: number, text: string) {
  await pool.query('INSERT INTO group_messages (chat_id, text) VALUES ($1, $2)', [chatId, text]);
}

async function getRecentGroupMessages(chatId: number): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT text FROM group_messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2',
    [chatId, MAX_HISTORY_PER_GROUP]
  );
  return rows.map(r => r.text);
}

// Pre-configured wallet addresses per network, set via environment
// variables so real addresses are never hardcoded in the code or
// visible on GitHub. Add more networks here (and a matching env var)
// as needed.
const WALLETS: Record<string, string | undefined> = {
  BEP20: process.env.BEP20_ADDRESS,
  TRC20: process.env.TRC20_ADDRESS,
  ERC20: process.env.ERC20_ADDRESS,
};

// Extracts the deal amount from recent group messages using a strict,
// three-tier strategy instead of grabbing the first digit found (which
// could wrongly match a timeframe like "5hr" or a quantity).
//   1. Explicit label: "Amount: 500", "Total: $500", "Price - 500"
//   2. $-prefixed number: "$500"
//   3. Standalone number not glued to letters (rejects "5hr", "3days")
// Returns { amount, matchedText } so callers can tell the admin exactly
// what was matched and where, instead of a silent guess.
function extractAmount(messages: string[]): { amount: number; source: string | null } {
  const labelRegex = /(?:amount|total|price)\s*[:\-]?\s*\$?\s*(\d+(?:\.\d+)?)/i;
  for (const text of messages) {
    const m = text.match(labelRegex);
    if (m) return { amount: parseFloat(m[1]), source: text };
  }

  const dollarRegex = /\$\s*(\d+(?:\.\d+)?)/;
  for (const text of messages) {
    const m = text.match(dollarRegex);
    if (m) return { amount: parseFloat(m[1]), source: text };
  }

  // Standalone number: not immediately preceded/followed by a letter, dot,
  // or digit-run continuation — so "500" matches but "5hr" and "3days" don't.
  const standaloneRegex = /(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/;
  for (const text of messages) {
    const m = text.match(standaloneRegex);
    if (m) return { amount: parseFloat(m[1]), source: text };
  }

  return { amount: 0, source: null };
}

const TEMPLATE = `Hi, To proceed, please provide:
- Buyer's username
- Brief deal description
- Total amount
- Timeframe
- Currency (specify crypto type if applicable)
- Any additional terms

Once everything is provided, please tag me and I'll be available.`;

// ============ BOT ADDED TO GROUP ============
bot.on("my_chat_member", async (ctx) => {
  const update = ctx.update.my_chat_member;
  const newStatus = update.new_chat_member.status;
  // Telegram reports "member" if added normally, or "administrator" if
  // added with admin rights — handle both, since either can happen.
  if (newStatus === "member" || newStatus === "administrator") {
    await setState({ groupId: update.chat.id });

    for (const adminId of ADMINS) {
      await bot.api.sendMessage(adminId,
        `🔔 Bot added to ${update.chat.title}\n\nAccept?`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Accept", "accept")
            .text("❌ Reject", "reject")
        }
      );
    }
  }
});

// ============ ACCEPT/REJECT ============
bot.callbackQuery("accept", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("✅");
  await ctx.editMessageText("✅ Send the invite link now:");
  await setState({ step: 'awaiting_link' });
});

bot.callbackQuery("reject", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("❌");
  await ctx.editMessageText("❌ Rejected");
  await setState({ step: 'idle' });
});

// ============ TRACK GROUP MESSAGES ============
// Runs for every text message so we build up a local history for each group,
// since Telegram won't let us fetch it after the fact.
bot.on("message:text", async (ctx, next) => {
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    await recordGroupMessage(ctx.chat.id, ctx.message.text);
  }
  await next();
});

// ============ HANDLE DMs ============
bot.on("message:text", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) return;

  const { step, groupId } = await getState();

  // Waiting for invite link
  if (step === 'awaiting_link') {
    const link = ctx.message.text;

    if (!groupId) {
      return ctx.reply("❌ No group found. Add bot to group first.");
    }

    await bot.api.sendMessage(groupId, TEMPLATE);
    await bot.api.sendMessage(groupId, `Please only share this invite link with anyone involved in this deal.\n${link}`);

    const networkButtons = new InlineKeyboard();
    for (const network of Object.keys(WALLETS)) {
      networkButtons.text(network, `network:${network}`);
    }
    await ctx.reply(
      "✅ Template sent!\n\nOnce the buyer provides deal details, tap the network to send the wallet address:",
      { reply_markup: networkButtons }
    );
    await setState({ step: 'awaiting_network' });
    return;
  }
});

// ============ NETWORK BUTTON TAPPED (BEP20 / TRC20 / etc.) ============
bot.callbackQuery(/^network:(.+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const { step, groupId } = await getState();
  if (step !== 'awaiting_network') {
    return ctx.answerCallbackQuery("⚠️ Not expecting a network selection right now.");
  }

  const network = ctx.match[1];
  const address = WALLETS[network];

  if (!groupId) {
    await ctx.answerCallbackQuery("❌ No group found.");
    return;
  }
  if (!address) {
    // Missing env var for this network — fail loudly instead of posting
    // "undefined" into the group.
    await ctx.answerCallbackQuery(`⚠️ No ${network} address configured!`);
    await ctx.reply(`⚠️ ${network}_ADDRESS isn't set in the bot's environment variables. Add it in Render → Environment, then redeploy.`);
    return;
  }

  await ctx.answerCallbackQuery(`✅ ${network}`);

  // Extract amount from our persisted group message history using the
  // strict label-based matcher (see extractAmount above).
  const msgs = await getRecentGroupMessages(groupId);
  const { amount, source } = extractAmount(msgs);

  if (amount === 0) {
    // Diagnostic dump: show exactly what the bot has recorded for this
    // group, so a $0 result is immediately explainable instead of a
    // mystery.
    const cacheDump = msgs.length
      ? msgs.map((m, i) => `${i + 1}. "${m.replace(/\n/g, ' / ')}"`).join('\n')
      : '(empty — no group messages recorded at all)';
    await ctx.reply(
      "⚠️ Couldn't find an amount in the recent group messages — sending with $0.\n\n" +
      "Here's exactly what I have recorded for this group:\n" + cacheDump
    );
  } else {
    // Let the admin see exactly what text the amount was pulled from,
    // so a wrong match is obvious immediately instead of silently wrong.
    await ctx.reply(`ℹ️ Amount detected: $${amount} (from: "${source}")`);
  }

  const fee = amount * (FEE / 100);
  const total = amount + fee;

  await bot.api.sendMessage(groupId,
    `💰 *Wallet Address (${network}):*\n\`${address}\`\n\n` +
    `💵 Amount: $${amount}\n` +
    `📊 Fee (${FEE}%): $${fee.toFixed(2)}\n` +
    `🔢 Total: $${total.toFixed(2)}`,
    { parse_mode: "Markdown" }
  );

  // Ask for payment confirmation
  await bot.api.sendMessage(ctx.from.id,
    "🔔 *Payment Status*\n\nHas the payment been received?",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Received", "paid")
        .text("❌ Not Yet", "notpaid")
    }
  );

  await setState({ step: 'idle' });
});

// ============ PAYMENT CONFIRMATION ============
bot.callbackQuery("paid", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("✅ Payment confirmed!");

  const { groupId } = await getState();
  if (groupId) {
    await bot.api.sendMessage(groupId, "received");
  }
  await ctx.editMessageText("✅ Payment confirmed! Message sent to group.");
});

bot.callbackQuery("notpaid", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("⏳");

  const { groupId } = await getState();
  if (groupId) {
    await bot.api.sendMessage(groupId, "⏳ Payment not received yet. Please wait.");
  }
  await ctx.editMessageText("⏳ Waiting for payment...");

  // Re-send the confirmation prompt so the admin can check again later
  // instead of the flow dead-ending with no button to tap.
  for (const adminId of ADMINS) {
    await bot.api.sendMessage(adminId,
      "🔔 *Payment Status*\n\nHas the payment been received?",
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Received", "paid")
          .text("❌ Not Yet", "notpaid")
      }
    );
  }
});

// ============ FAKE HTTP SERVER (Render free tier needs an open port) ============
// Render's free plan only offers "Web Service" hosting, which requires the
// app to bind to a port. Our bot doesn't need HTTP at all — this server
// exists purely so Render's port scan succeeds and doesn't kill the deploy.
const PORT = process.env.PORT || 3000;
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
}).listen(PORT, () => {
  console.log(`🌐 Dummy server listening on port ${PORT}`);
});

// ============ START ============
initDb()
  .then(() => {
    bot.start();
    console.log("🚀 Middleman Bot is running!");
    console.log(`👤 Admins: ${ADMINS.join(', ')}`);
  })
  .catch((err) => {
    console.error("❌ Failed to initialize database:", err);
    process.exit(1);
  });
