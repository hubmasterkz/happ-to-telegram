/**
 * HAPP → Telegram — приёмник заявок от голосового агента Володя.
 * Принимает POST с полями заявки, форматирует по шаблону ботов и шлёт в группу [ЛИДЫ].
 *
 * ENV (задаются в Railway → Variables):
 *   TELEGRAM_BOT_TOKEN — токен телеграм-бота (тот же, что у Нурика/Абылая)
 *   TELEGRAM_CHAT_ID   — id группы [ЛИДЫ] (тот же, что у ботов)
 *   HAPP_SECRET        — (опционально) простой пароль; если задан, запрос должен прислать тот же secret
 */

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID;
const HAPP_SECRET = process.env.HAPP_SECRET || "";
const PORT       = process.env.PORT || 3000;

const SOURCE   = "HAPP-звонок";
const SHOP     = "HUB MASTER";

// мягко достаём поле из тела запроса по нескольким возможным именам
function pick(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function buildCard(b) {
  const name    = pick(b, "name", "имя", "client_name", "clientName") || "неизвестно";
  const phone   = pick(b, "phone", "телефон", "number") || "неизвестно";
  const city    = pick(b, "city", "город") || "—";
  const addr    = pick(b, "address", "адрес");
  const dir     = pick(b, "direction", "направление") || "Окна";
  const service = pick(b, "service", "услуга") || "—";
  const time    = pick(b, "time", "время") || "по согласованию с менеджером";
  const comment = pick(b, "comment", "комментарий");

  let t = `🔔 НОВАЯ ЗАЯВКА — ${SHOP}\n\n`;
  t += `📞 Источник: ${SOURCE}\n\n`;
  t += `👤 Имя: ${name}\n`;
  t += `📱 Телефон: ${phone}\n`;
  t += `🏙 Город: ${city}\n`;
  if (addr) t += `📍 Адрес: ${addr}\n`;
  t += `🔧 Направление: ${dir}\n`;
  t += `🛠 Услуга: ${service}\n`;
  if (comment) t += `💬 Комментарий: ${comment}\n`;
  t += `⏰ Время: ${time}\n`;
  return t;
}

app.get("/", (_req, res) => res.send("happ-to-telegram OK"));

app.post("/lead", async (req, res) => {
  try {
    if (HAPP_SECRET) {
      const got = req.headers["x-secret"] || req.body?.secret || "";
      if (got !== HAPP_SECRET) {
        console.warn("⛔ неверный secret");
        return res.status(401).json({ ok: false, error: "bad secret" });
      }
    }
    if (!TG_TOKEN || !TG_CHAT) {
      console.error("❌ нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
      return res.status(500).json({ ok: false, error: "telegram not configured" });
    }

    const text = buildCard(req.body || {});
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text,
    });
    console.log("✅ заявка отправлена в Telegram");
    res.json({ ok: true });
  } catch (e) {
    console.error("send error:", e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 happ-to-telegram на порту ${PORT}`));
