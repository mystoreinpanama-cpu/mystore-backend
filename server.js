import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 10000;

// Endpoint de prueba
app.get("/", (req, res) => {
  res.json({ message: "✅ Backend activo: ManyChat + WhatsApp + ChatGPT conectado correctamente." });
});

// Ejemplo: recibir webhook desde ManyChat o Meta
app.post("/webhook", async (req, res) => {
  const { message, imageUrl, audioUrl, channel } = req.body;
  console.log("📩 Nuevo mensaje recibido:", { message, imageUrl, audioUrl, channel });

  try {
    // Aquí puedes añadir tu lógica para ChatGPT o Shopify
    const reply = `Hola 👋, recibí tu mensaje: "${message || 'media'}" desde ${channel}`;
    res.json({ reply });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor en marcha en puerto ${PORT}`));
