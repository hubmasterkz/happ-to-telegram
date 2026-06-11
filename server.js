/**
 * HAPP → Telegram + PostgreSQL — приёмник заявок от голосового агента Володя.
 * Принимает POST /lead, пишет заявку в общую базу (таблица leads, bot='voloda')
 * со СВОЕЙ дневной нумерацией и шлёт карточку в группу [ЛИДЫ] в формате ботов.
 *
 * ENV (Railway → Variables):
 *   DATABASE_URL       — та же строка подключения, что у Нурика/Абылая (общая PostgreSQL)
 *   TELEGRAM_BOT_TOKEN — токен бота Володи
 *   TELEGRAM_CHAT_ID   — id группы [ЛИДЫ]
 *   HAPP_SECRET        — (опционально) пароль; если задан — запрос должен прислать тот же secret
 */

const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT     = process.env.TELEGRAM_CHAT_ID;
const HAPP_SECRET = process.env.HAPP_SECRET || "";
const PORT        = process.env.PORT || 3000;

// CRM webhook (отправка заявок в Google Apps Script CRM)
const CRM_WEBHOOK_URL    = process.env.CRM_WEBHOOK_URL || "https://script.google.com/macros/s/AKfycbwojTX7O0UaOmE4K4EqDmEsrCXxyJTj6MYHmzv1eDalDGeJOr8s034sp4UGmer6BFkG/exec";
const CRM_WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || "hubmaster_crm_2026";

const BOT_NAME = "voloda";       // отдельный бот в общей таблице
const SOURCE   = "HAPP-звонок";
const SHOP     = "Call-центр";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// дата по Алматы (UTC+5) — как в ботах
function getAlmatyDate(d = new Date()) {
  const almaty = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return almaty.toISOString().slice(0, 10);
}

