require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { Telegraf, Markup } = require('telegraf');

const {
  BOT_TOKEN, WEBAPP_URL, ADMIN_ID,
  BOT_USERNAME = '', ADSGRAM_BLOCK_ID = '', REWARD_SECRET = 'change_me',
  DB_PATH = './data.db', PORT = 3000, TEST_MODE = '0',
} = process.env;

const num = (v, d) => (v !== undefined && v !== '' ? Number(v) : d);
const CFG = {
  joinBonus: num(process.env.JOIN_BONUS, 2),
  refBonus: num(process.env.REF_BONUS, 5),
  adReward: num(process.env.AD_REWARD, 0.3),
  dailyAds: num(process.env.DAILY_ADS, 20),
  minWithdraw: num(process.env.MIN_WITHDRAW, 100),
};

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error('BOT_TOKEN এবং WEBAPP_URL সেট করুন');
  process.exit(1);
}

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY, name TEXT, balance REAL DEFAULT 0, total REAL DEFAULT 0,
  referrer_id INTEGER, ads_today INTEGER DEFAULT 0, ads_day TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, chat TEXT, link TEXT, reward REAL
);
CREATE TABLE IF NOT EXISTS user_tasks (
  user_id INTEGER, task_id INTEGER, PRIMARY KEY (user_id, task_id)
);
CREATE TABLE IF NOT EXISTS withdraws (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, method TEXT, number TEXT,
  amount REAL, status TEXT DEFAULT 'pending', created_at INTEGER
);
`);

const today = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10); // বাংলাদেশ সময়

function credit(id, amt) {
  db.prepare('UPDATE users SET balance=balance+?, total=total+? WHERE tg_id=?').run(amt, amt, id);
}

function ensureUser(id, name, ref) {
  let u = db.prepare('SELECT * FROM users WHERE tg_id=?').get(id);
  if (u) return u;
  const refOk = ref && ref !== id && db.prepare('SELECT 1 FROM users WHERE tg_id=?').get(ref);
  db.prepare(
    'INSERT INTO users (tg_id,name,balance,total,referrer_id,ads_day,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, name, CFG.joinBonus, CFG.joinBonus, refOk ? ref : null, today(), Date.now());
  if (refOk) credit(ref, CFG.refBonus);
  return db.prepare('SELECT * FROM users WHERE tg_id=?').get(id);
}

function freshUser(id) {
  db.prepare('UPDATE users SET ads_today=0, ads_day=? WHERE tg_id=? AND (ads_day IS NULL OR ads_day<>?)')
    .run(today(), id, today());
  return db.prepare('SELECT * FROM users WHERE tg_id=?').get(id);
}

function rewardAd(id) {
  const u = freshUser(id);
  if (!u || u.ads_today >= CFG.dailyAds) return false;
  db.prepare('UPDATE users SET ads_today=ads_today+1 WHERE tg_id=?').run(id);
  credit(id, CFG.adReward);
  return true;
}

// ---------- Telegram initData যাচাই (HMAC) ----------
function verifyInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if (calc !== hash) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
    return JSON.parse(p.get('user'));
  } catch (e) {
    return null;
  }
}

function auth(req, res, next) {
  const user = verifyInitData(req.get('x-init-data') || '');
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.uid = user.id;
  req.tgName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  next();
}

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
const isAdmin = (ctx) => String(ctx.from.id) === String(ADMIN_ID);

bot.start(async (ctx) => {
  const ref = Number(ctx.startPayload) || null;
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
  ensureUser(ctx.from.id, name, ref);
  await ctx.reply(
    '🎁 অভিনন্দন! সহজ কাজ করে টাকা ইনকাম বটে আপনাকে স্বাগতম 💸\n\nনিচের বাটনে ক্লিক করে ইনকাম শুরু করুন 👇',
    Markup.inlineKeyboard([[Markup.button.webApp('💰 ইনকাম শুরু করুন', WEBAPP_URL)]])
  );
});

bot.command('stats', (ctx) => {
  if (!isAdmin(ctx)) return;
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const pend = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM withdraws WHERE status='pending'").get();
  ctx.reply(`👥 ইউজার: ${users}\n⏳ পেন্ডিং উইথড্র: ${pend.c} টি (৳${pend.s})`);
});

// /addtask শিরোনাম | @channelusername | রিওয়ার্ড
bot.command('addtask', (ctx) => {
  if (!isAdmin(ctx)) return;
  const [title, chat, reward] = ctx.message.text.replace('/addtask', '').split('|').map((s) => s.trim());
  if (!title || !chat || !chat.startsWith('@') || !Number(reward))
    return ctx.reply('ফরম্যাট:\n/addtask চ্যানেলে জয়েন করুন | @channelusername | 2');
  const link = 'https://t.me/' + chat.slice(1);
  db.prepare('INSERT INTO tasks (title,chat,link,reward) VALUES (?,?,?,?)').run(title, chat, link, Number(reward));
  ctx.reply('✅ টাস্ক যোগ হয়েছে। মনে রাখুন: বটকে ওই চ্যানেলের অ্যাডমিন বানাতে হবে।');
});

bot.command('deltask', (ctx) => {
  if (!isAdmin(ctx)) return;
  const id = Number(ctx.message.text.split(' ')[1]);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  ctx.reply('🗑 মুছে ফেলা হয়েছে');
});

bot.command('tasks', (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = db.prepare('SELECT * FROM tasks').all();
  ctx.reply(rows.length ? rows.map((t) => `${t.id}. ${t.title} (${t.chat}) ৳${t.reward}`).join('\n') : 'কোনো টাস্ক নেই');
});

bot.action(/^wd_(ok|no)_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('অনুমতি নেই');
  const w = db.prepare('SELECT * FROM withdraws WHERE id=?').get(ctx.match[2]);
  if (!w || w.status !== 'pending') return ctx.answerCbQuery('আগেই সম্পন্ন হয়েছে');
  if (ctx.match[1] === 'ok') {
    db.prepare("UPDATE withdraws SET status='paid' WHERE id=?").run(w.id);
    bot.telegram.sendMessage(w.user_id, `✅ আপনার ৳${w.amount} উইথড্র সম্পন্ন হয়েছে (${w.method} ${w.number})`).catch(() => {});
  } else {
    db.prepare("UPDATE withdraws SET status='rejected' WHERE id=?").run(w.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(w.amount, w.user_id);
    bot.telegram.sendMessage(w.user_id, `❌ আপনার ৳${w.amount} উইথড্র বাতিল হয়েছে, টাকা ব্যালেন্সে ফেরত গেছে।`).catch(() => {});
  }
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\nস্ট্যাটাস: ${ctx.match[1] === 'ok' ? 'Paid ✅' : 'Rejected ❌'}`);
});

