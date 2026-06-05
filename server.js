require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3030;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.use(express.json());

const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE = "https://api.kie.ai";
const INFINITEPAY_HANDLE = process.env.INFINITEPAY_HANDLE;
const OFFER_PRICE = parseInt(process.env.OFFER_PRICE || "1990");
const BUMP_PRICE = parseInt(process.env.BUMP_PRICE || "790");
const LYRICS_ART_PRICE = parseInt(process.env.LYRICS_ART_PRICE || "900");
const BACKEND_URL = process.env.BACKEND_URL || "https://cancoes-backend.onrender.com";

async function nextOrderId() {
  const { data } = await supabase.from("orders").select("id").order("created_at", { ascending: false }).limit(1);
  let counter = 1000;
  if (data && data.length > 0) {
    const last = parseInt(data[0].id.replace("CN-", ""));
    if (!isNaN(last)) counter = last;
  }
  return `CN-${counter + 1}`;
}

async function saveOrder(order) {
  const { error } = await supabase.from("orders").upsert({
    id: order.id, recipient: order.recipient, honoree: order.honoree || "",
    style: order.style, voice: order.voice, story: order.story,
    browser_id: order.browserId || null, price: order.price,
    status: order.status || "created", payment_status: order.paymentStatus || "pending",
    generation_status: order.generationStatus || "pending", lyrics: order.lyrics || "",
    audio_url: order.audioUrl || null, stream_audio_url: order.streamAudioUrl || null,
    duration: order.duration || null, kie_task_ids: order.kieTaskIds || [],
    remake_count: order.remakeCount || 0, lyrics_art_status: order.lyricsArtStatus || "pending",
    customer_name: order.customerName || null, customer_email: order.customerEmail || null,
    customer_phone: order.customerPhone || null, instant_delivery: order.instantDelivery || false,
    cartpanda_checkout_url: order.cartpandaCheckoutUrl || null,
    lyrics_art_checkout_url: order.lyricsArtCheckoutUrl || null,
    transaction_nsu: order.transactionNsu || null, updated_at: new Date().toISOString(),
  });
  if (error) console.error("Supabase error:", error.message);
  return order;
}

async function getOrder(id) {
  const { data } = await supabase.from("orders").select("*").eq("id", id).single();
  if (!data) return null;
  return {
    id: data.id, recipient: data.recipient, honoree: data.honoree, style: data.style,
    voice: data.voice, story: data.story, browserId: data.browser_id, price: data.price,
    status: data.status, paymentStatus: data.payment_status, generationStatus: data.generation_status,
    lyrics: data.lyrics, audioUrl: data.audio_url, streamAudioUrl: data.stream_audio_url,
    duration: data.duration, kieTaskIds: data.kie_task_ids || [], remakeCount: data.remake_count || 0,
    lyricsArtStatus: data.lyrics_art_status, customerName: data.customer_name,
    customerEmail: data.customer_email, customerPhone: data.customer_phone,
    instantDelivery: data.instant_delivery, cartpandaCheckoutUrl: data.cartpanda_checkout_url,
    lyricsArtCheckoutUrl: data.lyrics_art_checkout_url, transactionNsu: data.transaction_nsu,
    createdAt: data.created_at,
  };
}

async function gerarLetra(order) {
  const name = order.honoree || order.recipient || "meu amor";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 600,
        messages: [{ role: "user", content: `Compositor brasileiro. Escreva letra emocionante estilo ${order.style} para ${name} (${order.recipient}). Voz ${order.voice}. História: ${order.story}. IMPORTANTE: retorne APENAS o texto limpo dos versos, sem marcadores [Verso]/[Refrão]/[Ponte], sem títulos #, sem asteriscos **. Só versos separados por linha em branco. Máx 250 palavras.` }],
      }),
    });
    const d = await res.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch (e) { console.warn("Claude erro:", e.message); return null; }
}

function letraPadrao(order) {
  const name = order.honoree || order.recipient || "meu amor";
  return `Eu lembro do começo, do jeito que tudo mudou\nUm detalhe virou destino, e o destino aproximou\n\n${name}, essa canção é pra dizer\nQue a minha vida é mais bonita com você\nMeu amor, meu abrigo, minha paz\nTe escolheria de novo, uma vida inteira e mais\n\nCada história que a gente guardou\nVirou promessa que o tempo confirmou\n\nSe um dia faltar palavra, deixa a música falar`;
}

