import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import Jimp from "jimp";

dotenv.config();

// Modelos configurables por ENV
const TEXT_MODEL   = process.env.OPENAI_TEXT_MODEL   || "gpt-5";   // conversación/razonamiento
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";  // visión (4o o 4o-mini recomendado)

// Config de imágenes
const MAX_IMAGE_BYTES  = parseInt(process.env.MAX_IMAGE_BYTES  || "4000000", 10); // ~4MB
const IMAGE_MAX_WIDTH  = parseInt(process.env.IMAGE_MAX_WIDTH  || "1024", 10);    // reduce a 1024px
const ALLOW_HTTP_IMAGE = (process.env.ALLOW_NON_HTTPS_IMAGES || "false") === "true";

const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 10000;

/* ======================================
   Helpers
====================================== */
const isImageContentType = (ct) => (ct || "").toLowerCase().startsWith("image/");

// Descarga una URL de imagen, valida y comprime (Jimp), devuelve data URI JPG base64
async function fetchImageToDataURI(url) {
  if (!url) throw new Error("URL vacía");
  if (!ALLOW_HTTP_IMAGE && !/^https:\/\//i.test(url)) {
    throw new Error("Solo se permiten imágenes HTTPS (config ALLOW_NON_HTTPS_IMAGES=true para permitir HTTP)");
  }
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "Accept": "image/*", "User-Agent": "mystore-backend/1.0" }
  });

  const ct = (resp.headers["content-type"] || "").toLowerCase();
  if (!isImageContentType(ct)) {
    let sample = "";
    try { sample = Buffer.from(resp.data).toString("utf8").slice(0, 200); } catch {}
    const msg = `La URL no devolvió una imagen (content-type=${ct || "desconocido"})`;
    const err = new Error(msg);
    err.sample = sample;
    throw err;
  }

  // Comprimir / re-escalar a JPG 80% y máx. width
  let img = await Jimp.read(resp.data);
  if (img.bitmap.width > IMAGE_MAX_WIDTH) {
    img = img.resize(IMAGE_MAX_WIDTH, Jimp.AUTO);
  }
  const buf = await img.quality(80).getBufferAsync(Jimp.MIME_JPEG);
  if (buf.length > MAX_IMAGE_BYTES) {
    const msg = `Imagen demasiado grande tras compresión (${buf.length} bytes > ${MAX_IMAGE_BYTES})`;
    const err = new Error(msg);
    err.code = "IMAGE_TOO_LARGE";
    throw err;
  }
  const b64 = buf.toString("base64");
  return `data:image/jpeg;base64,${b64}`;
}

// Construye query de catálogo según dominio/atributos detectados
function buildQueryFromAttributes(a = {}) {
  const flat = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
  const add = (...xs) => xs.filter(Boolean).join(" ");

  switch ((a.domain || "").toLowerCase()) {
    case "apparel":
    case "shapewear":
      return add(a.category, a.type, a.style, a.length, a.fit, flat(a.colors).join(" "), flat(a.materials).join(" "), flat(a.details).join(" "), a.keywords);
    case "electronics":
    case "phones":
    case "phone_parts":
      return add(a.category, a.type, a.brand, a.model, flat(a.compatibility).join(" "), flat(a.features).join(" "), a.keywords);
    case "auto_parts":
      return add(a.category, a.type, a.brand, a.model, a.part_number, flat(a.compatibility).join(" "), flat(a.features).join(" "), a.keywords);
    case "cameras":
    case "computers":
      return add(a.category, a.type, a.brand, a.model, flat(a.features).join(" "), a.keywords);
    case "furniture":
    case "home":
      return add(a.category, a.type, a.material, a.color, a.size, flat(a.features).join(" "), a.keywords);
    case "books":
      return add(a.title, a.author, a.language, a.topic, a.keywords);
    default:
      return add(a.category, a.type, flat(a.features).join(" "), a.keywords);
  }
}

/* ======================================
   Salud / Diagnóstico
====================================== */
app.get("/", (_, res) => {
  res.json({ message: "✅ Backend activo: ManyChat + WhatsApp + ChatGPT conectado correctamente." });
});
app.get("/webhook", (_, res) => res.json({ ok: true, hint: "Usa POST a /webhook" }));

/* ======================================
   Webhook eco (pruebas)
====================================== */
app.post("/webhook", async (req, res) => {
  const { message, imageUrl, audioUrl, channel } = req.body || {};
  console.log("📩 Nuevo mensaje:", { message, imageUrl, audioUrl, channel });
  res.json({ reply: `Hola 👋, recibí tu mensaje: "${message || "media"}" desde ${channel || "desconocido"}` });
});

/* ======================================
   Chat de texto (modelo de conversación)
====================================== */
app.post("/chat/complete", async (req, res) => {
  try {
    const { messages = [], system = "Eres el asistente de MY STORE IN PANAMÁ." } = req.body || {};
    const payload = {
      model: TEXT_MODEL,
      messages: [{ role: "system", content: system }, ...messages],
      temperature: 0.3
    };
    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    res.json({ output: data?.choices?.[0]?.message?.content || "" });
  } catch (e) {
    res.status(500).json({ error: "OpenAI chat error", details: e?.response?.data || e.message });
  }
});

