require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3030;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "https://kitpopozuda.site",
    "http://localhost:3000",
    "http://127.0.0.1:5500",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());

const orders = new Map();
let orderCounter = 1000;
function nextOrderId() { orderCounter += 1; return `CN-${orderCounter}`; }

const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE = "https://api.kie.ai";
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE;
const OFFER_PRICE = parseInt(process.env.OFFER_PRICE || "1990");
const BUMP_PRICE = parseInt(process.env.BUMP_PRICE || "790");
const LYRICS_ART_PRICE = parseInt(process.env.LYRICS_ART_PRICE || "900");

function buildSunoPrompt(order) {
  const { recipient, honoree, style, voice, story } = order;
  const name = honoree || recipient || "meu amor";
  const voiceTag = voice === "Masculina" ? "male vocals" : "female vocals";
  const styleMap = {
    "Sertanejo Romântico": "sertanejo romantico brasileiro",
    "Gospel Romântico": "gospel romantico brasileiro",
    "Rock Romântico": "rock romantico",
    "MPB Romântico": "mpb romantica brasileira",
  };
  const styleTag = styleMap[style] || "romantico brasileiro";
  return {
    prompt: `[Verso 1]\nUma história de amor envolvendo ${name}.\n${story}\n\n[Refrão]\n${name}, essa música é pra você,\nMeu amor, minha vida, minha paz,\nTe escolheria de novo, sempre e mais.\n\n[Verso 2]\nCada detalhe que guardamos juntos,\nVirou a mais bonita das memórias.\n\n[Ponte]\nSe as palavras faltarem, deixa a música falar.`,
    style: `${styleTag}, ${voiceTag}, emotional, romantic, heartfelt`,
    title: `Homenagem para ${name}`.slice(0, 80),
  };
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/api/orders", (req, res) => {
  const { recipient, honoree, style, voice, story, browserId, price } = req.body;
  if (!recipient || !style || !voice || !story) return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  const id = nextOrderId();
  const order = { id, recipient, honoree: honoree || "", style, voice, story, browserId: browserId || null, price: price || OFFER_PRICE / 100, status: "created", paymentStatus: "pending", generationStatus: "pending", lyrics: "", audioUrl: null, streamAudioUrl: null, duration: null, kieTaskId: null, remakeCount: 0, lyricsArtStatus: "pending", createdAt: new Date().toISOString() };
  orders.set(id, order);
  return res.json({ order });
});

