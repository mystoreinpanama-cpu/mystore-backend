import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Modelos configurables por env (recomendado)
const TEXT_MODEL   = process.env.OPENAI_TEXT_MODEL   || "gpt-5";   // p/ conversación
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";  // p/ imágenes

const PORT = process.env.PORT || 10000;

/* =======================
   SALUD / DIAGNÓSTICO
======================= */
// Healthcheck (GET /)
app.get("/", (_, res) => {
  res.json({
    message: "✅ Backend activo: ManyChat + WhatsApp + ChatGPT conectado correctamente."
  });
});

// GET /webhook (debug opcional)
app.get("/webhook", (_, res) => {
  res.json({ ok: true, hint: "Usa POST a /webhook" });
});

/* =======================
   ECHO WEBHOOK DE PRUEBA
======================= */
// POST /webhook  (prueba con ManyChat/Postman)
app.post("/webhook", async (req, res) => {
  const { message, imageUrl, audioUrl, channel } = req.body || {};
  console.log("📩 Nuevo mensaje:", { message, imageUrl, audioUrl, channel });
  return res.json({
    reply: `Hola 👋, recibí tu mensaje: "${message || "media"}" desde ${channel || "desconocido"}`
  });
});

/* =======================
   IA – TRANSCRIPCIÓN (Whisper)
======================= */
// POST /voice/transcribe
// Body: { "audioUrl": "https://.../audio.ogg" } (url directa o firmada)
app.post("/voice/transcribe", async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY en el entorno" });
    }
    if (!audioUrl) return res.status(400).json({ error: "Falta audioUrl" });

    // Descarga temporal del audio
    const r = await axios.get(audioUrl, { responseType: "arraybuffer" });
    const tmp = path.join("/tmp", `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmp, r.data);

    // Envío a Whisper
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", fs.createReadStream(tmp));

    const resp = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() } }
    );

    try { fs.unlinkSync(tmp); } catch {}
    return res.json({ text: resp.data.text });
  } catch (e) {
    console.error("❗/voice/transcribe", e?.response?.data || e);
    return res.status(500).json({ error: "Error transcribiendo audio" });
  }
});

/* =======================
   IA – VISIÓN (análisis de imagen)
   Evita 'error while downloading' usando data URI
======================= */
// POST /vision/analyze
// Body: { imageUrl: "https://...",  (o)  imageBase64: "data:...base64...",  prompt?: "..." }
app.post("/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, imageBase64, prompt } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY en el entorno" });
    }
    if (!imageUrl && !imageBase64) {
      return res.status(400).json({ error: "Falta imageUrl o imageBase64" });
    }

    // 1) Convertimos a data URI (si viene en URL, la descargamos nosotros)
    let dataUrl;
    if (imageBase64) {
      dataUrl = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
    } else {
      const img = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const mime = img.headers["content-type"] || "image/jpeg";
      const b64  = Buffer.from(img.data, "binary").toString("base64");
      dataUrl = `data:${mime};base64,${b64}`;
    }

    // 2) Llamada al modelo de visión
    const payload = {
      model: VISION_MODEL, // gpt-4o por defecto (configurable por env)
      max_tokens: 400,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Eres experto en moda/productos. Devuelve atributos claros y keywords." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt || "Extrae: categoría, tipo, color, tejido, corte, detalles y keywords." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    };

    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ attributes: text });
  } catch (e) {
    const details = e?.response?.data || { message: e.message };
    console.error("Vision analyze error:", details);
    return res.status(500).json({ error: "OpenAI error", details });
  }
});

/* =======================
   BÚSQUEDA EN CATÁLOGO (Shopify)
======================= */
// POST /catalog/search
// Env necesarios: SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
// Body: { "query": "faja colombiana negra talla M" }
app.post("/catalog/search", async (req, res) => {
  try {
    const { query = "" } = req.body || {};
    if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_STOREFRONT_TOKEN) {
      return res.status(500).json({ error: "Faltan credenciales de Shopify (SHOPIFY_STORE_DOMAIN/STOREFRONT_TOKEN)" });
    }

    const gql = {
      query: `
        query($q: String!) {
          products(first: 5, query: $q) {
            edges {
              node {
                id
                title
                handle
                description
                images(first:1){ edges{ node{ url } } }
                variants(first:10){
                  edges{ node{
                    id
                    title
                    availableForSale
                    price{ amount currencyCode }
                  }}}
              }
            }
          }
        }`,
      variables: { q: query }
    };

    const r = await axios.post(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2024-04/graphql.json`,
      gql,
      {
        headers: {
          "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    const items = (r.data?.data?.products?.edges || []).map(e => {
      const n = e.node;
      return {
        title: n.title,
        url: `https://${process.env.SHOPIFY_STORE_DOMAIN}/products/${n.handle}`,
        image: n.images?.edges?.[0]?.node?.url,
        variants: (n.variants?.edges || []).map(v => ({
          title: v.node.title,
          available: v.node.availableForSale,
          price: v.node.price?.amount,
          currency: v.node.price?.currencyCode
        }))
      };
    });

    return res.json({ results: items });
  } catch (e) {
    console.error("❗/catalog/search", e?.response?.data || e);
    return res.status(500).json({ error: "Error buscando en catálogo" });
  }
});

// Start
app.listen(PORT, () => console.log(`🚀 Servidor en marcha en puerto ${PORT}`));
