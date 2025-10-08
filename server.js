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

const PORT = process.env.PORT || 10000;

// --- Healthcheck (prueba rápida en el navegador) ---
app.get("/", (_, res) => {
  res.json({ message: "✅ Backend activo: ManyChat + WhatsApp + ChatGPT conectado correctamente." });
});

// --- Webhook simple para pruebas con ManyChat/POSTMAN ---
app.post("/webhook", async (req, res) => {
  const { message, imageUrl, audioUrl, channel } = req.body || {};
  console.log("📩 Nuevo mensaje:", { message, imageUrl, audioUrl, channel });
  return res.json({ reply: `Hola 👋, recibí tu mensaje: "${message || "media"}" desde ${channel || "desconocido"}` });
});

/* =========  IA: TRANSCRIBIR NOTA DE VOZ (Whisper) =========
   Body: { "audioUrl": "https://..." }  (URL pública/descargable)
*/
app.post("/voice/transcribe", async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!audioUrl) return res.status(400).json({ error: "Falta audioUrl" });

    // Descarga temporal del audio
    const r = await axios.get(audioUrl, { responseType: "arraybuffer" });
    const tmp = path.join("/tmp", `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmp, r.data);

    // Llamada a Whisper
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

/* =========  IA: ANALIZAR IMAGEN (Vision) =========
   Body: { "imageUrl": "https://...", "prompt": "opcional" }
   Devuelve atributos/keywords para buscar en catálogo
*/
app.post("/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, prompt } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: "Falta imageUrl" });

    const completion = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "Eres experto en moda/productos. Devuelve atributos claros y palabras clave." },
          {
            role: "user",
            content: [
              { type: "text", text: prompt || "Extrae: categoría, tipo, color, tejido, corte, detalles y keywords." },
              { type: "image_url", image_url: { url: imageUrl } }
            ]
          }
        ]
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const attributes = completion.data?.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ attributes });
  } catch (e) {
    console.error("❗/vision/analyze", e?.response?.data || e);
    return res.status(500).json({ error: "Error analizando imagen" });
  }
});

/* =========  BÚSQUEDA EN CATÁLOGO (Shopify Storefront) =========
   Env: SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN
   Body: { "query": "faja colombiana negra talla M" }
*/
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
                id title handle description
                images(first:1){ edges{ node{ url } } }
                variants(first:10){
                  edges{ node{
                    id title availableForSale
                    price{ amount currencyCode }
                  }}
                }
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

app.listen(PORT, () => console.log(`🚀 Servidor en marcha en puerto ${PORT}`));
// === IA: ANÁLISIS DE IMAGEN (Vision) — con modelos configurables y mejor logging ===
app.post("/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, prompt } = req.body || {};
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Falta OPENAI_API_KEY en el entorno" });
    }
    if (!imageUrl) return res.status(400).json({ error: "Falta imageUrl" });

    const payload = {
      model: VISION_MODEL,      // <- usa la variable de entorno
      max_tokens: 400,
      temperature: 0.2,
      messages: [
        { role: "system", content: "Eres experto en moda/productos. Devuelve atributos claros y keywords." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt || "Extrae: categoría, tipo, color, tejido, corte, detalles distintivos y keywords." },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    };

    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    return res.json({ attributes: text });
  } catch (e) {
    const details = e?.response?.data || { message: e.message };
    console.error("OpenAI vision error:", details);
    return res.status(500).json({ error: "OpenAI error", details });
  }
});
