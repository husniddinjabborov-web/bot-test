const { Bot } = require("grammy");

// Token Vercel Environment Variables'dan olinadi (kodda saqlanmaydi)
const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN env o'zgaruvchisi topilmadi");

const bot = new Bot(token);

// /start buyrug'iga javob
bot.command("start", (ctx) => ctx.reply("Salom! Xush kelibsiz."));

// Istalgan matnli xabarga javob
bot.on("message:text", (ctx) => ctx.reply(`Siz yozdingiz: ${ctx.message.text}`));

// Botni ishga tushirish (wrapper buni webhook'ga almashtiradi)
bot.start();