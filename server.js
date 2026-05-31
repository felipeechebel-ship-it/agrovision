require('dotenv').config();
const nodeFetch = require('node-fetch');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const ws        = require('ws');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_KEY   = process.env.GEMINI_KEY;
const PLANET_KEY   = process.env.PLANET_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const SUPA_URL     = process.env.SUPABASE_URL;
const SUPA_KEY     = process.env.SUPABASE_SECRET_KEY;

// ─── Helpers REST directo a Supabase (sin @supabase/supabase-js ni auth-js) ──

function supaHeaders(extra = {}) {
  return {
    'apikey': SUPA_KEY,
    'Authorization': `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

// GET /rest/v1/:table?col=eq.val  → primer registro o null
async function dbGet(table, match, select = '*') {
  const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await nodeFetch(`${SUPA_URL}/rest/v1/${table}?${qs}&select=${select}`, {
    headers: supaHeaders()
  });
  const rows = await r.json();
  return Array.isArray(rows) ? (rows[0] || null) : null;
}

// POST /rest/v1/:table
async function dbInsert(table, row) {
  const r = await nodeFetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supaHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(row)
  });
  return r.ok;
}

// PATCH /rest/v1/:table?col=eq.val
async function dbUpdate(table, match, updates) {
  const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&');
  const r = await nodeFetch(`${SUPA_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: supaHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify(updates)
  });
  return r.ok;
}

// Auth: verificar token JWT
async function authGetUser(token) {
  const r = await nodeFetch(`${SUPA_URL}/auth/v1/user`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${token}` }
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

// Auth: crear usuario (admin)
async function authCreateUser(email, password) {
  const r = await nodeFetch(`${SUPA_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: supaHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.msg || data.message || 'Error creando usuario');
  return data; // { id, email, ... }
}

// Auth: login con email+password
async function authSignIn(email, password) {
  const r = await nodeFetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: supaHeaders(),
    body: JSON.stringify({ email, password })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.msg || 'Credenciales incorrectas');
  return data; // { access_token, user: { id, ... }, ... }
}

// ─── Rate limit ───────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

// ─── Contador en memoria para anónimos (IP) ───────────────────────────────────
const anonCounters = {};
const ANON_DAILY_LIMIT = 3;
const FREE_DAILY_LIMIT = 5;

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

// ─── MIDDLEWARE: verificar token de sesión ────────────────────────────────────
async function checkAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  req.user = null;

  if (!token) return next();

  try {
    const user = await authGetUser(token);
    if (!user) return next();

    const profile = await dbGet('profiles', { id: user.id });
    if (profile) req.user = profile;
  } catch (e) {
    // token inválido → usuario anónimo
  }
  next();
}

// ─── MIDDLEWARE: límites por plan ─────────────────────────────────────────────
async function checkLimit(req, res, next) {
  const today = getTodayStr();

  if (!req.user) {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    if (!anonCounters[ip] || anonCounters[ip].date !== today) {
      anonCounters[ip] = { count: 0, date: today };
    }
    if (anonCounters[ip].count >= ANON_DAILY_LIMIT) {
      return res.status(429).json({ error: 'LIMIT_REACHED', plan: 'anon' });
    }
    anonCounters[ip].count++;
    return next();
  }

  if (req.user.plan === 'pro' || req.user.plan === 'familia') return next();

  const fechaReset = req.user.fecha_reset ? req.user.fecha_reset.split('T')[0] : null;
  let analisisHoy = req.user.analisis_hoy || 0;

  if (fechaReset !== today) {
    analisisHoy = 0;
    await dbUpdate('profiles', { id: req.user.id }, { analisis_hoy: 0, fecha_reset: new Date().toISOString() });
  }

  if (analisisHoy >= FREE_DAILY_LIMIT) {
    return res.status(429).json({ error: 'LIMIT_REACHED', plan: 'free' });
  }

  await dbUpdate('profiles', { id: req.user.id }, { analisis_hoy: analisisHoy + 1 });
  next();
}

