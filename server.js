import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import Jimp from "jimp";

// === Audio robusto: valida/convierte cualquier formato a WAV 16 kHz mono ===
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { fileTypeFromBuffer } from "file-type";
ffmpeg.setFfmpegPath(ffmpegPath);

dotenv.config();

// ===== Modelos configurables =====
const TEXT_MODEL        = process.env.OPENAI_TEXT_MODEL        || "gpt-5";       // conversación
const VISION_MODEL      = process.env.OPENAI_VISION_MODEL      || "gpt-4o-mini"; // visión estable con JSON Mode
const STRUCTURE_MODEL   = process.env.OPENAI_STRUCTURE_MODEL   || "gpt-4o-mini"; // para re-estructurar JSON si hace falta

// ===== Imagen: límites y compresión =====
const MAX_IMAGE_BYTES   = parseInt(process.env.MAX_IMAGE_BYTES  || "4000000", 10); // ~4MB
const IMAGE_MAX_WIDTH   = parseInt(process.env.IMAGE_MAX_WIDTH  || "1024", 10);
const ALLOW_HTTP_IMAGE  = (process.env.ALLOW_NON_HTTPS_IMAGES || "false") === "true";

const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 10000;

/* ───────────────────────── Helpers ───────────────────────── */

const isImageContentType = (ct) => (ct || "").toLowerCase().startsWith("image/");

async function fetchImageToDataURI(url) {
  if (!url) throw new Error("URL vacía");
  if (!ALLOW_HTTP_IMAGE && !/^https:\/\//i.test(url)) {
    throw new Error("Solo HTTPS permitido (set ALLOW_NON_HTTPS_IMAGES=true para permitir HTTP)");
  }
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "Accept": "image/*", "User-Agent": "mystore-backend/1.0" }
  });
  const ct = (resp.headers["content-type"] || "").toLowerCase();
  if (!isImageContentType(ct)) {
    let sample = "";
    try { sample = Buffer.from(resp.data).toString("utf8").slice(0, 200); } catch {}
    const err = new Error(`La URL no devolvió una imagen (content-type=${ct || "desconocido"})`);
    err.sample = sample;
    throw err;
  }
  // Comprimir: ancho máx + JPG 80%
  let img = await Jimp.read(resp.data);
  if (img.bitmap.width > IMAGE_MAX_WIDTH) img = img.resize(IMAGE_MAX_WIDTH, Jimp.AUTO);
  const buf = await img.quality(80).getBufferAsync(Jimp.MIME_JPEG);
  if (buf.length > MAX_IMAGE_BYTES) {
    const err = new Error(`Imagen demasiado grande tras compresión (${buf.length} > ${MAX_IMAGE_BYTES})`);
    err.code = "IMAGE_TOO_LARGE";
    throw err;
  }
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

