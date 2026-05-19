require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_KEY   = process.env.GEMINI_KEY;
const PLANET_KEY   = process.env.PLANET_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// 30 requests por minuto por IP
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// ─── helper: llama a Gemini ──────────────────────────────────────────────────
async function gemini(parts, maxTokens = 4000, jsonMode = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const config = { maxOutputTokens: maxTokens, temperature: 0.3 };
  if (jsonMode) config.responseMimeType = 'application/json';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: config })
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || `Gemini ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── ANÁLISIS DE FOTO ────────────────────────────────────────────────────────
app.post('/api/vision', async (req, res) => {
  try {
    const { image, mimeType, vegType, notes, stats } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagen requerida' });

    const sys = `Sos un ingeniero agrónomo experimentado. Analizás fotos de vegetación y respondés en español rioplatense. Estructurá tu respuesta en 5 secciones numeradas: 1) Diagnóstico probable (2-3 líneas), 2) Posibles causas con probabilidad estimada (%), 3) Acciones inmediatas (qué hacer hoy), 4) Acciones a 7-15 días, 5) Qué confirmar (análisis o pruebas). Sé concreto, profesional y accionable.`;
    const usr = `Foto de vegetación. Tipo: ${vegType}. Notas: ${notes || 'ninguna'}. Análisis automático: verde ${(stats?.greenDark + stats?.greenLight || 0).toFixed(1)}%, amarillo ${(stats?.yellow || 0).toFixed(1)}%, marrón ${(stats?.brown || 0).toFixed(1)}%, NDVI visual ${(stats?.visualNDVI || 0).toFixed(2)}.`;

    const text = await gemini([
      { text: sys + '\n\n' + usr },
      { inline_data: { mime_type: mimeType, data: image } }
    ]);
    res.json({ text });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── ANÁLISIS DE GANADO ──────────────────────────────────────────────────────
app.post('/api/cow', async (req, res) => {
  try {
    const { image, mimeType, cowType, breed, view, ref, notes } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagen requerida' });

    const sys = `Sos un zootecnista experto en ganado bovino de Uruguay y el Cono Sur. Analizás fotos y estimás peso, raza, condición corporal y categoría con honestidad sobre márgenes de error.`;
    const usr = `Analizá esta foto de bovino. Categoría: ${cowType}. Raza: ${breed}. Vista: ${view}. Referencia: ${ref}. Notas: ${notes || 'ninguna'}.
Respondé en JSON puro (sin markdown):
{"raza_detectada":"...","categoria":"...","edad_estimada":"...","peso_min":0,"peso_max":0,"peso_promedio":0,"margen_error":"±X kg","confianza":"alta|media|baja","condicion_corporal":"...","musculatura":"...","observaciones":"...","recomendacion":"...","calidad_foto":"..."}`;

    const text = await gemini([
      { text: sys + '\n\n' + usr },
      { inline_data: { mime_type: mimeType, data: image } }
    ], 3000, true);
    res.json({ data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── ANÁLISIS DE CAMPO POR CUADRANTES ───────────────────────────────────────
app.post('/api/field', async (req, res) => {
  try {
    const { quads, crop, lat, lon, season, date, country } = req.body;
    if (!quads?.length) return res.status(400).json({ error: 'Sin cuadrantes' });

    const hasNdvi = quads.some(q => q.ndvi?.value !== null);
    const prompt = `Sos un ingeniero agrónomo especialista en ${country || 'Uruguay'}. Analizá este campo y da recomendaciones accionables para cada cuadrante.

CAMPO: ${lat}, ${lon} · Cultivo: ${crop} · Estación: ${season} · Fecha: ${date}
CUADRANTES (NDVI 0-1: >0.6 vigoroso, 0.4-0.6 saludable, 0.2-0.4 estresado, <0.2 suelo/muerto):
${quads.map(q => `${q.id}: NDVI ${q.ndvi?.value != null ? q.ndvi.value.toFixed(2) : 'SIN DATOS'} - ${q.ndvi?.label}`).join('\n')}
${!hasNdvi ? '\n⚠️ Sin NDVI — usá conocimiento regional, época y cultivo para estimar.' : ''}

Respondé en JSON puro:
{"resumen_general":"2-3 líneas","cuadrantes":[{"id":"...","salud_score":75,"estado":"...","accion":"producto + dosis concreta","urgencia":"alta|media|baja"}]}`;

    const text = await gemini([{ text: prompt }], 6000, true);
    res.json({ data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── CHAT AGRÓNOMO ───────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'Sin mensajes' });

    const sys = `Sos un ingeniero agrónomo experto en el campo uruguayo. Respondés en español rioplatense usando términos del campo de Uruguay: potrero, chacra, estancia, tambo, alambrado, aguada, manga, brete, entore, parición, destete, etc. Sos directo, práctico y conocés razas bovinas (Hereford, Angus, Braford), pasturas (campo natural, festuca, raigrás, lotus, trébol), cultivos y clima de Uruguay. Solo temas agropecuarios. Máximo 3-4 párrafos.`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
    const body = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 1500, temperature: 0.4 }
    };
    const gemRes = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const dt = await gemRes.json();
    if (!gemRes.ok) { const e = new Error(dt.error?.message); e.status = gemRes.status; throw e; }
    res.json({ text: dt.candidates?.[0]?.content?.parts?.[0]?.text || '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── PLANET TILE PROXY ───────────────────────────────────────────────────────
app.get('/api/planet/tile/:z/:x/:y', async (req, res) => {
  try {
    if (!PLANET_KEY) return res.status(503).end();
    const { z, x, y } = req.params;
    const { type = 'visual', year, month } = req.query;
    const mosaic = type === 'analytic'
      ? `planet_medres_normalized_analytic_${year}-${month}_mosaic`
      : `planet_medres_visual_${year}-${month}_mosaic`;
    const url = `https://tiles.planet.com/basemaps/v1/planet-tiles/${mosaic}/gmap/${z}/${x}/${y}.png?api_key=${PLANET_KEY}`;
    const tile = await fetch(url);
    if (!tile.ok) return res.status(tile.status).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = await tile.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).end();
  }
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', model: GEMINI_MODEL }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroVisión corriendo en puerto ${PORT}`));
