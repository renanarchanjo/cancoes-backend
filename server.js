require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3030;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE = "https://api.kie.ai";
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE;
const OFFER_PRICE = parseInt(process.env.OFFER_PRICE || "1990");
const BUMP_PRICE = parseInt(process.env.BUMP_PRICE || "790");
const LYRICS_ART_PRICE = parseInt(process.env.LYRICS_ART_PRICE || "900");
const BACKEND_URL = process.env.BACKEND_URL || "https://cancoes-backend.onrender.com";

let orderCounter = 1000;
async function nextOrderId() {
  const { data } = await supabase.from("orders").select("id").order("created_at", { ascending: false }).limit(1);
  if (data && data.length > 0) {
    const last = parseInt(data[0].id.replace("CN-", ""));
    if (!isNaN(last)) orderCounter = last;
  }
  orderCounter += 1;
  return `CN-${orderCounter}`;
}

async function saveOrder(order) {
  const row = {
    id: order.id,
    recipient: order.recipient,
    honoree: order.honoree || "",
    style: order.style,
    voice: order.voice,
    story: order.story,
    browser_id: order.browserId || null,
    price: order.price,
    status: order.status || "created",
    payment_status: order.paymentStatus || "pending",
    generation_status: order.generationStatus || "pending",
    lyrics: order.lyrics || "",
    audio_url: order.audioUrl || null,
    stream_audio_url: order.streamAudioUrl || null,
    duration: order.duration || null,
    kie_task_ids: order.kieTaskIds || [],
    remake_count: order.remakeCount || 0,
    lyrics_art_status: order.lyricsArtStatus || "pending",
    customer_name: order.customerName || null,
    customer_email: order.customerEmail || null,
    customer_phone: order.customerPhone || null,
    instant_delivery: order.instantDelivery || false,
    cartpanda_checkout_url: order.cartpandaCheckoutUrl || null,
    lyrics_art_checkout_url: order.lyricsArtCheckoutUrl || null,
    transaction_nsu: order.transactionNsu || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("orders").upsert(row);
  if (error) console.error("Supabase save error:", error.message);
  return order;
}

async function getOrder(id) {
  const { data, error } = await supabase.from("orders").select("*").eq("id", id).single();
  if (error || !data) return null;
  return dbToOrder(data);
}

function dbToOrder(row) {
  return {
    id: row.id,
    recipient: row.recipient,
    honoree: row.honoree,
    style: row.style,
    voice: row.voice,
    story: row.story,
    browserId: row.browser_id,
    price: row.price,
    status: row.status,
    paymentStatus: row.payment_status,
    generationStatus: row.generation_status,
    lyrics: row.lyrics,
    audioUrl: row.audio_url,
    streamAudioUrl: row.stream_audio_url,
    duration: row.duration,
    kieTaskIds: row.kie_task_ids || [],
    remakeCount: row.remake_count || 0,
    lyricsArtStatus: row.lyrics_art_status,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    instantDelivery: row.instant_delivery,
    cartpandaCheckoutUrl: row.cartpanda_checkout_url,
    lyricsArtCheckoutUrl: row.lyrics_art_checkout_url,
    transactionNsu: row.transaction_nsu,
    createdAt: row.created_at,
  };
}

async function gerarLetraComClaude(order) {
  const { recipient, honoree, style, voice, story } = order;
  const name = honoree || recipient || "meu amor";
  const prompt = `Você é um compositor brasileiro. Escreva uma letra de música completa e emocionante no estilo ${style} para homenagear ${name} (${recipient}).

História: ${story}

Requisitos:
- Voz ${voice}
- Estrutura com versos, refrão e ponte
- Use detalhes específicos da história
- Tom emotivo e pessoal
- Máximo 300 palavras
- Retorne APENAS a letra limpa, sem marcadores como [Verso], [Refrão], [Ponte], sem títulos com #, sem asteriscos. Só o texto dos versos separados por linha em branco.`;

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
    const raw = data.content?.[0]?.text || "";
    return raw.trim() || null;
  } catch (err) {
    console.warn("Claude indisponível:", err.message);
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
  return {
    prompt: letra,
    style: `${styleTag}, ${voiceTag}, emotional, romantic, heartfelt`,
    title: `Homenagem para ${name}`.slice(0, 80),
    customMode: true,
    instrumental: false,
    model: "V5_5",
    vocalGender: voice === "Masculina" ? "m" : "f",
    callBackUrl: `${BACKEND_URL}/api/webhooks/kie`,
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

function buildLetraPadrao(order) {
  const name = order.honoree || order.recipient || "meu amor";
  return `Eu lembro do começo, do jeito que tudo mudou\nUm detalhe virou destino, e o destino aproximou\n\n${name}, essa canção é pra dizer\nQue a minha vida é mais bonita com você\nMeu amor, meu abrigo, minha paz\nTe escolheria de novo, uma vida inteira e mais\n\nCada história que a gente guardou\nVirou promessa que o tempo confirmou\n\nSe um dia faltar palavra, deixa a música falar`;
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/api/orders", async (req, res) => {
  const { recipient, honoree, style, voice, story, browserId, price } = req.body;
  if (!recipient || !style || !voice || !story) return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  const id = await nextOrderId();
  const order = { id, recipient, honoree: honoree || "", style, voice, story, browserId: browserId || null, price: price || OFFER_PRICE / 100, status: "created", paymentStatus: "pending", generationStatus: "pending", lyrics: "", audioUrl: null, streamAudioUrl: null, duration: null, kieTaskIds: [], remakeCount: 0, lyricsArtStatus: "pending", createdAt: new Date().toISOString() };
  await saveOrder(order);
  return res.json({ order });
});

app.post("/api/orders/:id/generate", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  try {
    console.log("Gerando letra Claude para:", order.id);
    const letra = await gerarLetraComClaude(order);
    order.lyrics = letra || buildLetraPadrao(order);
    order.generationStatus = "generating";
    await saveOrder(order);
    const payload = buildSunoPayload(order, order.lyrics);
    const [r1, r2] = await Promise.allSettled([dispararGeracao(payload), dispararGeracao(payload)]);
    const taskId1 = r1.status === "fulfilled" ? r1.value : null;
    const taskId2 = r2.status === "fulfilled" ? r2.value : null;
    console.log("KIE taskIds:", taskId1, taskId2);
    order.kieTaskIds = [taskId1, taskId2].filter(Boolean);
    await saveOrder(order);
    return res.json({ order });
  } catch (err) {
    console.error("Erro generate:", err.message);
    order.generationStatus = "failed";
    await saveOrder(order);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/orders/:id/generation", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if (order.audioUrl) return res.json({ order });
  const taskIds = order.kieTaskIds || [];
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
          await saveOrder(order);
          break;
        }
      } else if (status === "CREATE_TASK_FAILED" || status === "GENERATE_AUDIO_FAILED") {
        order.generationStatus = "failed";
        await saveOrder(order);
      }
    } catch (err) { console.warn("Polling erro:", err.message); }
  }
  return res.json({ order });
});