/* ======================================
   Voz → Texto (Whisper)
====================================== */
app.post("/voice/transcribe", async (req, res) => {
  try {
    const { audioUrl } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!audioUrl) return res.status(400).json({ error: "Falta audioUrl" });

    const r = await axios.get(audioUrl, { responseType: "arraybuffer" });
    const tmp = path.join("/tmp", `audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmp, r.data);

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", fs.createReadStream(tmp));

    const { data } = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() }
    });
    try { fs.unlinkSync(tmp); } catch {}
    res.json({ text: data.text });
  } catch (e) {
    res.status(500).json({ error: "Error transcribiendo audio", details: e?.response?.data || e.message });
  }
});

/* ======================================
   Visión (imagen → atributos multi-categoría)
====================================== */
app.post("/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, imageBase64, prompt } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!imageUrl && !imageBase64)   return res.status(400).json({ error: "Falta imageUrl o imageBase64" });

    // Data URI
    let dataUrl;
    if (imageBase64) {
      const base = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
      const b64  = base.split(",")[1] || "";
      const estBytes = Math.floor((b64.length * 3) / 4);
      if (estBytes > MAX_IMAGE_BYTES) return res.status(413).json({ error: "Imagen demasiado grande (base64)", bytes: estBytes, max: MAX_IMAGE_BYTES });
      dataUrl = base;
    } else {
      dataUrl = await fetchImageToDataURI(imageUrl);
    }

    // Pedimos salida JSON estricta con taxonomía amplia
    const system = `Eres un clasificador y analista de PRODUCTOS GENERALES para ecommerce (moda, fajas, electrónica, repuestos auto/cel, cámaras, computación, muebles, hogar, libros, deporte, juguetes, belleza, etc).
Devuelves SOLO JSON con la siguiente estructura. Si no reconoces una prenda/ítem, usa domain:"other" y rellena keywords.
{
  "domain": "apparel|shapewear|electronics|phones|phone_parts|auto_parts|cameras|computers|furniture|home|books|beauty|toys|sports|other",
  "category": "",
  "type": "",
  "brand": "",
  "model": "",
  "colors": [],
  "materials": [],
  "details": [],
  "features": [],
  "compatibility": [],
  "part_number": "",
  "size": "",
  "length": "",
  "fit": "",
  "style": "",
  "title": "",
  "author": "",
  "language": "",
  "topic": "",
  "keywords": ""
}`;

    const userText =
      (prompt || "Analiza el artículo para venta online.") +
      "\nDevuelve el JSON EXACTO con los campos arriba indicados.";

    const payload = {
      model: VISION_MODEL,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl } }
        ] }
      ]
    };

    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", payload, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }
    });

    let attrs = {};
    try { attrs = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); }
    catch { attrs = { domain: "other", raw: data?.choices?.[0]?.message?.content || "" }; }

    return res.json({ attributes: attrs });
  } catch (e) {
    let details = e?.response?.data;
    if (Buffer.isBuffer(details)) { try { details = details.toString("utf8"); } catch {} }
    res.status(500).json({ error: "OpenAI error", details: details || e.message });
  }
});

/* ======================================
   Búsqueda en catálogo (Shopify)
====================================== */
app.post("/catalog/search", async (req, res) => {
  try {
    const { query = "" } = req.body || {};
    if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_STOREFRONT_TOKEN) {
      return res.json({ results: [], note: "Faltan credenciales Shopify (SHOPIFY_STORE_DOMAIN/STOREFRONT_TOKEN).", query });
    }

    const gql = {
      query: `
        query($q: String!) {
          products(first: 5, query: $q) {
            edges {
              node {
                id title handle
                images(first:1){ edges{ node{ url } } }
                variants(first:10){ edges{ node{ title availableForSale price{ amount currencyCode } } } }
              }
            }
          }
        }`,
      variables: { q: query }
    };

    const r = await axios.post(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2024-04/graphql.json`,
      gql,
      { headers: {
          "X-Shopify-Storefront-Access-Token": process.env.SHOPIFY_STOREFRONT_TOKEN,
          "Content-Type": "application/json"
        } }
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

    res.json({ results: items, query });
  } catch (e) {
    res.status(500).json({ error: "Error buscando en catálogo", details: e?.response?.data || e.message });
  }
});

/* ======================================
   Foto → Atributos → Catálogo (1 paso)
====================================== */
app.post("/by-image/search", async (req, res) => {
  try {
    const { data: a } = await axios.post(`${req.protocol}://${req.get("host")}/vision/analyze`, req.body, {
      headers: { "Content-Type": "application/json" }
    });
    const attrs = a?.attributes || {};
    const query = buildQueryFromAttributes(attrs);

    let results = [];
    if (process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_STOREFRONT_TOKEN && query) {
      const { data: s } = await axios.post(`${req.protocol}://${req.get("host")}/catalog/search`, { query }, {
        headers: { "Content-Type": "application/json" }
      });
      results = s?.results || [];
    }
    res.json({ attributes: attrs, query, results });
  } catch (e) {
    res.status(500).json({ error: "Error en búsqueda por imagen", details: e?.response?.data || e.message });
  }
});

/* ====================================== */
app.listen(PORT, () => console.log(`🚀 Servidor en marcha en puerto ${PORT}`));