app.post("/api/orders/:id/generate", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const { prompt, style, title } = buildSunoPrompt(order);
  try {
    const kieRes = await fetch(`${KIE_BASE}/api/v1/generate`, { method: "POST", headers: { "Authorization": `Bearer ${KIE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt, style, title, customMode: true, instrumental: false, model: "V4", vocalGender: order.voice === "Masculina" ? "m" : "f" }) });
    const kieData = await kieRes.json();
    if (!kieRes.ok || !kieData.data?.taskId) throw new Error(kieData.msg || "Erro ao iniciar geração");
    order.kieTaskId = kieData.data.taskId;
    order.generationStatus = "generating";
    order.lyrics = prompt;
    orders.set(order.id, order);
    return res.json({ order });
  } catch (err) {
    order.generationStatus = "failed";
    orders.set(order.id, order);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders/:id/generation", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (!order.kieTaskId || order.audioUrl) return res.json({ order });
  try {
    const kieRes = await fetch(`${KIE_BASE}/api/v1/get-music?taskId=${order.kieTaskId}`, { headers: { "Authorization": `Bearer ${KIE_API_KEY}` } });
    const kieData = await kieRes.json();
    const taskData = kieData.data;
    if (taskData) {
      const status = taskData.status;
      if (status === "SUCCESS" || status === "FIRST_SUCCESS") {
        const sunoData = taskData.response?.sunoData?.[0];
        if (sunoData) { order.audioUrl = sunoData.audioUrl; order.streamAudioUrl = sunoData.streamAudioUrl || sunoData.audioUrl; order.duration = sunoData.duration; order.generationStatus = "completed"; orders.set(order.id, order); }
      } else if (status === "CREATE_TASK_FAILED" || status === "GENERATE_AUDIO_FAILED") {
        order.generationStatus = "failed"; orders.set(order.id, order);
      }
    }
  } catch (err) { console.warn("Polling erro:", err.message); }
  return res.json({ order });
});

app.post("/api/orders/:id/remake", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if ((order.remakeCount || 0) >= 1) return res.status(400).json({ error: "Refação já utilizada." });
  order.remakeCount = (order.remakeCount || 0) + 1;
  order.audioUrl = null; order.streamAudioUrl = null; order.generationStatus = "pending"; order.kieTaskId = null;
  orders.set(order.id, order);
  const { prompt, style, title } = buildSunoPrompt(order);
  try {
    const kieRes = await fetch(`${KIE_BASE}/api/v1/generate`, { method: "POST", headers: { "Authorization": `Bearer ${KIE_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ prompt, style, title, customMode: true, instrumental: false, model: "V4", vocalGender: order.voice === "Masculina" ? "m" : "f" }) });
    const kieData = await kieRes.json();
    if (!kieRes.ok || !kieData.data?.taskId) throw new Error(kieData.msg || "Erro remake");
    order.kieTaskId = kieData.data.taskId; order.generationStatus = "generating";
    orders.set(order.id, order);
    return res.json({ order });
  } catch (err) { order.generationStatus = "failed"; orders.set(order.id, order); return res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.post("/api/payments/cartpanda/checkout", async (req, res) => {
  const { orderId, name, email, phone, instantDelivery } = req.body;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const totalCents = OFFER_PRICE + (instantDelivery ? BUMP_PRICE : 0);
  const nsu = order.id.replace("CN-", "");
  const frontendUrl = process.env.FRONTEND_URL || "https://kitpopozuda.site";
  const backendUrl = process.env.BACKEND_URL || "https://cancoes-backend.onrender.com";
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&pedido=${order.id}`, webhook_url: `${backendUrl}/api/webhooks/infinitepay`, order_nsu: nsu, items: [{ quantity: 1, price: totalCents, description: `Música personalizada - Pedido ${order.id}` }] }) });
    const ipData = await ipRes.json();
    if (!ipRes.ok || !ipData.url) throw new Error(ipData.message || "Erro InfinitePay");
    order.cartpandaCheckoutUrl = ipData.url; order.customerName = name; order.customerEmail = email; order.customerPhone = phone; order.instantDelivery = Boolean(instantDelivery);
    orders.set(order.id, order);
    return res.json({ payment: { checkoutUrl: ipData.url, orderId: order.id } });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:id/payment-status", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.post("/api/webhooks/infinitepay", (req, res) => {
  const { order_nsu, transaction_nsu, slug, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const orderId = `CN-${order_nsu}`;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
  if (paid === true || paid === "true") { order.paymentStatus = "paid"; order.transactionNsu = transaction_nsu || null; orders.set(orderId, order); console.log(`Pagamento confirmado: ${orderId}`); }
  return res.json({ success: true });
});

app.post("/api/orders/:id/lyrics-art/payments/cartpanda/checkout", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const nsu = `${order.id.replace("CN-", "")}-art`;
  const frontendUrl = process.env.FRONTEND_URL || "https://kitpopozuda.site";
  const backendUrl = process.env.BACKEND_URL || "https://cancoes-backend.onrender.com";
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&tipo=lyrics-art&pedido=${order.id}`, webhook_url: `${backendUrl}/api/webhooks/infinitepay-art`, order_nsu: nsu, items: [{ quantity: 1, price: LYRICS_ART_PRICE, description: `Arte da letra - Pedido ${order.id}` }] }) });
    const ipData = await ipRes.json();
    if (!ipRes.ok || !ipData.url) throw new Error(ipData.message || "Erro arte InfinitePay");
    order.lyricsArtCheckoutUrl = ipData.url; orders.set(order.id, order);
    return res.json({ payment: { checkoutUrl: ipData.url, orderId: order.id }, order });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/api/webhooks/infinitepay-art", (req, res) => {
  const { order_nsu, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const numericNsu = order_nsu.replace("-art", "");
  const orderId = `CN-${numericNsu}`;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
  if (paid === true || paid === "true") { order.lyricsArtStatus = "paid"; orders.set(orderId, order); }
  return res.json({ success: true });
});

app.get("/api/orders/:id/lyrics-art/status", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.get("/api/orders/:id/download", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order || !order.audioUrl) return res.status(404).json({ error: "Áudio não disponível." });
  return res.redirect(302, order.audioUrl);
});

app.post("/api/analytics/events", (req, res) => {
  console.log("Analytics:", req.body?.event, req.body?.orderId || "");
  return res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Canções backend rodando na porta ${PORT}`));