async function dispararKie(letra, order) {
  const styleMap = { "Sertanejo Romântico": "sertanejo romantico brasileiro", "Gospel Romântico": "gospel romantico brasileiro", "Rock Romântico": "rock romantico", "MPB Romântico": "mpb romantica brasileira" };
  const res = await fetch(`${KIE_BASE}/api/v1/generate`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${KIE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: letra,
      style: `${styleMap[order.style] || "romantico"}, ${order.voice === "Masculina" ? "male vocals" : "female vocals"}, emotional`,
      title: `Homenagem para ${order.honoree || order.recipient || "voce"}`.slice(0, 80),
      customMode: true, instrumental: false, model: "V5_5",
      vocalGender: order.voice === "Masculina" ? "m" : "f",
      callBackUrl: `${BACKEND_URL}/api/webhooks/kie`,
    }),
  });
  const d = await res.json();
  if (!res.ok || !d.data?.taskId) throw new Error(d.msg || "Erro kie.ai");
  return d.data.taskId;
}

app.get("/", (req, res) => res.json({ status: "ok" }));

app.post("/api/orders", async (req, res) => {
  const { recipient, honoree, style, voice, story, browserId, price } = req.body;
  if (!recipient || !style || !voice || !story) return res.status(400).json({ error: "Campos obrigatórios ausentes." });
  const id = await nextOrderId();
  const order = { id, recipient, honoree: honoree || "", style, voice, story, browserId, price: price || OFFER_PRICE / 100, status: "created", paymentStatus: "pending", generationStatus: "pending", lyrics: "", audioUrl: null, streamAudioUrl: null, duration: null, kieTaskIds: [], remakeCount: 0, lyricsArtStatus: "pending", createdAt: new Date().toISOString() };
  await saveOrder(order);
  return res.json({ order });
});

app.post("/api/orders/:id/generate", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  try {
    console.log("Gerando letra para:", order.id);
    const letra = (await gerarLetra(order)) || letraPadrao(order);
    order.lyrics = letra;
    order.generationStatus = "generating";
    await saveOrder(order);
    const [r1, r2] = await Promise.allSettled([dispararKie(letra, order), dispararKie(letra, order)]);
    const ids = [r1, r2].map(r => r.status === "fulfilled" ? r.value : null).filter(Boolean);
    console.log("KIE taskIds:", ids);
    order.kieTaskIds = ids;
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
  for (const taskId of order.kieTaskIds || []) {
    try {
      const r = await fetch(`${KIE_BASE}/api/v1/get-music?taskId=${taskId}`, { headers: { "Authorization": `Bearer ${KIE_API_KEY}` } });
      const d = await r.json();
      const td = d.data;
      if (!td) continue;
      if (td.status === "SUCCESS" || td.status === "FIRST_SUCCESS") {
        const sd = td.response?.sunoData?.[0];
        if (sd?.audioUrl) {
          order.audioUrl = sd.audioUrl; order.streamAudioUrl = sd.streamAudioUrl || sd.audioUrl;
          order.duration = sd.duration; order.generationStatus = "completed";
          await saveOrder(order); break;
        }
      }
    } catch (e) { console.warn("Polling erro:", e.message); }
  }
  return res.json({ order });
});

