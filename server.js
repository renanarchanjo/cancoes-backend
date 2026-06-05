require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

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
const BACKEND_URL = process.env.BACKEND_URL || "https://cancoes-backend.onrender.com";

async function gerarLetraComClaude(order) {
  const { recipient, honoree, style, voice, story } = order;
  const name = honoree || recipient || "meu amor";
  const prompt = `Você é um compositor brasileiro. Escreva uma letra de música completa e emocionante no estilo ${style} para homenagear ${name} (${recipient}).

História: ${story}

Requisitos:
- Voz ${voice}
- Estrutura: [Verso 1], [Pré-refrão], [Refrão], [Verso 2], [Ponte], [Refrão final]
- Use detalhes específicos da história
- Tom emotivo e pessoal
- Máximo 300 palavras
- Retorne APENAS a letra, sem explicações`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (err) {
    console.warn("Claude indisponível, usando letra padrão:", err.message);
    return null;
  }
}

function buildSunoPayload(order, letra) {
  const { honoree, recipient, style, voice } = order;
  const name = honoree || recipient || "meu amor";
  const voiceTag = voice === "Masculina" ? "male vocals" : "female vocals";
  const styleMap = {
    "Sertanejo Romântico": "sertanejo romantico brasileiro",
    "Gospel Romântico": "gospel romantico brasileiro",
    "Rock Romântico": "rock romantico",
    "MPB Romântico": "mpb romantica brasileira",
  };
  const styleTag = styleMap[style] || "romantico brasileiro";
  const callBackUrl = `${BACKEND_URL}/api/webhooks/kie`;

  return {
    prompt: letra,
    style: `${styleTag}, ${voiceTag}, emotional, romantic, heartfelt`,
    title: `Homenagem para ${name}`.slice(0, 80),
    customMode: true,
    instrumental: false,
    model: "V5",
    vocalGender: voice === "Masculina" ? "m" : "f",
    callBackUrl,
  };
}

async function dispararGeracao(payload) {
  const res = await fetch(`${KIE_BASE}/api/v1/generate`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KIE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data.data?.taskId) throw new Error(data.msg || "Erro kie.ai");
  return data.data.taskId;
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/api/orders", (req, res) => {
  const { recipient, honoree, style, voice, story, browserId, price } = req.body;
  if (!recipient || !style || !voice || !story) return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  const id = nextOrderId();
  const order = { id, recipient, honoree: honoree || "", style, voice, story, browserId: browserId || null, price: price || OFFER_PRICE / 100, status: "created", paymentStatus: "pending", generationStatus: "pending", lyrics: "", audioUrl: null, streamAudioUrl: null, duration: null, kieTaskIds: [], remakeCount: 0, lyricsArtStatus: "pending", createdAt: new Date().toISOString() };
  orders.set(id, order);
  return res.json({ order });
});

app.post("/api/orders/:id/generate", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });

  try {
    // Gera letra com Claude
    const letra = await gerarLetraComClaude(order);
    order.lyrics = letra || buildLetraPadrao(order);
    order.generationStatus = "generating";
    orders.set(order.id, order);

    const payload = buildSunoPayload(order, order.lyrics);

    // Dispara 2 gerações simultâneas
    const [taskId1, taskId2] = await Promise.allSettled([
      dispararGeracao(payload),
      dispararGeracao(payload),
    ]).then(results => results.map(r => r.status === "fulfilled" ? r.value : null));

    order.kieTaskIds = [taskId1, taskId2].filter(Boolean);
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
  if (order.audioUrl) return res.json({ order });

  const taskIds = order.kieTaskIds || (order.kieTaskId ? [order.kieTaskId] : []);
  if (!taskIds.length) return res.json({ order });

  for (const taskId of taskIds) {
    try {
      const kieRes = await fetch(`${KIE_BASE}/api/v1/get-music?taskId=${taskId}`, { headers: { "Authorization": `Bearer ${KIE_API_KEY}` } });
      const kieData = await kieRes.json();
      const taskData = kieData.data;
      if (!taskData) continue;
      const status = taskData.status;
      if (status === "SUCCESS" || status === "FIRST_SUCCESS") {
        const sunoData = taskData.response?.sunoData?.[0];
        if (sunoData?.audioUrl) {
          order.audioUrl = sunoData.audioUrl;
          order.streamAudioUrl = sunoData.streamAudioUrl || sunoData.audioUrl;
          order.duration = sunoData.duration;
          order.generationStatus = "completed";
          orders.set(order.id, order);
          break;
        }
      }
    } catch (err) { console.warn("Polling erro:", err.message); }
  }
  return res.json({ order });
});