// ---------- Web server / API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('ok'));

app.get('/api/me', auth, (req, res) => {
  ensureUser(req.uid, req.tgName, null);
  const u = freshUser(req.uid);
  const refs = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer_id=?').get(req.uid).c;
  const tasks = db.prepare(
    'SELECT t.id,t.title,t.link,t.reward, EXISTS(SELECT 1 FROM user_tasks ut WHERE ut.task_id=t.id AND ut.user_id=?) AS done FROM tasks t'
  ).all(req.uid);
  const withdraws = db.prepare('SELECT * FROM withdraws WHERE user_id=? ORDER BY id DESC LIMIT 20').all(req.uid);
  res.json({
    id: u.tg_id, name: u.name, balance: u.balance, total: u.total, adsToday: u.ads_today, refs, tasks, withdraws,
    cfg: { ...CFG, botUsername: BOT_USERNAME, adsgramBlockId: ADSGRAM_BLOCK_ID, testMode: TEST_MODE === '1' },
  });
});

app.post('/api/task/claim', auth, async (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.body.id);
  if (!t) return res.json({ error: 'টাস্ক পাওয়া যায়নি' });
  if (db.prepare('SELECT 1 FROM user_tasks WHERE user_id=? AND task_id=?').get(req.uid, t.id))
    return res.json({ error: 'আপনি আগেই বোনাস নিয়েছেন' });
  try {
    const m = await bot.telegram.getChatMember(t.chat, req.uid);
    if (!['member', 'administrator', 'creator'].includes(m.status))
      return res.json({ error: 'আগে চ্যানেলে জয়েন করুন' });
  } catch (e) {
    return res.json({ error: 'যাচাই করা যায়নি, একটু পরে চেষ্টা করুন' });
  }
  const r = db.prepare('INSERT OR IGNORE INTO user_tasks (user_id,task_id) VALUES (?,?)').run(req.uid, t.id);
  if (!r.changes) return res.json({ error: 'আপনি আগেই বোনাস নিয়েছেন' });
  credit(req.uid, t.reward);
  res.json({ ok: true, reward: t.reward });
});

// Adsgram সার্ভার এই URL কল করে (Reward URL)। ইউজার ফ্রন্টএন্ড থেকে টাকা বাড়াতে পারে না।
app.get('/adsgram-reward', (req, res) => {
  if (req.query.secret !== REWARD_SECRET) return res.sendStatus(403);
  const id = Number(req.query.userid);
  if (!id || !db.prepare('SELECT 1 FROM users WHERE tg_id=?').get(id)) return res.sendStatus(404);
  rewardAd(id);
  res.sendStatus(200);
});

// শুধু টেস্টের জন্য (TEST_MODE=1)। লাইভে 0 রাখুন।
app.post('/api/ad/test', auth, (req, res) => {
  if (TEST_MODE !== '1') return res.sendStatus(404);
  res.json({ ok: rewardAd(req.uid) });
});

app.post('/api/withdraw', auth, (req, res) => {
  const { method, number, amount } = req.body || {};
  const amt = Number(amount);
  if (!['bKash', 'Nagad'].includes(method)) return res.json({ error: 'মেথড ঠিক নয়' });
  if (!/^01\d{9}$/.test(String(number))) return res.json({ error: 'সঠিক ১১ ডিজিটের নম্বর দিন' });
  if (!(amt >= CFG.minWithdraw)) return res.json({ error: `সর্বনিম্ন উইথড্র ৳${CFG.minWithdraw}` });
  const make = db.transaction(() => {
    const r = db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=? AND balance>=?').run(amt, req.uid, amt);
    if (!r.changes) return null;
    return db.prepare('INSERT INTO withdraws (user_id,method,number,amount,created_at) VALUES (?,?,?,?,?)')
      .run(req.uid, method, String(number), amt, Date.now()).lastInsertRowid;
  });
  const id = make();
  if (!id) return res.json({ error: 'ব্যালেন্স যথেষ্ট নয়' });
  if (ADMIN_ID) {
    bot.telegram.sendMessage(
      ADMIN_ID,
      `💳 নতুন উইথড্র #${id}\nইউজার: ${req.uid}\n${method}: ${number}\nপরিমাণ: ৳${amt}`,
      Markup.inlineKeyboard([[
        Markup.button.callback('✅ Paid', `wd_ok_${id}`),
        Markup.button.callback('❌ Reject', `wd_no_${id}`),
      ]])
    ).catch(() => {});
  }
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('Server চালু, পোর্ট', PORT));
bot.launch().then(() => console.log('Bot বন্ধ হয়েছে')).catch((e) => console.error('Bot error', e));
bot.telegram.getMe().then((me) => console.log('Bot চালু: @' + me.username));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
