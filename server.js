require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const sequelize = require('./db');
const Image = require('./models/Image');
const Group = require('./models/group');
const { Op } = require('sequelize');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(cors());

// Serve public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const PORT = process.env.PORT || 5003;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';
const BOT_PUBLIC_URL = process.env.BOT_PUBLIC_URL || '';

// DB connection
(async () => {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
    await Group.sync();
    await Image.sync();
  } catch (err) {
    console.error('Unable to connect to DB:', err);
  }
})();

// Telegram bot
let bot;
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is missing in .env');
  process.exit(1);
}
bot = USE_WEBHOOK && BOT_PUBLIC_URL
  ? new TelegramBot(TOKEN)
  : new TelegramBot(TOKEN, { polling: true });

if (!USE_WEBHOOK) console.log('Bot started in polling mode');

// Save image metadata
async function saveImageMeta({ filename, file_id, sender, chat_id, caption }) {
  return await Image.create({ filename, file_id, sender, chat_id, group_id: chat_id, caption });
}

// Photo handler
bot.on('photo', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const groupName = msg.chat.title || 'Private';
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    const caption = msg.caption || '';
    const sender = msg.from.username || `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();

    // Save group
    await Group.upsert({ id: chatId, name: groupName });

    // Download image
    const file = await bot.getFile(fileId);
    const filePath = file.file_path;
    const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

    const ext = path.extname(filePath) || '.jpg';
    const filename = `${chatId}_${Date.now()}${ext}`;
    const outPath = path.join(UPLOAD_DIR, filename);

    const response = await axios({ url, responseType: 'stream' });
    const writer = fs.createWriteStream(outPath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

    await saveImageMeta({ filename, file_id: fileId, sender, chat_id: chatId, caption });
    console.log('Saved photo:', filename);
  } catch (err) {
    console.error('Error in photo handler:', err);
  }
});

// API to fetch images
app.get('/api/images', async (req, res) => {
  try {
    const { group_id, month, year } = req.query;
    const where = {};
    if (group_id) where.group_id = group_id;

    if (month && year) {
      const m = parseInt(month, 10);
      const y = parseInt(year, 10);
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 1);
      where.created_at = { [Op.gte]: start, [Op.lt]: end };
    }

    const images = await Image.findAll({ where, order: [['created_at', 'DESC']] });
    res.json(images.map(img => ({
      id: img.id,
      filename: img.filename,
      url: `/uploads/${img.filename}`,
      sender: img.sender,
      caption: img.caption,
      created_at: img.created_at,
      group_id: img.group_id
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// API to fetch groups
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await Group.findAll({ order: [['name', 'ASC']] });
    res.json(groups.map(g => ({ id: g.id, name: g.name })));
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Serve report.html
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'report.html')));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
