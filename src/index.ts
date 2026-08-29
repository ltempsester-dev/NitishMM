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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required by Neon
});

type Step =
  | 'pending_accept'
  | 'awaiting_link'
  | 'awaiting_network'
  | 'awaiting_form_selection'
  | 'awaiting_payment'
  | 'done'
  | 'rejected';

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deals (
      group_id BIGINT PRIMARY KEY,
      group_title TEXT,
      step TEXT NOT NULL DEFAULT 'pending_accept',
      invite_prompt_message_id BIGINT,
      selected_network TEXT,
      pending_forms JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS selected_network TEXT;`);
  await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS pending_forms JSONB;`);
  await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS final_amount NUMERIC;`);
  await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS final_network TEXT;`);
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

async function upsertDeal(groupId: number, groupTitle: string, step: Step) {
  await pool.query(
    `INSERT INTO deals (group_id, group_title, step, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (group_id) DO UPDATE
       SET group_title = EXCLUDED.group_title, step = EXCLUDED.step, updated_at = now()`,
    [groupId, groupTitle, step]
  );
}

async function setDealStep(groupId: number, step: Step) {
  await pool.query('UPDATE deals SET step = $1, updated_at = now() WHERE group_id = $2', [step, groupId]);
}

async function setInvitePromptMessageId(groupId: number, messageId: number) {
  await pool.query('UPDATE deals SET invite_prompt_message_id = $1 WHERE group_id = $2', [messageId, groupId]);
}

async function setPendingForms(groupId: number, network: string, forms: ParsedForm[]) {
  await pool.query(
    `UPDATE deals SET selected_network = $1, pending_forms = $2, step = 'awaiting_form_selection', updated_at = now()
     WHERE group_id = $3`,
    [network, JSON.stringify(forms), groupId]
  );
}

async function setFinalDetails(groupId: number, network: string, amount: number) {
  await pool.query(
    `UPDATE deals SET final_network = $1, final_amount = $2, step = 'awaiting_payment', updated_at = now()
     WHERE group_id = $3`,
    [network, amount, groupId]
  );
}

async function getDeal(groupId: number): Promise<{
  groupId: number;
  groupTitle: string;
  step: Step;
  selectedNetwork: string | null;
  pendingForms: ParsedForm[] | null;
  finalAmount: number | null;
  finalNetwork: string | null;
} | null> {
  const { rows } = await pool.query(
    'SELECT group_id, group_title, step, selected_network, pending_forms, final_amount, final_network FROM deals WHERE group_id = $1',
    [groupId]
  );
  if (!rows[0]) return null;
  return {
    groupId: rows[0].group_id,
    groupTitle: rows[0].group_title,
    step: rows[0].step,
    selectedNetwork: rows[0].selected_network,
    pendingForms: rows[0].pending_forms,
    finalAmount: rows[0].final_amount !== null ? Number(rows[0].final_amount) : null,
    finalNetwork: rows[0].final_network,
  };
}