function pick(body, ...keys) {
  for (const k of keys) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// нормализация города: спутник → ближайший крупный (как договаривались)
function normCity(city) {
  if (!city) return "";
  const c = city.trim().toLowerCase();
  if (/^(шахтинск|сарань|абай|темиртау|долинка)/.test(c)) return "Караганда";
  return city.trim();
}

function parseFields(b) {
  return {
    name:    pick(b, "name", "имя", "client_name", "clientName") || "неизвестно",
    phone:   pick(b, "phone", "телефон", "number") || "неизвестно",
    city:    normCity(pick(b, "city", "город")) || "—",
    address: pick(b, "address", "адрес"),
    direction: pick(b, "direction", "направление") || "Окна",
    service: pick(b, "service", "услуга") || "—",
    time:    pick(b, "time", "время") || "по согласованию с менеджером",
    comment: pick(b, "comment", "комментарий"),
  };
}

function buildRaw(f) {
  let r = "Имя: " + f.name + "\n";
  r += "Телефон: " + f.phone + "\n";
  r += "Город: " + f.city + "\n";
  r += "Адрес: " + (f.address || "—") + "\n";
  r += "Направление: " + f.direction + "\n";
  r += "Услуга: " + f.service + "\n";
  r += "Время: " + f.time + "\n";
  r += "Комментарий: " + (f.comment || "—");
  return r;
}

function buildCard(f, dailyNumber, globalId) {
  let t = `🔔 НОВАЯ ЗАЯВКА${globalId ? " #" + globalId : ""} — ${SHOP}\n\n`;
  t += `📋 Заявка №${dailyNumber} за сегодня\n`;
  t += `📞 Источник: ${SOURCE}\n\n`;
  t += `👤 Имя: ${f.name}\n`;
  t += `📱 Телефон: ${f.phone}\n`;
  t += `🏙 Город: ${f.city}\n`;
  if (f.address) t += `📍 Адрес: ${f.address}\n`;
  t += `🔧 Направление: ${f.direction}\n`;
  t += `🛠 Услуга: ${f.service}\n`;
  if (f.comment) t += `💬 Комментарий: ${f.comment}\n`;
  t += `⏰ Время: ${f.time}\n`;
  return t;
}


function normalizePhoneForCrm(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (/^8\d{10}$/.test(digits)) return "+7" + digits.slice(1);
  if (/^7\d{10}$/.test(digits)) return "+" + digits;
  if (/^\d{10}$/.test(digits)) return "+7" + digits;
  return "+" + digits;
}

function buildCrmLeadPayload(f, dailyNumber, globalId, eventType = "new_lead") {
  const phoneCrm = normalizePhoneForCrm(f.phone);
  return {
    secret: CRM_WEBHOOK_SECRET,
    source: SOURCE,
    leadSource: SOURCE,
    sourceNumber: SOURCE,
    sourceBot: BOT_NAME,
    bot: BOT_NAME,
    shopName: SHOP,
    eventType,
    globalId: globalId || null,
    externalId: globalId ? String(globalId) : (BOT_NAME + "_lead_" + String(f.phone || "").replace(/[^\d]/g, "") + "_" + dailyNumber),
    dailyNumber,
    clientName: f.name || "",
    name: f.name || "",
    phone: phoneCrm || f.phone || "",
    waPhone: "",
    city: f.city || "",
    address: f.address || "",
    direction: f.direction || "Без кв.",
    niche: f.direction || "Без кв.",
    service: f.service || "Без кв.",
    preferredTime: f.time || "",
    comment: f.comment || "",
    rawText: buildRaw(f),
    createdAt: new Date().toISOString()
  };
}

async function sendLeadToCrm(f, dailyNumber, globalId, eventType = "new_lead") {
  if (!CRM_WEBHOOK_URL) {
    console.log("⚠️ CRM_WEBHOOK_URL не задан — в CRM не отправляем");
    return { ok: false, skipped: true };
  }
  const payload = buildCrmLeadPayload(f, dailyNumber, globalId, eventType);
  try {
    const resp = await axios.post(CRM_WEBHOOK_URL, payload, {
      headers: { "Content-Type": "application/json", "X-CRM-SECRET": CRM_WEBHOOK_SECRET },
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024
    });
    console.log("✅ CRM: " + payload.externalId + " отправлено, статус " + resp.status);
    return { ok: true };
  } catch (e) {
    console.error("❌ CRM send error:", e.response?.data || e.message);
    return { ok: false, error: e.response?.data || e.message };
  }
}

app.get("/", (_req, res) => res.send("happ-to-telegram OK"));

app.post("/lead", async (req, res) => {
  try {
    if (HAPP_SECRET) {
      const got = req.headers["x-secret"] || req.body?.secret || "";
      if (got !== HAPP_SECRET) return res.status(401).json({ ok: false, error: "bad secret" });
    }
    const f = parseFields(req.body || {});
    const phoneDigits = f.phone.replace(/[^\d]/g, "") || "voloda";

    // дневной номер — СВОЯ нумерация (bot='voloda'), как у Нурика/Абылая по своему боту
    const today = getAlmatyDate();
    let dailyNumber = 1, globalId = null;
    try {
      const maxR = await pool.query(
        `SELECT COALESCE(MAX(daily_number),0) AS maxnum FROM leads
         WHERE bot=$1 AND type IN ('lead','callback')
           AND date AT TIME ZONE 'Asia/Almaty' >= $2::date
           AND date AT TIME ZONE 'Asia/Almaty' < ($2::date + INTERVAL '1 day')`,
        [BOT_NAME, today]
      );
      dailyNumber = (maxR.rows[0].maxnum || 0) + 1;

      const ins = await pool.query(
        `INSERT INTO leads (phone, raw, type, bot, daily_number, date)
         VALUES ($1, $2, 'lead', $3, $4, NOW()) RETURNING id`,
        [phoneDigits, buildRaw(f), BOT_NAME, dailyNumber]
      );
      globalId = ins.rows[0].id;
    } catch (e) {
      console.error("DB error (шлём в телегу без id):", e.message);
    }

    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text: buildCard(f, dailyNumber, globalId),
    });
    console.log(`✅ заявка Володи #${globalId} (№${dailyNumber}) → Telegram`);
    await sendLeadToCrm(f, dailyNumber, globalId, "new_lead");
    res.json({ ok: true, globalId, dailyNumber });
  } catch (e) {
    console.error("send error:", e.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 happ-to-telegram (voloda) на порту ${PORT}`));