app.post("/api/orders/:id/remake", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if ((order.remakeCount || 0) >= 1) return res.status(400).json({ error: "Refação já utilizada." });
  order.remakeCount = (order.remakeCount || 0) + 1;
  order.audioUrl = null; order.streamAudioUrl = null; order.generationStatus = "generating"; order.kieTaskIds = [];
  await saveOrder(order);
  const payload = buildSunoPayload(order, order.lyrics);
  try {
    const taskId = await dispararGeracao(payload);
    order.kieTaskIds = [taskId];
    await saveOrder(order);
    return res.json({ order });
  } catch (err) { order.generationStatus = "failed"; await saveOrder(order); return res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:id", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.post("/api/payments/cartpanda/checkout", async (req, res) => {
  const { orderId, name, email, phone, instantDelivery } = req.body;
  let order = await getOrder(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const totalCents = OFFER_PRICE + (instantDelivery ? BUMP_PRICE : 0);
  const nsu = order.id.replace("CN-", "");
  const frontendUrl = process.env.FRONTEND_URL || "https://kitpopozuda.site";
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay`, order_nsu: nsu, items: [{ quantity: 1, price: totalCents, description: `Música personalizada - Pedido ${order.id}` }] }) });
    const ipData = await ipRes.json();
    if (!ipRes.ok || !ipData.url) throw new Error(ipData.message || "Erro InfinitePay");
    order.cartpandaCheckoutUrl = ipData.url; order.customerName = name; order.customerEmail = email; order.customerPhone = phone; order.instantDelivery = Boolean(instantDelivery);
    await saveOrder(order);
    return res.json({ payment: { checkoutUrl: ipData.url, orderId: order.id } });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get("/api/orders/:id/payment-status", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.post("/api/webhooks/infinitepay", async (req, res) => {
  const { order_nsu, transaction_nsu, slug, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const orderId = `CN-${order_nsu}`;
  let order = await getOrder(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
  if (paid === true || paid === "true") {
    order.paymentStatus = "paid"; order.transactionNsu = transaction_nsu || null;
    await saveOrder(order);
    console.log(`Pagamento confirmado: ${orderId}`);
  }
  return res.json({ success: true });
});

app.post("/api/webhooks/kie", async (req, res) => {
  const body = req.body;
  const taskId = body.taskId || body.data?.taskId;
  const status = body.status || body.data?.status;
  const sunoData = body.data?.response?.sunoData?.[0] || body.response?.sunoData?.[0];
  console.log("KIE webhook:", taskId, status);
  if (taskId && (status === "SUCCESS" || status === "FIRST_SUCCESS") && sunoData?.audioUrl) {
    const { data: rows } = await supabase.from("orders").select("*").contains("kie_task_ids", [taskId]);
    if (rows && rows.length > 0) {
      const order = dbToOrder(rows[0]);
      if (!order.audioUrl) {
        order.audioUrl = sunoData.audioUrl;
        order.streamAudioUrl = sunoData.streamAudioUrl || sunoData.audioUrl;
        order.duration = sunoData.duration;
        order.generationStatus = "completed";
        await saveOrder(order);
        console.log(`Audio via webhook: ${order.id}`);
      }
    }
  }
  return res.json({ success: true });
});

app.post("/api/orders/:id/lyrics-art/payments/cartpanda/checkout", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  const nsu = `${order.id.replace("CN-", "")}-art`;
  const frontendUrl = process.env.FRONTEND_URL || "https://kitpopozuda.site";
  try {
    const ipRes = await fetch("https://api.checkout.infinitepay.io/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${frontendUrl}/?retorno=cartpanda&tipo=lyrics-art&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay-art`, order_nsu: nsu, items: [{ quantity: 1, price: LYRICS_ART_PRICE, description: `Arte da letra - Pedido ${order.id}` }] }) });
    const ipData = await ipRes.json();
    if (!ipRes.ok || !ipData.url) throw new Error(ipData.message || "Erro arte InfinitePay");
    order.lyricsArtCheckoutUrl = ipData.url;
    await saveOrder(order);
    return res.json({ payment: { checkoutUrl: ipData.url, orderId: order.id }, order });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.post("/api/webhooks/infinitepay-art", async (req, res) => {
  const { order_nsu, paid } = req.body;
  if (!order_nsu) return res.status(400).json({ error: "order_nsu ausente" });
  const orderId = `CN-${order_nsu.replace("-art", "")}`;
  let order = await getOrder(orderId);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
  if (paid === true || paid === "true") { order.lyricsArtStatus = "paid"; await saveOrder(order); }
  return res.json({ success: true });
});

app.get("/api/orders/:id/lyrics-art/status", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.get("/api/orders/:id/download", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order || !order.audioUrl) return res.status(404).json({ error: "Áudio não disponível." });
  return res.redirect(302, order.audioUrl);
});

app.post("/api/analytics/events", (req, res) => {
  console.log("Analytics:", req.body?.event, req.body?.orderId || "");
  return res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Cancoes backend porta ${PORT}`));