async function getDealByInvitePromptMessageId(messageId: number): Promise<{ groupId: number; groupTitle: string; step: Step } | null> {
  const { rows } = await pool.query(
    "SELECT group_id, group_title, step FROM deals WHERE invite_prompt_message_id = $1 AND step = 'awaiting_link'",
    [messageId]
  );
  if (!rows[0]) return null;
  return { groupId: rows[0].group_id, groupTitle: rows[0].group_title, step: rows[0].step };
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

const WALLETS: Record<string, string | undefined> = {
  BEP20: process.env.BEP20_ADDRESS,
  TRC20: process.env.TRC20_ADDRESS,
  ERC20: process.env.ERC20_ADDRESS,
};

interface ParsedForm {
  buyer?: string;
  seller?: string;
  description?: string;
  timeframe?: string;
  amount?: string;
  terms?: string;
  raw: string;
}

const FORM_FIELD_PATTERNS: { key: keyof Omit<ParsedForm, 'raw'>; regex: RegExp }[] = [
  { key: 'buyer', regex: /buyer'?s?\s*username\s*[-:]\s*(.+)/i },
  { key: 'seller', regex: /seller'?s?\s*username\s*[-:]\s*(.+)/i },
  { key: 'description', regex: /brief\s*deal\s*description\s*[-:]\s*(.+)/i },
  { key: 'timeframe', regex: /timeframe\s*[-:]\s*(.+)/i },
  { key: 'amount', regex: /amount\s*[-:]\s*(.+)/i },
  { key: 'terms', regex: /any\s*additional\s*terms\s*[-:]\s*(.+)/i },
];

function parseForm(text: string): ParsedForm | null {
  const lines = text.split('\n');
  const result: ParsedForm = { raw: text };
  let matchedCount = 0;

  for (const line of lines) {
    for (const { key, regex } of FORM_FIELD_PATTERNS) {
      const m = line.match(regex);
      if (m && m[1].trim().length > 0) {
        (result as any)[key] = m[1].trim();
        matchedCount++;
      }
    }
  }

  if (matchedCount >= 4 && result.amount) {
    return result;
  }
  return null;
}

function amountFromForm(form: ParsedForm): number {
  const m = form.amount?.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function extractAmountFallback(messages: string[]): { amount: number; source: string | null } {
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

  const standaloneRegex = /(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/;
  for (const text of messages) {
    const m = text.match(standaloneRegex);
    if (m) return { amount: parseFloat(m[1]), source: text };
  }

  return { amount: 0, source: null };
}

const TEMPLATE = `Hi, To proceed, please copy this form and provide:

Buyer's username - 
Seller's username -
Brief deal description -
Timeframe -
Amount -
Any additional terms -

Once everything is provided, please tag me and I'll be available.`;

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.update.my_chat_member;
  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  const justBecameAdmin = newStatus === "administrator" && oldStatus !== "administrator";

  if (justBecameAdmin) {
    const groupId = update.chat.id;
    const groupTitle = ('title' in update.chat && update.chat.title) || 'this group';
    await upsertDeal(groupId, groupTitle, 'pending_accept');

    for (const adminId of ADMINS) {
      await bot.api.sendMessage(adminId,
        `🔔 Bot added to ${groupTitle}\n\nAccept?`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Accept", `accept:${groupId}`)
            .text("❌ Reject", `reject:${groupId}`)
        }
      );
    }
  }
});

bot.callbackQuery(/^accept:(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const groupId = Number(ctx.match[1]);
  const deal = await getDeal(groupId);
  if (!deal) {
    return ctx.answerCallbackQuery("❌ Deal not found (may have expired).");
  }

  await ctx.answerCallbackQuery("✅");
  await ctx.editMessageText(`✅ Accepted: ${deal.groupTitle}`);

  const promptMsg = await bot.api.sendMessage(
    ctx.from.id,
    `Send the invite link for *${deal.groupTitle}* now — reply directly to THIS message so I know which group it's for:`,
    { parse_mode: "Markdown" }
  );

  await setInvitePromptMessageId(groupId, promptMsg.message_id);
  await setDealStep(groupId, 'awaiting_link');
});

bot.callbackQuery(/^reject:(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const groupId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery("❌");
  await ctx.editMessageText("❌ Rejected");
  await setDealStep(groupId, 'rejected');
});

bot.on("message:text", async (ctx, next) => {
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    await recordGroupMessage(ctx.chat.id, ctx.message.text);
  }
  await next();
});

bot.on("message:text", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) return;

  const replyToId = ctx.message.reply_to_message?.message_id;
  if (!replyToId) return;

  const deal = await getDealByInvitePromptMessageId(replyToId);
  if (!deal) return;

  const link = ctx.message.text;
  const groupId = deal.groupId;

  await bot.api.sendMessage(groupId, TEMPLATE);
  await bot.api.sendMessage(groupId, `Please only share this invite link with anyone involved in this deal.\n${link}`);

  const networkButtons = new InlineKeyboard();
  for (const network of Object.keys(WALLETS)) {
    networkButtons.text(network, `network:${network}:${groupId}`);
  }
  await ctx.reply(
    `✅ Template sent to *${deal.groupTitle}*!\n\nOnce the buyer provides deal details, tap the network to send the wallet address:`,
    { parse_mode: "Markdown", reply_markup: networkButtons }
  );
  await setDealStep(groupId, 'awaiting_network');
});

async function finalizeDeal(
  groupId: number,
  groupTitle: string,
  network: string,
  amount: number,
  amountSourceDescription: string,
  fromUserId: number
) {
  const address = WALLETS[network];
  if (!address) {
    await bot.api.sendMessage(fromUserId, `⚠️ ${network}_ADDRESS isn't set in the bot's environment variables. Add it in Render → Environment, then redeploy.`);
    return;
  }

  await bot.api.sendMessage(fromUserId, amountSourceDescription);

  const fee = amount * (FEE / 100);
  const total = amount + fee;

  await bot.api.sendMessage(groupId,
    ` *Wallet Address (${network}):*\n\`${address}\`\n\n` +
    ` Amount: $${amount}\n` +
    ` Fee (${FEE}%): $${fee.toFixed(2)}\n` +
    ` Total: $${total.toFixed(2)}`,
    { parse_mode: "Markdown" }
  );

  await bot.api.sendMessage(fromUserId,
    `🔔 *Payment Status — ${groupTitle}*\n\nHas the payment been received?`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Received", `paid:${groupId}`)
        .text("❌ Not Yet", `notpaid:${groupId}`)
    }
  );

  await setFinalDetails(groupId, network, amount);
}

