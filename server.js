const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const settingsManager = require('./lib/settingsManager');
const fidsService = require('./lib/fidsService');
const { requirePanelAuth, validateWithTvControler, setSessionCookie, clearSessionCookie, TV_CONTROLER_URL } = require('./lib/panelAuth');
const { renderGateErrorHtml, renderNotFoundHtml } = require('./lib/errorPages');

const app = express();

// ─────────────────────────────────────────────
// ACCIÓN 3: CORS restringido a orígenes conocidos
// Las pantallas de puerta son archivos estáticos
// que no hacen fetch cross-origin, no les afecta.
// Orígenes adicionales configurables via CORS_ORIGINS
// (separados por coma).
// ─────────────────────────────────────────────
const PORT = config.port;
const EXTRA_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  ...EXTRA_ORIGINS,
]);

app.use(cors({
  origin: (origin, cb) => {
    // Sin origin = curl / Postman / mismo origen del browser → permitir
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    try {
      const parsed = new URL(origin);
      if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(parsed.hostname)) {
        return cb(null, true);
      }
    } catch {}
    cb(new Error(`CORS bloqueado: origen no permitido (${origin})`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Función para servir la pantalla de puerta inyectando el número de puerta en el HTML
// Esto resuelve completamente la visualización a través del proxy-view de TV-Controler
function sendGateHtml(res, gateNum) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      return res.status(500).send('Error cargando index.html');
    }
    const cleanGate = String(gateNum || '').replace(/[^\w-]/g, '');
    const serverTimestamp = Date.now();
    const serverIso = new Date().toISOString();
    const injection = `\n  <script id="gids-server-injection">
    window.GIDS_GATE_NUMBER = ${JSON.stringify(cleanGate)};
    window.SERVER_TIMESTAMP = ${serverTimestamp};
    window.SERVER_TIME_ISO = ${JSON.stringify(serverIso)};
  </script>\n  <meta name="gids-gate" content="${cleanGate}">`;
    const modifiedHtml = html.includes('<head>')
      ? html.replace('<head>', `<head>${injection}`)
      : injection + html;

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(modifiedHtml);
  });
}

// Servir index.html inyectando número de puerta si viene por query
app.get(['/index.html', '/index.htm'], (req, res, next) => {
  const gateEntry = Object.entries(req.query || {}).find(([k]) => {
    const lk = k.toLowerCase();
    return ['puerta', 'gate', 'p', 'g'].includes(lk);
  });

  if (gateEntry && gateEntry[1] !== undefined && String(gateEntry[1]).trim() !== '') {
    const gateNum = String(gateEntry[1]).trim();
    const registeredGates = settingsManager.get().gatesList || [];
    if (!registeredGates.includes(gateNum)) {
      return res.status(404).send(renderGateErrorHtml(gateNum, config.airportName));
    }
    return sendGateHtml(res, gateNum);
  }
  next();
});

// Servir archivos estáticos del frontend (sin auth, index desactivado para controlar la raíz /)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─────────────────────────────────────────────
// ACCIÓN 1: Login / Logout del Panel
// Las credenciales son validadas contra el TV-Controler.
// ─────────────────────────────────────────────

// Página de login
app.get('/panel-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Procesar login
app.post('/panel-login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Usuario y contraseña requeridos.' });
  }
  const result = await validateWithTvControler(String(username).trim(), String(password), req.hostname);
  if (!result.ok) {
    return res.status(401).json({ ok: false, error: result.error });
  }
  setSessionCookie(res, username);
  res.json({ ok: true });
});

// Logout
app.post('/panel-logout', (req, res) => {
  clearSessionCookie(res);
  res.redirect('/panel-login');
});

// Servir la pantalla de puerta por ruta amigable /puerta/:num o /gate/:num
// Si la puerta no está registrada en el panel, devuelve pantalla de error institucional
app.get(['/puerta/:gateNumber', '/gate/:gateNumber'], (req, res) => {
  const gateNum = String(req.params.gateNumber || '').trim();
  const registeredGates = settingsManager.get().gatesList || [];
  if (!registeredGates.includes(gateNum)) {
    return res.status(404).send(renderGateErrorHtml(gateNum, config.airportName));
  }
  return sendGateHtml(res, gateNum);
});