function buildQueryFromAttributes(a = {}) {
  const flat = (x) => (Array.isArray(x) ? x : (x ? [x] : []));
  const add  = (...xs) => xs.filter(Boolean).join(" ");
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

const SYS_SCHEMA = `Eres un analista de PRODUCTOS GENERALES para ecommerce (moda, fajas, electrónica, repuestos auto/cel, cámaras, computación, muebles, hogar, libros, deporte, juguetes, belleza, etc).
Devuelves SOLO JSON (sin texto adicional). Si no reconoces el ítem, usa domain:"other" y rellena keywords.
{
  "domain": "apparel|shapewear|electronics|phones|phone_parts|auto_parts|cameras|computers|furniture|home|books|beauty|toys|sports|other",
  "category": "", "type": "", "brand": "", "model": "",
  "colors": [], "materials": [], "details": [], "features": [],
  "compatibility": [], "part_number": "",
  "size": "", "length": "", "fit": "", "style": "",
  "title": "", "author": "", "language": "", "topic": "",
  "keywords": ""
}`;

/* ──────────────────────── Salud / Diagnóstico ──────────────────────── */
app.get("/", (_, res) => res.json({ message: "✅ Backend activo: ManyChat + WhatsApp + ChatGPT conectado correctamente." }));
app.get("/webhook", (_, res) => res.json({ ok: true, hint: "Usa POST a /webhook" }));

/* ───────────────────────── Webhook eco (pruebas) ───────────────────────── */
app.post("/webhook", (req, res) => {
  const { message, imageUrl, audioUrl, channel } = req.body || {};
  console.log("📩 Nuevo mensaje:", { message, imageUrl, audioUrl, channel });
  res.json({ reply: `Hola 👋, recibí tu mensaje: "${message || "media"}" desde ${channel || "desconocido"}` });
});

/* ───────────────────────── Chat de texto ───────────────────────── */

app.post("/chat/complete", async (req, res) => {
  try {
    const {
      message, // mensaje simple (texto) enviado desde Make o ManyChat
      messages = [],
      system = "Eres el asistente de MY STORE IN PANAMÁ.",
      temperature,
      model // opcional para override puntual
    } = req.body || {};

    const modelToUse = (model || TEXT_MODEL || "").trim() || "gpt-4o-mini";
    const isGPT5 = modelToUse.toLowerCase().startsWith("gpt-5");

    const payload = {
      model: modelToUse,
      messages: [
        { role: "system", content: system },
        ...messages,
        ...(message ? [{ role: "user", content: message }] : [])
      ],
      temperature: typeof temperature === "number" ? temperature : 0.3
    };

    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const output = data?.choices?.[0]?.message?.content?.trim() || "No se generó respuesta.";

    // 🔍 Intent Detection: identifica si es una búsqueda de producto
    const lower = output.toLowerCase();
    let intent = "mensaje_general";
    if (lower.includes("producto") || lower.includes("faja") || lower.includes("comprar") || lower.includes("modelo")) {
      intent = "buscar_producto";
    }

    // 🔢 Ejemplo de product_id simulado (esto se llenará desde Shopify o Render)
    let product_id = null;
    if (intent === "buscar_producto") {
      product_id = "gid://shopify/Product/1234567890123";
    }

    // 🧩 Devuelve estructura estandarizada
    return res.json({
      reply: output,
      intent,
      product_id
    });
  } catch (err) {
    console.error("❌ Error en /chat/complete:", err);
    res.status(500).json({
      reply: "Lo siento, ocurrió un error al generar la respuesta.",
      intent: "error",
      error: err.message
    });
  }
});



app.post("/voice/transcribe", async (req, res) => {
  try {
    const { audioUrl, audioBase64, filename = "input.m4a" } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!audioUrl && !audioBase64)   return res.status(400).json({ error: "Falta audioUrl o audioBase64" });

    const normalizeAudioUrl = (u) => {
      try {
        const url = new URL(u);
        if (url.hostname === "www.dropbox.com") {
          url.hostname = "dl.dropboxusercontent.com";
          url.searchParams.delete("dl");
        }
        return url.toString();
      } catch { return u; }
    };

    const inExt = (filename.split(".").pop() || "m4a").toLowerCase();
    const tmpIn  = `/tmp/in_${Date.now()}.${inExt}`;
    const tmpOut = `/tmp/out_${Date.now()}.wav`;

    if (audioBase64) {
      const b64 = audioBase64.startsWith("data:") ? (audioBase64.split(",")[1] || "") : audioBase64;
      fs.writeFileSync(tmpIn, Buffer.from(b64, "base64"));
    } else {
      const url = normalizeAudioUrl(audioUrl);
      const r = await axios.get(url, {
        responseType: "arraybuffer",
        headers: { "Accept": "audio/*,video/*", "User-Agent": "mystore-backend/1.0" },
        maxRedirects: 5
      });

      // Detecta MIME real por contenido
      const type = await fileTypeFromBuffer(r.data).catch(() => null);
      const headerCT = (r.headers["content-type"] || "").toLowerCase();
      const isAudioVideo =
        (headerCT.startsWith("audio/") || headerCT.startsWith("video/")) ||
        (type && (type.mime.startsWith("audio/") || type.mime.startsWith("video/")));

      if (!isAudioVideo) {
        let sample = "";
        try { sample = Buffer.from(r.data).toString("utf8").slice(0, 160); } catch {}
        return res.status(502).json({
          error: "La URL no devolvió audio/video",
          contentType: headerCT || (type?.mime || "desconocido"),
          sample
        });
      }
      fs.writeFileSync(tmpIn, r.data);
    }

    // Transcodifica a WAV 16 kHz mono
    await new Promise((resolve, reject) => {
      ffmpeg(tmpIn)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .format("wav")
        .on("end", resolve)
        .on("error", reject)
        .save(tmpOut);
    });

    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", fs.createReadStream(tmpOut));

    const { data } = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      maxBodyLength: Infinity
    });

    try { fs.unlinkSync(tmpIn);  } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
    return res.json({ text: data.text });
  } catch (e) {
    return res.status(500).json({ error: "Error transcribiendo audio", details: e?.response?.data || e.message });
  }
});