app.post("/api/orders/:id/remake", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  if ((order.remakeCount || 0) >= 1) return res.status(400).json({ error: "Refação já utilizada." });
  order.remakeCount++; order.audioUrl = null; order.streamAudioUrl = null;
  order.generationStatus = "generating"; order.kieTaskIds = [];
  await saveOrder(order);
  try {
    const taskId = await dispararKie(order.lyrics || letraPadrao(order), order);
    order.kieTaskIds = [taskId]; await saveOrder(order);
    return res.json({ order });
  } catch (e) { order.generationStatus = "failed"; await saveOrder(order); return res.status(500).json({ error: e.message }); }
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
  const total = OFFER_PRICE + (instantDelivery ? BUMP_PRICE : 0);
  const nsu = order.id.replace("CN-", "");
  try {
    const r = await fetch("https://api.checkout.infinitepay.io/links", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${process.env.FRONTEND_URL || "https://kitpopozuda.site"}/?retorno=cartpanda&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay`, order_nsu: nsu, items: [{ quantity: 1, price: total, description: `Música - Pedido ${order.id}` }] }),
    });
    const d = await r.json();
    if (!r.ok || !d.url) throw new Error(d.message || "Erro InfinitePay");
    order.cartpandaCheckoutUrl = d.url; order.customerName = name; order.customerEmail = email;
    order.customerPhone = phone; order.instantDelivery = Boolean(instantDelivery);
    await saveOrder(order);
    return res.json({ payment: { checkoutUrl: d.url, orderId: order.id } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get("/api/orders/:id/payment-status", async (req, res) => {
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  return res.json({ order });
});

app.post("/api/webhooks/infinitepay", async (req, res) => {
  const { order_nsu, transaction_nsu, paid } = req.body;
  if (!order_nsu) return res.json({ success: true });
  const orderId = `CN-${order_nsu}`;
  let order = await getOrder(orderId);
  if (!order) return res.json({ success: true });
  if (paid === true || paid === "true") {
    order.paymentStatus = "paid"; order.transactionNsu = transaction_nsu || null;
    await saveOrder(order); console.log("Pagamento confirmado:", orderId);
  }
  return res.json({ success: true });
});

app.post("/api/webhooks/kie", async (req, res) => {
  try {
    const body = req.body;
    console.log("KIE webhook:", JSON.stringify(body).slice(0, 300));
    const callbackType = body.data?.callbackType || "";
    if (callbackType !== "first" && callbackType !== "complete") return res.json({ success: true });
    const items = body.data?.data || [];
    for (const item of items) {
      const audioUrl = item.audio_url || item.audioUrl;
      const taskId = item.task_id || item.id;
      if (!audioUrl || !taskId) continue;
      const { data: rows } = await supabase.from("orders").select("*").contains("kie_task_ids", [taskId]);
      if (rows && rows.length > 0) {
        const order = await getOrder(rows[0].id);
        if (order && !order.audioUrl) {
          order.audioUrl = audioUrl;
          order.streamAudioUrl = item.stream_audio_url || audioUrl;
          order.duration = item.duration || null;
          order.generationStatus = "completed";
          await saveOrder(order);
          console.log("Audio salvo via webhook:", order.id, audioUrl);
        }
      }
    }
  } catch (e) { console.error("Webhook KIE erro:", e.message); }
  return res.json({ success: true });
});

app.post("/api/orders/:id/lyrics-art/payments/cartpanda/checkout", async (req, res) => {
  let order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: "Pedido não encontrado." });
  try {
    const r = await fetch("https://api.checkout.infinitepay.io/links", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: INFINITEPAY_HANDLE, redirect_url: `${process.env.FRONTEND_URL || "https://kitpopozuda.site"}/?retorno=cartpanda&tipo=lyrics-art&pedido=${order.id}`, webhook_url: `${BACKEND_URL}/api/webhooks/infinitepay-art`, order_nsu: `${order.id.replace("CN-", "")}-art`, items: [{ quantity: 1, price: LYRICS_ART_PRICE, description: `Arte letra - ${order.id}` }] }),
    });
    const d = await r.json();
    if (!r.ok || !d.url) throw new Error(d.message || "Erro arte");
    order.lyricsArtCheckoutUrl = d.url; await saveOrder(order);
    return res.json({ payment: { checkoutUrl: d.url, orderId: order.id }, order });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post("/api/webhooks/infinitepay-art", async (req, res) => {
  const { order_nsu, paid } = req.body;
  if (!order_nsu) return res.json({ success: true });
  const orderId = `CN-${order_nsu.replace("-art", "")}`;
  let order = await getOrder(orderId);
  if (order && (paid === true || paid === "true")) { order.lyricsArtStatus = "paid"; await saveOrder(order); }
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
  console.log("Analytics:", req.body?.event);
  return res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Cancoes backend porta ${PORT}`));