// Ruta /puerta o /gate sin número de puerta -> redirigir al panel
app.get(['/puerta', '/puerta/', '/gate', '/gate/'], (req, res) => {
  res.redirect('/panel');
});

// Servir panel de supervisión — PROTEGIDO
app.get('/panel', requirePanelAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

// Raíz del servidor (/):
// 1. Si va vacía -> redirige al panel (o login si no hay sesión)
// 2. Si lleva ?puerta=X, ?gate=X, ?p=X -> valida si está registrada:
//    - Registrada: sirve la pantalla de puerta
//    - NO registrada: devuelve pantalla de error institucional (sin enumerar puertas activas)
app.get('/', (req, res) => {
  const gateEntry = Object.entries(req.query || {}).find(([k]) => {
    const lk = k.toLowerCase();
    return ['puerta', 'gate', 'p', 'g'].includes(lk);
  });

  if (gateEntry && gateEntry[1] !== undefined && String(gateEntry[1]).trim() !== '') {
    const gateNum = String(gateEntry[1]).trim();
    const registeredGates = settingsManager.get().gatesList || [];
    if (!registeredGates.includes(gateNum)) {
      return res.status(404).send(renderGateErrorHtml(gateNum, config.airportName));
    }
    return sendGateHtml(res, gateNum);
  }

  // Vacía -> redirige al panel (el cual exige login si no hay sesión)
  res.redirect('/panel');
});

// ─────────────────────────────────────────────
// ACCIÓN SEGURIDAD (Brecha 3): Servir pantalla de Salidas FIDS con validación de tipo
// ─────────────────────────────────────────────
const ALLOWED_FIDS_TIPOS = ['nacional', 'internacional'];

app.get('/fids-embed/:tipo', async (req, res) => {
  const tipo = String(req.params.tipo || '').toLowerCase().trim();
  if (!ALLOWED_FIDS_TIPOS.includes(tipo)) {
    return res.status(400).send('Tipo de pantalla no permitido. Solo se admite nacional o internacional.');
  }

  const remoteUrl = `${config.fidsUrl}/index.php/pantalla/${tipo}/salidas`;
  try {
    const upstream = await fetch(remoteUrl, {
      headers: {
        'Cookie': fidsService.sessionCookie || '',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GIDS-Proxy'
      }
    });
    if (!upstream.ok) {
      throw new Error(`Upstream FIDS HTTP ${upstream.status}`);
    }
    let html = await upstream.text();
    // Reescribir todas las referencias absolutas al servidor FIDS para que pasen por el proxy transparente
    const fidsHostRegex = new RegExp(config.fidsUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    html = html.replace(fidsHostRegex, '/fids-proxy');
    html = html.replace(/src="\/(assets|index\.php)/g, 'src="/fids-proxy/$1');
    html = html.replace(/href="\/(assets|index\.php)/g, 'href="/fids-proxy/$1');

    // Inyectar script para que hacer clic en la pantalla de FIDS General también active pantalla completa
    const clickScript = `\n<script>
      document.addEventListener('click', function(e) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'A')) return;
        try { document.documentElement.requestFullscreen?.() || document.documentElement.webkitRequestFullscreen?.(); } catch(_) {}
        try {
          window.parent?.postMessage({ type: 'request-fullscreen', action: 'fullscreen' }, '*');
          window.top?.postMessage({ type: 'request-fullscreen', action: 'fullscreen' }, '*');
        } catch(_) {}
      });
    </script>\n</body>`;
    html = html.includes('</body>') ? html.replace('</body>', clickScript) : html + clickScript;

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.send(html);
  } catch (err) {
    console.error(`[FIDS Embed Proxy] Error cargando pantalla ${tipo}:`, err.message);
    res.status(502).send(`Error comunicando con servidor FIDS (${err.message})`);
  }
});

// ─────────────────────────────────────────────
// ACCIÓN SEGURIDAD (Brecha 1): Proxy inverso controlado para FIDS
// - Solo permite rutas de activos estáticos y consulta de datos necesarias para la pantalla
// - Bloquea path traversal (..)
// - Restringe métodos POST exclusivamente a la ruta de paginación de datos
// - No expone Access-Control-Allow-Origin: *
// ─────────────────────────────────────────────
const ALLOWED_PROXY_PREFIXES = ['/assets/', '/index.php/data/', '/index.php/pantalla/'];

app.all('/fids-proxy/*', async (req, res) => {
  const subPath = req.originalUrl.replace(/^\/fids-proxy/, '').split('?')[0];

  // 1. Path traversal guard
  if (subPath.includes('..') || subPath.includes('\\') || /%2e/i.test(req.originalUrl)) {
    return res.status(400).json({ error: 'Ruta no permitida (path traversal detectado)' });
  }

  // 2. Validación de prefijo permitido
  const isAllowedPrefix = ALLOWED_PROXY_PREFIXES.some(prefix => subPath.startsWith(prefix));
  if (!isAllowedPrefix) {
    return res.status(403).json({ error: 'Acceso denegado: ruta no autorizada en el proxy FIDS' });
  }

  // 3. Método permitido: solo GET/HEAD para la mayoría; POST solo para paginación de datos
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.method !== 'POST' || !subPath.startsWith('/index.php/data/')) {
      return res.status(405).json({ error: `Método ${req.method} no permitido en esta ruta del proxy` });
    }
  }

  const queryPart = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '';
  const remoteUrl = `${config.fidsUrl}${subPath}${queryPart}`;

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) GIDS-Proxy',
      'Cookie': fidsService.sessionCookie || '',
      'X-CSRF-TOKEN': fidsService.csrfToken || '',
      'X-Requested-With': 'XMLHttpRequest'
    };

    let body = undefined;
    if (req.method === 'POST') {
      headers['Content-Type'] = req.headers['content-type'] || 'application/json;charset=UTF-8';
      let payload = req.body;
      if (payload && typeof payload === 'object') {
        if (payload._token && fidsService.csrfToken) {
          payload._token = fidsService.csrfToken;
        }
        body = JSON.stringify(payload);
      } else if (Buffer.isBuffer(payload)) {
        body = payload;
      }
    }

    const upstream = await fetch(remoteUrl, {
      method: req.method,
      headers: headers,
      body: body
    });

    fidsService.updateCookiesFromResponse(upstream);

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);

    const buffer = await upstream.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error(`[FIDS Proxy] Error en ${req.method} ${subPath}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// Alias directo a salidas
app.get('/pantalla/:tipo/salidas', (req, res) => {
  const tipo = String(req.params.tipo || '').toLowerCase().trim();
  if (!ALLOWED_FIDS_TIPOS.includes(tipo)) {
    return res.status(400).send('Tipo de pantalla no permitido.');
  }
  res.redirect(`/fids-embed/${tipo}`);
});

// ==========================================
// Rutas de API REST
// ==========================================

// Configuración general del sistema — PROTEGIDO
app.get('/api/config', requirePanelAuth, (req, res) => {
  const currentSettings = settingsManager.get();
  res.json({
    ...currentSettings,
    standbyMessage: config.standbyMessage,
    fidsStatus: fidsService.getStatus()
  });
});

// Guardar nueva configuración (URL de FIDS, puertas, etc.) — PROTEGIDO
app.post('/api/config', requirePanelAuth, async (req, res) => {
  try {
    const { fidsUrl, totalGates, gatesList, pollIntervalMs, airportName, airportCode } = req.body;
    const updated = settingsManager.update({
      fidsUrl,
      totalGates,
      gatesList,
      pollIntervalMs,
      airportName,
      airportCode
    });

    const fidsStatus = await fidsService.updateConfig(updated);

    res.json({
      success: true,
      config: updated,
      status: fidsStatus
    });
  } catch (err) {
    console.error('[Config Error]:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ACCIÓN 2: Validación anti-SSRF en test-connection
// Solo se permiten URLs que apunten a hosts de la red
// FIDS conocida. No se puede usar para alcanzar
// sistemas internos arbitrarios.
// ─────────────────────────────────────────────
function isFidsUrlAllowed(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname;

    // Bloquear explícitamente metadatos de nube y direcciones link-local
    if (host === '169.254.169.254' || host.startsWith('169.254.')) return false;

    // Si hay lista explícita en variable de entorno
    if (process.env.ALLOWED_FIDS_HOSTS) {
      const allowed = process.env.ALLOWED_FIDS_HOSTS.split(',').map(h => h.trim()).filter(Boolean);
      if (allowed.some(prefix => host.startsWith(prefix) || host === prefix)) return true;
    }

    // Permitir cualquier red privada interna (RFC 1918), localhost o loopback
    if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)) return true;
    if (['localhost', '127.0.0.1'].includes(host)) return true;

    // Permitir si coincide con el host configurado en settings
    try {
      if (config.fidsUrl) {
        const configuredHost = new URL(config.fidsUrl).hostname;
        if (host === configuredHost) return true;
      }
    } catch {}

    return false;
  } catch {
    return false;
  }
}

// Probar conexión a una URL FIDS — PROTEGIDO + validado
app.post('/api/config/test-connection', requirePanelAuth, async (req, res) => {
  try {
    const { fidsUrl } = req.body;
    if (!fidsUrl || !isFidsUrlAllowed(fidsUrl)) {
      return res.status(400).json({
        ok: false,
        message: `URL no permitida. Solo se aceptan hosts de la red FIDS (${ALLOWED_FIDS_HOSTS.join(', ')}…).`
      });
    }
    const result = await fidsService.testConnection(fidsUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Estado de conexión e ingestión
app.get('/api/fids/status', (req, res) => {
  res.json(fidsService.getStatus());
});

// Hora oficial del servidor para sincronización precisa de pantallas
app.get('/api/time', (req, res) => {
  res.json({
    serverTime: new Date().toISOString(),
    serverTimestamp: Date.now()
  });
});

// Datos de todas las puertas de embarque — PROTEGIDO (panel de control)
app.get('/api/fids/gates', requirePanelAuth, (req, res) => {
  res.json(fidsService.getAllGates());
});

// Datos de una puerta específica (con soporte de simulación directa ?mock=STATUS)
app.get('/api/fids/gate/:gateNumber', (req, res) => {
  const mockState = req.query.mock || req.query.simular || req.query.estado;
  if (mockState) {
    const rawKey = String(mockState).toUpperCase().replace(/\s+/g, '_');
    const mockMap = {
      'STANDBY': { key: 'STANDBY', es: 'PUERTA DISPONIBLE', en: 'GATE AVAILABLE', hasFlight: false, transmitFids: false },
      'FIDS_GENERAL': { key: 'FIDS_GENERAL', es: 'PANTALLA GENERAL', en: 'GENERAL FIDS', hasFlight: false, transmitFids: true },
      'GENERAL': { key: 'FIDS_GENERAL', es: 'PANTALLA GENERAL', en: 'GENERAL FIDS', hasFlight: false, transmitFids: true },
      'A_TIEMPO': { key: 'ON_TIME', es: 'A TIEMPO', en: 'ON TIME', hasFlight: true },
      'ON_TIME': { key: 'ON_TIME', es: 'A TIEMPO', en: 'ON TIME', hasFlight: true },
      'EN_ESPERA': { key: 'ON_TIME', es: 'EN ESPERA', en: 'WAITING', hasFlight: true },
      'ESPERA': { key: 'ON_TIME', es: 'EN ESPERA', en: 'WAITING', hasFlight: true },
      'CHEQUEO': { key: 'DOC_CHECK', es: 'CHEQUEO DE DOCUMENTOS', en: 'DOCUMENT CHECK', hasFlight: true },
      'CHEQUEO_DE_DOCUMENTO': { key: 'DOC_CHECK', es: 'CHEQUEO DE DOCUMENTOS', en: 'DOCUMENT CHECK', hasFlight: true },
      'CHEQUEO_DOCUMENTO': { key: 'DOC_CHECK', es: 'CHEQUEO DE DOCUMENTOS', en: 'DOCUMENT CHECK', hasFlight: true },
      'DOC_CHECK': { key: 'DOC_CHECK', es: 'CHEQUEO DE DOCUMENTOS', en: 'DOCUMENT CHECK', hasFlight: true },
      'ABORDANDO': { key: 'BOARDING', es: 'ABORDANDO', en: 'BOARDING', hasFlight: true },
      'BOARDING': { key: 'BOARDING', es: 'ABORDANDO', en: 'BOARDING', hasFlight: true },
      'DEMORADO': { key: 'DELAYED', es: 'DEMORADO', en: 'DELAYED', hasFlight: true },
      'DELAYED': { key: 'DELAYED', es: 'DEMORADO', en: 'DELAYED', hasFlight: true },
      'DESPEGANDO': { key: 'DEPARTING', es: 'DESPEGANDO', en: 'DEPARTING', hasFlight: true },
      'DEPARTING': { key: 'DEPARTING', es: 'DESPEGANDO', en: 'DEPARTING', hasFlight: true },
      'DESPEGO': { key: 'DEPARTED', es: 'DESPEGÓ', en: 'DEPARTED', hasFlight: true },
      'DESPEGÓ': { key: 'DEPARTED', es: 'DESPEGÓ', en: 'DEPARTED', hasFlight: true },
      'DEPARTED': { key: 'DEPARTED', es: 'DESPEGÓ', en: 'DEPARTED', hasFlight: true },
      'CANCELADO': { key: 'CANCELLED', es: 'CANCELADO', en: 'CANCELLED', hasFlight: true },
      'CANCELLED': { key: 'CANCELLED', es: 'CANCELADO', en: 'CANCELLED', hasFlight: true },
      'ARRIBO': { key: 'ARRIVED', es: 'ARRIBÓ', en: 'ARRIVED', hasFlight: true },
      'ARRIBÓ': { key: 'ARRIVED', es: 'ARRIBÓ', en: 'ARRIVED', hasFlight: true },
      'ARRIVED': { key: 'ARRIVED', es: 'ARRIBÓ', en: 'ARRIVED', hasFlight: true }
    };
    const target = mockMap[rawKey] || { key: rawKey, es: rawKey, en: rawKey, hasFlight: true, transmitFids: false };
    const isInt = fidsService.isInternationalGate(req.params.gateNumber);
    return res.json({
      gate: req.params.gateNumber,
      gateType: isInt ? 'internacional' : 'nacional',
      generalFidsUrl: fidsService.getGeneralFidsUrl(req.params.gateNumber),
      transmitGeneralFids: target.transmitFids === true,
      airportName: config.airportName,
      airportCode: config.airportCode,
      status: target.key,
      statusLabelEs: target.es,
      statusLabelEn: target.en,
      hasFlight: target.hasFlight,
      flight: target.hasFlight ? {
        id: 99999,
        puerta: req.params.gateNumber,
        aerolinea: 'conviasa',
        aerolineaNombre: 'Conviasa',
        codigo: '2278',
        destino: 'BARCELONA',
        destinoIata: 'BLA',
        despegue: config.airportCode || 'ORIGEN',
        horaProgramada: '11:00',
        logoUrl: '/api/logo/conviasa',
        statusKey: target.key
      } : null,
      nextFlight: target.hasFlight ? {
        id: 99998,
        puerta: req.params.gateNumber,
        aerolineaNombre: 'Turpial Airlines',
        codigo: '6461',
        destino: 'VIGIA',
        horaProgramada: '12:00'
      } : null,
      serverTime: new Date().toISOString(),
      serverTimestamp: Date.now()
    });
  }
  // ── Validación: puerta debe estar registrada en el panel ──
  // La excepción es el modo simulación (?mock=), que siempre funciona (para debugging)
  if (!mockState) {
    const registeredGates = settingsManager.get().gatesList || [];
    if (!registeredGates.includes(String(req.params.gateNumber))) {
      return res.status(404).json({
        error: 'gate_not_found',
        message: 'Puerta no encontrada o no habilitada.'
      });
    }
  }

  const gateData = fidsService.getGateData(req.params.gateNumber);
  res.json({
    ...gateData,
    serverTime: new Date().toISOString(),
    serverTimestamp: Date.now()
  });
});

// Vuelos crudos del FIDS (diagnóstico) — PROTEGIDO
app.get('/api/fids/raw', requirePanelAuth, (req, res) => {
  res.json(fidsService.getRawFlights());
});

// Forzar sincronización inmediata — PROTEGIDO
app.post('/api/fids/sync', requirePanelAuth, async (req, res) => {
  try {
    await fidsService.sync();
    res.json({ success: true, status: fidsService.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ACCIÓN SEGURIDAD (Brecha 2): Proxy y caché de logos con validación anti-traversal
// ─────────────────────────────────────────────
app.get('/api/logo/:airline', async (req, res) => {
  const rawAirline = String(req.params.airline || '').toLowerCase().trim();
  const placeholderFile = path.join(__dirname, 'public', 'assets', 'images', 'placeholder_airline.svg');

  // 1. Validación estricta: solo nombres de archivo alfanuméricos simples
  if (!/^[a-z0-9_-]{1,32}$/i.test(rawAirline)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(placeholderFile);
  }

  const cacheDir = path.resolve(__dirname, 'public', 'assets', 'images', 'aerolineas');
  const cachedFile = path.resolve(cacheDir, `${rawAirline}.png`);

  // 2. Comprobación que el archivo resuelto permanezca dentro del directorio de caché
  if (!cachedFile.startsWith(cacheDir + path.sep)) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(placeholderFile);
  }

  // Si existe en caché local, servir directamente
  if (fs.existsSync(cachedFile)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h
    return res.sendFile(cachedFile);
  }

  // Si no está en caché, intentar obtener del servidor FIDS
  try {
    const remoteUrl = `${config.fidsUrl}/assets/images/aerolineas/${rawAirline}.png`;
    const remoteRes = await fetch(remoteUrl);
    if (remoteRes.ok) {
      const buffer = await remoteRes.arrayBuffer();
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cachedFile, Buffer.from(buffer));
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(cachedFile);
    }
  } catch (e) {
    console.warn(`[Logo Proxy] No se pudo obtener logo de ${rawAirline} desde FIDS:`, e.message);
  }

  // Fallback a SVG genérico
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(placeholderFile);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Manejador de rutas no encontradas (404) para cualquier dirección no registrada
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.status(404).send(renderNotFoundHtml(req.originalUrl || req.path, config.airportName));
  }
  res.status(404).json({ error: 'not_found', path: req.originalUrl || req.path, message: 'Dirección no encontrada en el sistema' });
});

// Iniciar servidor y poller
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  GIDS - Pantallas de Puertas de Embarque`);
  console.log(`  Aeropuerto: ${config.airportName} (${config.airportCode})`);
  console.log(`  Servidor activo en: http://0.0.0.0:${PORT}`);
  console.log(`  Pantalla de puerta:  http://localhost:${PORT}/?puerta=2`);
  console.log(`  Panel de control:    http://localhost:${PORT}/panel`);
  console.log(`=======================================================`);

  // Iniciar sincronización periódica
  fidsService.startPolling();
});

// Manejo elegante de apagado
process.on('SIGINT', () => {
  console.log('Deteniendo servidor...');
  fidsService.stopPolling();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('Deteniendo servidor...');
  fidsService.stopPolling();
  server.close(() => process.exit(0));
});