/* ───────────────────────── Visión (imagen → atributos) ───────────────────────── */
app.post("/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, imageBase64, prompt } = req.body || {};
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!imageUrl && !imageBase64)   return res.status(400).json({ error: "Falta imageUrl o imageBase64" });

    // 1) Normalizar a data URI
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

    // 2) JSON Mode con modelo vision
    const payload1 = {
      model: VISION_MODEL,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYS_SCHEMA },
        { role: "user", content: [
          { type: "text", text: (prompt || "Analiza el artículo para venta online.") + "\nDevuelve SOLO el JSON indicado." },
          { type: "image_url", image_url: { url: dataUrl } }
        ] }
      ]
    };
    let resp = await axios.post("https://api.openai.com/v1/chat/completions", payload1, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }
    });
    let content = resp?.data?.choices?.[0]?.message?.content || "{}";
    let attrs;
    try { attrs = JSON.parse(content); } catch { attrs = {}; }

    // 3) Fallback: si quedó vacío o sin domain, estructura con STRUCTURE_MODEL
    if (!attrs || !attrs.domain) {
      const isGPT5Text = (STRUCTURE_MODEL || "").toLowerCase().startsWith("gpt-5");
      const payload2 = {
        model: STRUCTURE_MODEL,
        messages: [
          { role: "system", content: SYS_SCHEMA },
          { role: "user", content: `Estructura a JSON (exacto al esquema) este texto:\n${content || "(sin texto)"}\nDevuelve SOLO JSON.` }
        ]
      };
      // Solo agregamos response_format si el modelo lo soporta (no GPT-5)
      if (!isGPT5Text) payload2.response_format = { type: "json_object" };

      const r2 = await axios.post("https://api.openai.com/v1/chat/completions", payload2, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }
      });
      try { attrs = JSON.parse(r2?.data?.choices?.[0]?.message?.content || "{}"); }
      catch { attrs = { domain: "other", raw: content || "" }; }
    }

    return res.json({ attributes: attrs });
  } catch (e) {
    let details = e?.response?.data;
    if (Buffer.isBuffer(details)) { try { details = details.toString("utf8"); } catch {} }
    res.status(500).json({ error: "OpenAI error", details: details || e.message });
  }
});

/* ───────────────────────── Búsqueda en catálogo (Shopify) ───────────────────────── */
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
            edges { node {
              id title handle
              images(first:1){ edges{ node{ url } } }
              variants(first:10){ edges{ node{ title availableForSale price{ amount currencyCode } } } }
            } }
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

/* ───────────────────────── Foto → Atributos → Catálogo (1 paso) ───────────────────────── */
app.post("/by-image/search", async (req, res) => {
  try {
    const { data: a } = await axios.post(`${req.protocol}://${req.get("host")}/vision/analyze`, req.body, {
      headers: { "Content-Type": "application/json" }
    });
    const attrs  = a?.attributes || {};
    const query  = buildQueryFromAttributes(attrs);
    let results  = [];

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

app.listen(PORT, () => console.log(`🚀 Servidor en marcha en puerto ${PORT}`));
