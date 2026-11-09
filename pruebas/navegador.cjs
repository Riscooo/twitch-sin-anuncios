// Prueba con la app real de Twitch para teles en un Firefox de Playwright (sin ventana), con el script inyectado al
// empezar, como hace TizenBrew. Uso: node pruebas/navegador.cjs <canal> [segundos] [captura.png]
const path = require('path');
const fs = require('fs');
const { firefox, chromium } = require(process.env.PLAYWRIGHT_CORE || path.join(process.env.HOME, 'Projects/portfolio/node_modules/playwright-core'));
const canal = process.argv[2] || 'kaicenat';
const segundos = +(process.argv[3] || 60);
const captura = process.argv[4];
const motor = process.env.MOTOR === 'chromium' ? chromium : firefox;
(async () => {
  const navegador = await motor.launch({ headless: true });
  const contexto = await navegador.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
  });
  // PRUEBA='{"normalConAnunciosHasta":40,"soloBajaHasta":20}' → segundos desde que empieza a verse.
  if (process.env.PRUEBA) {
    const prueba = JSON.parse(process.env.PRUEBA);
    await contexto.addInitScript({ content: `window.__pruebaPendiente = ${JSON.stringify(prueba)};` });
  }
  if (!process.env.SIN_SCRIPT) await contexto.addInitScript({ content: fs.readFileSync(path.join(__dirname, '../dist/userScript.js'), 'utf8') });
  const pagina = await contexto.newPage();
  const mensajes = [];
  pagina.on('console', (m) => { const t = m.text(); if (t.includes('Twitch sin anuncios') || m.type() === 'error') mensajes.push(`${m.type()}: ${t}`.slice(0, 300)); });
  const listas = [];
  let anunciosEnLaRed = 0;
  pagina.on('response', async (r) => {
    const u = r.url();
    if (/\.m3u8/.test(u)) {
      listas.push(u.split('?')[0].slice(0, 90));
      try { const texto = await r.text(); if (/stitched-ad|,Amazon/.test(texto)) anunciosEnLaRed++; } catch (e) { /* nada */ }
    }
  });
  await pagina.goto(`https://samsung.tv.twitch.tv/${canal}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // El aviso de cookies sale con «Reject» elegido: Intro, como con el mando.
  for (let i = 0; i < 6; i++) {
    await pagina.waitForTimeout(4000);
    const aviso = await pagina.evaluate(() => /Cookies and Advertising|Cookies y opciones|Start Watching|Empezar a ver/.test(document.body.innerText));
    if (!aviso) break;
    await pagina.keyboard.press('Enter');
  }
  const muestras = [];
  await pagina.evaluate(() => {
    const p = window.__pruebaPendiente;
    if (!p) return;
    const ahora = Date.now();
    window.__twitchSinAnunciosPrueba = {};
    for (const k of Object.keys(p)) window.__twitchSinAnunciosPrueba[k] = ahora + p[k] * 1000;
  });
  for (let i = 0; i < segundos / 5; i++) {
    await pagina.waitForTimeout(5000);
    const v = await pagina.evaluate(() => {
      const video = document.querySelector('video');
      return video ? { t: +video.currentTime.toFixed(1), pausa: video.paused, ancho: video.videoWidth, alto: video.videoHeight, listo: video.readyState, error: video.error && video.error.code } : null;
    });
    if (v) v.anuncio = await pagina.evaluate(() => /\bAd\b|Anuncio|Commercial/i.test(document.body.innerText));
    muestras.push(v);
  }
  if (captura) await pagina.screenshot({ path: captura });
  const registro = await pagina.evaluate(() => (window.__twitchSinAnunciosRegistro || []).map((x) => new Date(x.t).toISOString().slice(14, 19) + ' ' + x.m));
  const canales = await pagina.evaluate(() => {
    const c = window.__twitchSinAnunciosCanales || {};
    return Object.keys(c).map((k) => ({ canal: k, servidas: c[k].servidas, vistas: c[k].vistas, porFuente: c[k].porFuente, costuras: c[k].costuras, fuente: c[k].fuente }));
  });
  console.log(JSON.stringify({ url: pagina.url(), anunciosEnLaRed, muestras, canales, registro, mensajes: mensajes.slice(-25), listas: [...new Set(listas)].slice(0, 12) }, null, 1));
  await navegador.close();
})().catch((e) => { console.error('FALLO', e); process.exit(1); });
