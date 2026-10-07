const { Bot } = require("grammy");

// @BotFather bergan tokenni joylashtiring
const bot = new Bot("7025492427:AAHbLpbkG4sT9yHjP7AQ7ds_Q4Si-rxdXN8");

// /start buyrug'iga javob
bot.command("start", (ctx) => ctx.reply("Salom! Xush kelibsiz."));

// Istalgan matnli xabarga javob
bot.on("message:text", (ctx) => ctx.reply(`Siz yozdingiz: ${ctx.message.text}`));

// Botni ishga tushirish
bot.start();