app.post("/api/orders/:id/remake", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if ((order.remakeCount || 0) >= 1) return res.status(400).json({ error: "Refação já utilizada." });
  order.remakeCount = (order.remakeCount || 0) + 1;
  order.audioUrl = null; order.streamAudioUrl = null; order.generationStatus = "generating"; order.kieTaskIds = [];
  orders.set(order.id, order);
  const payload = buildSunoPayload(order, order.lyrics);
  try {
    const taskId = await dispararGeracao(payload);
    order.kieTaskIds = [taskId];
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
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay`, order_nsu: nsu, items: [{ quantity: 1, price: totalCents, description: `Música personalizada - Pedido ${order.id}` }] }) });
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
  const { order_nsu, transaction_nsu, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const orderId = `CN-${order_nsu}`;
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
  if (paid === true || paid === "true") { order.paymentStatus = "paid"; order.transactionNsu = transaction_nsu || null; orders.set(orderId, order); console.log(`Pagamento confirmado: ${orderId}`); }
  return res.json({ success: true });
});

app.post("/api/webhooks/kie", (req, res) => {
  const body = req.body;
  const taskId = body.taskId || body.data?.taskId;
  const status = body.status || body.data?.status;
  const sunoData = body.data?.response?.sunoData?.[0] || body.response?.sunoData?.[0];
  if (taskId && (status === "SUCCESS" || status === "FIRST_SUCCESS") && sunoData?.audioUrl) {
    for (const [id, order] of orders.entries()) {
      const taskIds = order.kieTaskIds || (order.kieTaskId ? [order.kieTaskId] : []);
      if (taskIds.includes(taskId) && !order.audioUrl) {
        order.audioUrl = sunoData.audioUrl;
        order.streamAudioUrl = sunoData.streamAudioUrl || sunoData.audioUrl;
        order.duration = sunoData.duration;
        order.generationStatus = "completed";
        orders.set(id, order);
        console.log(`Audio via webhook: ${id}`);
        break;
      }
    }
  }
  return res.json({ success: true });
});

app.post("/api/orders/:id/lyrics-art/payments/cartpanda/checkout", async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const nsu = `${order.id.replace("CN-", "")}-art`;
  const frontendUrl = process.env.FRONTEND_URL || "https://kitpopozuda.site";
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&tipo=lyrics-art&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay-art`, order_nsu: nsu, items: [{ quantity: 1, price: LYRICS_ART_PRICE, description: `Arte da letra - Pedido ${order.id}` }] }) });
    const ipData = await ipRes.json();
    if (!ipRes.ok || !ipData.url) throw new Error(ipData.message || "Erro arte InfinitePay");
    order.lyricsArtCheckoutUrl = ipData.url; orders.set(order.id, order);
    return res.json({ payment: { checkoutUrl: ipData.url, orderId: order.id }, order });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/api/webhooks/infinitepay-art", (req, res) => {
  const { order_nsu, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const orderId = `CN-${order_nsu.replace("-art", "")}`;
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

function buildLetraPadrao(order) {
  const name = order.honoree || order.recipient || "meu amor";
  return `[Verso 1]\nEu lembro do começo, do jeito que tudo mudou\nUm detalhe virou destino, e o destino aproximou\n\n[Refrão]\n${name}, essa canção é pra dizer\nQue a minha vida é mais bonita com você\nMeu amor, meu abrigo, minha paz\nTe escolheria de novo, uma vida inteira e mais\n\n[Verso 2]\nCada história que a gente guardou\nVirou promessa que o tempo confirmou\n\n[Ponte]\nSe um dia faltar palavra, deixa a música falar`;
}

app.listen(PORT, () => console.log(`Cancoes backend porta ${PORT}`));
