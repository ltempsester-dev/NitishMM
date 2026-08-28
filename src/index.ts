import { Bot, InlineKeyboard, Context } from "grammy";
import { config } from "dotenv";
import http from "http";
config();

type MyContext = Context;

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

const ADMINS = process.env.ADMIN_IDS?.split(',').map(Number) || [];
const FEE = 3; // 3%

// Deal state, shared across chats (group + admin DM).
// NOTE: grammy's session plugin keys data per-chat, but this bot needs to
// read/write groupId and step across two different chats (the group, and
// the admin's private DM) — so we use plain shared variables instead of
// ctx.session, which would otherwise silently desync between chats.
// This also means only one deal can be "in progress" at a time.
let currentGroupId: number | undefined;
let currentStep: 'idle' | 'awaiting_link' | 'awaiting_address' = 'idle';

// Telegram's Bot API has no way to fetch past chat history (that's only
// possible with a user/MTProto client). So we track recent group messages
// ourselves as they arrive, and read from this cache instead.
const recentGroupMessages = new Map<number, string[]>();
const MAX_HISTORY_PER_GROUP = 10;

function recordGroupMessage(chatId: number, text: string) {
  const list = recentGroupMessages.get(chatId) || [];
  list.unshift(text); // newest first
  if (list.length > MAX_HISTORY_PER_GROUP) list.length = MAX_HISTORY_PER_GROUP;
  recentGroupMessages.set(chatId, list);
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
    currentGroupId = update.chat.id;
    
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
  currentStep = 'awaiting_link';
});

bot.callbackQuery("reject", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("❌");
  await ctx.editMessageText("❌ Rejected");
  currentStep = 'idle';
});

// ============ TRACK GROUP MESSAGES ============
// Runs for every text message so we build up a local history for each group,
// since Telegram won't let us fetch it after the fact.
bot.on("message:text", async (ctx, next) => {
  if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
    recordGroupMessage(ctx.chat.id, ctx.message.text);
  }
  await next();
});

// ============ HANDLE DMs ============
bot.on("message:text", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) return;

  // Waiting for invite link
  if (currentStep === 'awaiting_link') {
    const link = ctx.message.text;
    const groupId = currentGroupId;
    
    if (!groupId) {
      return ctx.reply("❌ No group found. Add bot to group first.");
    }
    
    await bot.api.sendMessage(groupId, TEMPLATE);
    await bot.api.sendMessage(groupId, `Please only share this invite link with anyone involved in this deal.\n${link}`);
    await ctx.reply("✅ Template sent!\n\nNow send the wallet address when users provide deal details.");
    currentStep = 'awaiting_address';
    return;
  }

  // Waiting for wallet address
  if (currentStep === 'awaiting_address') {
    const address = ctx.message.text.trim();
    const groupId = currentGroupId;
    
    if (!groupId) {
      return ctx.reply("❌ No group found.");
    }
    
    // Extract amount from our locally tracked group history
    // (Telegram's Bot API can't fetch past messages, so we rely on the
    // cache built by the tracker above.)
    let amount = 0;
    const msgs = recentGroupMessages.get(groupId) || [];
    for (const text of msgs) {
      const match = text.match(/\$?(\d+\.?\d*)/);
      if (match) {
        amount = parseFloat(match[1]);
        break;
      }
    }
    
    const fee = amount * (FEE / 100);
    const total = amount + fee;
    
    await bot.api.sendMessage(groupId, 
      `💰 *Wallet Address:*\n\`${address}\`\n\n` +
      `💵 Amount: $${amount}\n` +
      `📊 Fee (${FEE}%): $${fee.toFixed(2)}\n` +
      `🔢 Total: $${total.toFixed(2)}`,
      { parse_mode: "Markdown" }
    );
    
    // Ask for payment confirmation
    await ctx.reply(
      "🔔 *Payment Status*\n\nHas the payment been received?",
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Received", "paid")
          .text("❌ Not Yet", "notpaid")
      }
    );
    
    currentStep = 'idle';
  }
});

// ============ PAYMENT CONFIRMATION ============
bot.callbackQuery("paid", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("✅ Payment confirmed!");
  
  const groupId = currentGroupId;
  if (groupId) {
    await bot.api.sendMessage(groupId, "✅ Received & confirmed, please start 🎉");
  }
  await ctx.editMessageText("✅ Payment confirmed! Message sent to group.");
});

bot.callbackQuery("notpaid", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("⏳");
  
  const groupId = currentGroupId;
  if (groupId) {
    await bot.api.sendMessage(groupId, "⏳ Payment not received yet. Please wait.");
  }
  await ctx.editMessageText("⏳ Waiting for payment...");
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
bot.start();
console.log("🚀 Middleman Bot is running!");
console.log(`👤 Admins: ${ADMINS.join(', ')}`);
