import { Bot, InlineKeyboard, Context, SessionFlavor, session } from "grammy";
import { config } from "dotenv";
config();

// Session type
interface SessionData {
  groupId?: number;
  step: 'idle' | 'awaiting_link' | 'awaiting_address';
}

type MyContext = Context & SessionFlavor<SessionData>;

const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);
bot.use(session({ initial: (): SessionData => ({ step: 'idle' }) }));

const ADMINS = process.env.ADMIN_IDS?.split(',').map(Number) || [];
const FEE = 3; // 3%

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
  if (update.new_chat_member.status === "member") {
    ctx.session.groupId = update.chat.id;
    
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
  ctx.session.step = 'awaiting_link';
});

bot.callbackQuery("reject", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("❌");
  await ctx.editMessageText("❌ Rejected");
  ctx.session.step = 'idle';
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
  if (ctx.session.step === 'awaiting_link') {
    const link = ctx.message.text;
    const groupId = ctx.session.groupId;
    
    if (!groupId) {
      return ctx.reply("❌ No group found. Add bot to group first.");
    }
    
    await bot.api.sendMessage(groupId, TEMPLATE);
    await bot.api.sendMessage(groupId, `🔗 Invite Link: ${link}`);
    await ctx.reply("✅ Template sent!\n\nNow send the wallet address when users provide deal details.");
    ctx.session.step = 'awaiting_address';
    return;
  }

  // Waiting for wallet address
  if (ctx.session.step === 'awaiting_address') {
    const address = ctx.message.text.trim();
    const groupId = ctx.session.groupId;
    
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
    
    ctx.session.step = 'idle';
  }
});

// ============ PAYMENT CONFIRMATION ============
bot.callbackQuery("paid", async (ctx) => {
  if (!ADMINS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery("⛔ Not authorized!");
  }
  await ctx.answerCallbackQuery("✅ Payment confirmed!");
  
  const groupId = ctx.session.groupId;
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
  
  const groupId = ctx.session.groupId;
  if (groupId) {
    await bot.api.sendMessage(groupId, "⏳ Payment not received yet. Please wait.");
  }
  await ctx.editMessageText("⏳ Waiting for payment...");
});

// ============ START ============
bot.start();
console.log("🚀 Middleman Bot is running!");
console.log(`👤 Admins: ${ADMINS.join(', ')}`);