// ─── Helper: llama a Gemini ───────────────────────────────────────────────────
async function gemini(parts, maxTokens = 4000, jsonMode = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const config = { maxOutputTokens: maxTokens, temperature: 0.3 };
  if (jsonMode) config.responseMimeType = 'application/json';
  const res = await nodeFetch(url, {
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

// ─── AUTH: REGISTRO ───────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password || !nombre) {
      return res.status(400).json({ error: 'email, password y nombre son requeridos' });
    }

    const user = await authCreateUser(email, password);

    await dbInsert('profiles', {
      id: user.id,
      email,
      nombre,
      plan: 'free',
      analisis_hoy: 0,
      fecha_reset: new Date().toISOString()
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── AUTH: LOGIN ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email y password son requeridos' });
    }

    const session = await authSignIn(email, password);
    const userId  = session.user?.id;

    const profile = await dbGet('profiles', { id: userId }, 'email,nombre,plan');

    res.json({
      token: session.access_token,
      user: {
        email:  profile?.email  || email,
        nombre: profile?.nombre || '',
        plan:   profile?.plan   || 'free'
      }
    });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ─── AUTH: ME ─────────────────────────────────────────────────────────────────
app.get('/api/auth/me', checkAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  res.json({ user: req.user });
});

// ─── AUTH: LOGOUT ─────────────────────────────────────────────────────────────
app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

// ─── ANÁLISIS DE FOTO ─────────────────────────────────────────────────────────
app.post('/api/vision', checkAuth, checkLimit, async (req, res) => {
  try {
    const { image, mimeType, image2, mimeType2, vegType, notes, stats, weather } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagen requerida' });

    const sys = `Sos un ingeniero agrónomo con 20 años de experiencia en el campo uruguayo. Conocés perfectamente las pasturas de Uruguay: campo natural (con pasto seco, flechilla, gramilla), festuca, raigrás, lotus, trébol blanco, gramíneas de verano. Sabés que una pastura sana en Uruguay NATURALMENTE tiene mezcla de verde, marrón y amarillo — eso NO es señal de problema. El marrón puede ser paja seca natural, los tallos secos de gramíneas, el suelo entre matas. Solo es problema cuando hay manchas, podredumbre, insectos, hongos, o más del 60% de material muerto sin rebrote verde.

IMPORTANTE SOBRE EL ANÁLISIS DE COLORES AUTOMÁTICO: Los porcentajes de color que te paso son calculados por un algoritmo simple de píxeles de la foto — son MUY imprecisos porque dependen de la luz, sombras y ángulo. NO los uses como dato principal. Confiá en tu análisis visual de la imagen real.

CALIBRACIÓN DE PUNTAJE para Uruguay:
- 85-100: Pastura excelente, cobertura uniforme, buen vigor, sin problemas visibles
- 70-84: Buena pastura, algún detalle menor a corregir
- 50-69: Pastura regular, problemas moderados que hay que atender
- 30-49: Pastura en mal estado, requiere intervención urgente
- 0-29: Pastura muy degradada o con problema severo

Respondés en español rioplatense. Estructurá tu respuesta en 5 secciones numeradas:
1) Diagnóstico y puntaje de salud (0-100) — sé honesto y preciso, no subestimes pasturas sanas
2) Posibles causas con probabilidad estimada (%)
3) Acciones inmediatas (qué hacer hoy)
4) Acciones a 7-15 días
5) Qué confirmar (análisis o pruebas)

Sé concreto, profesional y accionable. Si la pastura está bien, decilo claramente.`;

    const greenPct = ((stats?.greenDark || 0) + (stats?.greenLight || 0)).toFixed(1);
    let weatherCtx = '';
    if (weather) weatherCtx = `\nClima actual en la zona: ${weather.temp}°C, precipitación reciente ${weather.precip}mm, viento ${weather.wind}km/h.`;
    const img2note = image2 ? '\nSe adjuntan DOS fotos: la primera es vista general del potrero (al horizonte), la segunda es de cerca al suelo. Analizalas en conjunto.' : '';
    const usr = `Foto de vegetación del campo uruguayo. Tipo: ${vegType}. Notas del productor: ${notes || 'ninguna'}.${weatherCtx}${img2note}
Referencia de color (tomala como orientativa, no como dato exacto): verde ~${greenPct}%, amarillo ~${(stats?.yellow || 0).toFixed(1)}%, marrón ~${(stats?.brown || 0).toFixed(1)}%.
Analizá la imagen con tu criterio profesional y dá un diagnóstico preciso.`;

    const parts = [
      { text: sys + '\n\n' + usr },
      { inline_data: { mime_type: mimeType, data: image } }
    ];
    if (image2 && mimeType2) parts.push({ inline_data: { mime_type: mimeType2, data: image2 } });

    const text = await gemini(parts);
    res.json({ text });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── ANÁLISIS DE GANADO ───────────────────────────────────────────────────────
app.post('/api/cow', checkAuth, checkLimit, async (req, res) => {
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

// ─── MALEZAS ──────────────────────────────────────────────────────────────────
app.post('/api/weed', checkAuth, checkLimit, async (req, res) => {
  try {
    const { image, mimeType, crop } = req.body;
    if (!image) return res.status(400).json({ error: 'Imagen requerida' });
    const prompt = `Sos un experto en malezas del Uruguay y el Río de la Plata. Identificá la maleza en esta foto.
Respondé con:
1) Nombre común y científico
2) Familia botánica
3) Ciclo (anual/perenne)
4) Por qué es problemática para ${crop || 'el cultivo'}
5) Control químico (herbicida + dosis específica para Uruguay)
6) Control cultural
7) Momento óptimo de control
8) Resistencias conocidas en Uruguay`;
    const text = await gemini([
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: image } }
    ]);
    res.json({ text });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── ANÁLISIS DE CAMPO POR CUADRANTES ────────────────────────────────────────
app.post('/api/field', checkAuth, checkLimit, async (req, res) => {
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
{"resumen_general":"2-3 líneas","carga_animal_estimada":"X animales/ha según NDVI y época","cuadrantes":[{"id":"...","salud_score":75,"estado":"...","accion":"producto + dosis concreta","urgencia":"alta|media|baja"}]}`;

    const text = await gemini([{ text: prompt }], 6000, true);
    res.json({ data: JSON.parse(text.replace(/```json\n?|```/g, '').trim()) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── CHAT AGRÓNOMO ────────────────────────────────────────────────────────────
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
    const gemRes = await nodeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const dt = await gemRes.json();
    if (!gemRes.ok) { const e = new Error(dt.error?.message); e.status = gemRes.status; throw e; }
    res.json({ text: dt.candidates?.[0]?.content?.parts?.[0]?.text || '' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── PLANET TILE PROXY ────────────────────────────────────────────────────────
app.get('/api/planet/tile/:z/:x/:y', async (req, res) => {
  try {
    if (!PLANET_KEY) return res.status(503).end();
    const { z, x, y } = req.params;
    const { type = 'visual', year, month } = req.query;
    const mosaic = type === 'analytic'
      ? `planet_medres_normalized_analytic_${year}-${month}_mosaic`
      : `planet_medres_visual_${year}-${month}_mosaic`;
    const url = `https://tiles.planet.com/basemaps/v1/planet-tiles/${mosaic}/gmap/${z}/${x}/${y}.png?api_key=${PLANET_KEY}`;
    const tile = await nodeFetch(url);
    if (!tile.ok) return res.status(tile.status).end();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    const buf = await tile.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).end();
  }
});

// ─── MERCADO: precios commodity (Yahoo Finance) ───────────────────────────────
app.get('/api/market', async (req, res) => {
  try {
    const commodities = [
      { sym: 'ZS=F', name: 'Soja',   icon: '🌱', toTon: b => b * 36.744,  unit: 'USD/tn' },
      { sym: 'ZC=F', name: 'Maíz',   icon: '🌽', toTon: b => b * 39.368,  unit: 'USD/tn' },
      { sym: 'ZW=F', name: 'Trigo',  icon: '🌾', toTon: b => b * 36.744,  unit: 'USD/tn' },
      { sym: 'LE=F', name: 'Vacuno', icon: '🐄', toTon: b => b / 2.2046,  unit: 'USD/kg' },
    ];
    const prices = await Promise.all(commodities.map(async c => {
      try {
        const r = await nodeFetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${c.sym}?interval=1d&range=5d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
        );
        const d = await r.json();
        const meta = d.chart?.result?.[0]?.meta || {};
        const cur  = meta.currency || 'USD';
        const raw  = meta.regularMarketPrice || 0;
        const prev = meta.previousClose || raw;
        const usd  = cur === 'USX' ? raw / 100 : raw;
        const usdP = cur === 'USX' ? prev / 100 : prev;
        const converted = c.toTon(usd);
        const change    = usdP ? ((usd - usdP) / usdP * 100).toFixed(2) : '0.00';
        return { name: c.name, icon: c.icon, price: converted.toFixed(c.sym==='LE=F'?3:1), unit: c.unit, change, up: parseFloat(change) >= 0 };
      } catch {
        return { name: c.name, icon: c.icon, price: null, unit: c.unit, change: '0.00', up: true };
      }
    }));
    res.json({ prices, updated: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MERCADO: análisis IA ─────────────────────────────────────────────────────
app.post('/api/market/analysis', async (req, res) => {
  try {
    const { prices, crop } = req.body;
    const priceStr = (prices||[]).map(p => `${p.name}: ${p.price} ${p.unit} (${p.change}%)`).join(', ');
    const prompt = `Sos un analista de mercados agropecuarios para Uruguay. Precios actuales CBOT: ${priceStr}.
Para un productor uruguayo de ${crop||'ganadería y agricultura'}, respondé en 3 párrafos cortos:
1) Situación y tendencia del mercado hoy
2) ¿Conviene vender ahora o esperar? Sé específico con plazos.
3) Recomendación concreta para Uruguay (tipo de cambio, costos, mercados destino).
Sé directo, práctico, en español rioplatense.`;
    const text = await gemini([{ text: prompt }], 700);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SUELO: SoilGrids (ISRIC) + análisis IA ──────────────────────────────────
app.get('/api/soil', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat y lon requeridos' });
    const r = await nodeFetch(
      `https://rest.isric.org/soilgrids/v2.0/properties/query?lat=${lat}&lon=${lon}&property=phh2o,soc,nitrogen,clay,sand,silt&depth=0-5cm&value=mean`,
      { headers: { 'Accept': 'application/json' }, timeout: 15000 }
    );
    const d = await r.json();
    const soil = {};
    for (const layer of (d.properties?.layers || [])) {
      const val = layer.depths?.[0]?.values?.mean;
      if (val != null) soil[layer.name] = { value: val, unit: layer.unit_measure?.mapped_units || '' };
    }
    const prompt = `Sos un ingeniero agrónomo especialista en suelos de Uruguay. Datos SoilGrids para ${lat},${lon}:
pH: ${soil.phh2o?.value ? (soil.phh2o.value/10).toFixed(1) : 'N/D'}
Carbono orgánico (SOC): ${soil.soc?.value ? (soil.soc.value/10).toFixed(1) : 'N/D'} g/kg
Nitrógeno total: ${soil.nitrogen?.value ? (soil.nitrogen.value/100).toFixed(2) : 'N/D'} g/kg
Arcilla: ${soil.clay?.value ? (soil.clay.value/10).toFixed(0) : 'N/D'}%
Arena: ${soil.sand?.value ? (soil.sand.value/10).toFixed(0) : 'N/D'}%
Limo: ${soil.silt?.value ? (soil.silt.value/10).toFixed(0) : 'N/D'}%
Respondé en 4 puntos concisos: 1) Tipo de suelo y calidad 2) Cultivos ideales 3) Fertilizantes recomendados 4) Corrección de pH si hace falta. Lenguaje simple, práctico para el productor uruguayo.`;
    const analysis = await gemini([{ text: prompt }], 500);
    res.json({ soil, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATOS DE USUARIO (campos + ganadería en JSON) ────────────────────────────
app.get('/api/userdata', checkAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const profile = await dbGet('profiles', { id: req.user.id }, 'user_data');
  res.json({ data: profile?.user_data || { fields: [], livestock: [] } });
});

app.put('/api/userdata', checkAuth, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  const { data } = req.body;
  const ok = await dbUpdate('profiles', { id: req.user.id }, { user_data: data });
  res.json({ ok });
});

// ─── ALERTAS PROACTIVAS ───────────────────────────────────────────────────────
app.post('/api/alerts/scan', async (req, res) => {
  try {
    const { fields, livestock } = req.body;
    const mes = new Date().toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
    const alerts = [];

    // Alertas de campo
    for (const f of (fields || []).slice(0, 3)) {
      const prompt = `Sos un sistema de alertas agropecuarias para Uruguay (${mes}). Campo "${f.name}", cultivo: ${f.crop||'sin especificar'}.
Generá hasta 3 alertas proactivas relevantes para esta época. JSON puro:
{"alerts":[{"tipo":"plagas|clima|fertilizacion|rotacion|siembra","nivel":"alta|media|baja","titulo":"texto corto","detalle":"1 oración","accion":"qué hacer esta semana"}]}`;
      const text = await gemini([{ text: prompt }], 400, true);
      try {
        const p = JSON.parse(text.replace(/```json\n?|```/g, '').trim());
        for (const a of (p.alerts||[])) alerts.push({ ...a, campo: f.name });
      } catch {}
    }

    // Alertas de ganadería por fechas
    const hoy = new Date();
    for (const r of (livestock || [])) {
      if (!r.proxima) continue;
      const prox = new Date(r.proxima);
      const dias = Math.round((prox - hoy) / 86400000);
      if (dias <= 30 && dias >= 0) {
        alerts.push({
          tipo: 'ganaderia',
          nivel: dias <= 7 ? 'alta' : 'media',
          titulo: `${r.tipo || 'Evento'} pendiente: ${r.lote || 'lote'}`,
          detalle: `${r.descripcion || r.tipo} — vence ${dias === 0 ? 'hoy' : `en ${dias} días`}`,
          accion: 'Programar con el veterinario esta semana',
          campo: r.lote || 'Ganadería'
        });
      } else if (dias < 0) {
        alerts.push({
          tipo: 'ganaderia',
          nivel: 'alta',
          titulo: `VENCIDO: ${r.tipo || 'evento'} en ${r.lote || 'lote'}`,
          detalle: `${r.descripcion} venció hace ${Math.abs(dias)} días`,
          accion: 'Atender urgente con el veterinario',
          campo: r.lote || 'Ganadería'
        });
      }
    }

    res.json({ alerts: alerts.slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', model: GEMINI_MODEL }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroVisión corriendo en puerto ${PORT}`));