bot.callbackQuery(/^network:([A-Za-z0-9]+):(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const network = ctx.match[1];
  const groupId = Number(ctx.match[2]);

  const deal = await getDeal(groupId);
  if (!deal || deal.step !== 'awaiting_network') {
    return ctx.answerCallbackQuery("⚠️ This deal isn't awaiting a network selection right now.");
  }
  if (!WALLETS[network]) {
    await ctx.answerCallbackQuery(`⚠️ No ${network} address configured!`);
    await ctx.reply(`⚠️ ${network}_ADDRESS isn't set in the bot's environment variables. Add it in Render → Environment, then redeploy.`);
    return;
  }

  await ctx.answerCallbackQuery(`✅ ${network}`);

  const msgs = await getRecentGroupMessages(groupId);
  const forms = msgs.map(parseForm).filter((f): f is ParsedForm => f !== null);

  if (forms.length >= 2) {
    await setPendingForms(groupId, network, forms);
    const buttons = new InlineKeyboard();
    forms.forEach((_, i) => buttons.text(`Form ${i + 1}`, `form:${i}:${groupId}`));

    const summary = forms
      .map((f, i) => `*Form ${i + 1}:* Buyer: ${f.buyer ?? '?'} | Amount: ${f.amount ?? '?'}`)
      .join('\n');

    await ctx.reply(
      `⚠️ Found ${forms.length} filled forms in *${deal.groupTitle}* — which one should I use?\n\n${summary}`,
      { parse_mode: "Markdown", reply_markup: buttons }
    );
    return;
  }

  let amount: number;
  let sourceMsg: string;

  if (forms.length === 1) {
    amount = amountFromForm(forms[0]);
    sourceMsg = `ℹ️ Amount detected for ${deal.groupTitle}: $${amount} (from filled form — Buyer: ${forms[0].buyer ?? '?'})`;
  } else {
    const { amount: fallbackAmount, source } = extractAmountFallback(msgs);
    amount = fallbackAmount;
    if (amount === 0) {
      const cacheDump = msgs.length
        ? msgs.map((m, i) => `${i + 1}. "${m.replace(/\n/g, ' / ')}"`).join('\n')
        : '(empty — no group messages recorded at all)';
      sourceMsg =
        `⚠️ No filled form found in ${deal.groupTitle}, and no amount detected — sending with $0.\n\n` +
        "Here's exactly what I have recorded for this group:\n" + cacheDump;
    } else {
      sourceMsg = `ℹ️ No filled form found — amount detected for ${deal.groupTitle}: $${amount} (from: "${source}")`;
    }
  }

  await finalizeDeal(groupId, deal.groupTitle, network, amount, sourceMsg, ctx.from.id);
});

bot.callbackQuery(/^form:(\d+):(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const formIndex = Number(ctx.match[1]);
  const groupId = Number(ctx.match[2]);

  const deal = await getDeal(groupId);
  if (!deal || deal.step !== 'awaiting_form_selection' || !deal.pendingForms || !deal.selectedNetwork) {
    return ctx.answerCallbackQuery("⚠️ Not expecting a form selection right now.");
  }

  const form = deal.pendingForms[formIndex];
  if (!form) {
    return ctx.answerCallbackQuery("❌ Invalid form selection.");
  }

  await ctx.answerCallbackQuery(`✅ Form ${formIndex + 1} selected`);

  const amount = amountFromForm(form);
  const sourceMsg = `ℹ️ Using Form ${formIndex + 1} for ${deal.groupTitle}: $${amount} (Buyer: ${form.buyer ?? '?'}, Seller: ${form.seller ?? '?'})`;

  await finalizeDeal(groupId, deal.groupTitle, deal.selectedNetwork, amount, sourceMsg, ctx.from.id);
});

bot.callbackQuery(/^paid:(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const groupId = Number(ctx.match[1]);
  const deal = await getDeal(groupId);

  await ctx.answerCallbackQuery("✅ Payment confirmed!");

  const confirmationMsg =
    deal?.finalAmount != null && deal?.finalNetwork
      ? `✅ Received & confirmed $${deal.finalAmount} in USDT-${deal.finalNetwork}, please start 🙏`
      : "✅ Received & confirmed, please start 🙏";

  await bot.api.sendMessage(groupId, confirmationMsg);
  await ctx.editMessageText(`✅ Payment confirmed for ${deal?.groupTitle ?? groupId}! Message sent to group.`);
  await setDealStep(groupId, 'done');
});

bot.callbackQuery(/^notpaid:(-?\d+)$/, async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  const groupId = Number(ctx.match[1]);
  const deal = await getDeal(groupId);

  await ctx.answerCallbackQuery("⏳");
  await bot.api.sendMessage(groupId, "⏳ Payment not received yet. Please wait.");
  await ctx.editMessageText(`⏳ Waiting for payment... (${deal?.groupTitle ?? groupId})`);

  for (const adminId of ADMINS) {
    await bot.api.sendMessage(adminId,
      `🔔 *Payment Status — ${deal?.groupTitle ?? groupId}*\n\nHas the payment been received?`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Received", `paid:${groupId}`)
          .text("❌ Not Yet", `notpaid:${groupId}`)
      }
    );
  }
});

const PORT = process.env.PORT || 3000;
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running");
}).listen(PORT, () => {
  console.log(`🌐 Dummy server listening on port ${PORT}`);
});

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
