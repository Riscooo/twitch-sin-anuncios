// Pruebas del script con un Twitch de mentira: listas con y sin anuncios, varias fuentes, vídeos.
//   node --test pruebas/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODIGO = readFileSync(new URL('../dist/userScript.js', import.meta.url), 'utf8');
const T0 = Date.parse('2026-11-09T12:00:00.000Z');

// Un directo: cada fuente (tipo de reproductor) numera a su manera, pero el trozo k es el mismo a la misma hora.
function crearTwitch() {
  const tw = {
    ahora: 20,                       // último trozo emitido (en «k»)
    anuncios: {},                    // fuente → [desde, hasta) en k con anuncio
    numeracion: { principal: 1000, popout: 50, site: 7, embed: 3, mobile_web: 9, autoplay: 400 },
    peticiones: [],
  };
  tw.lista = (fuente) => {
    const desde = Math.max(0, tw.ahora - 5);
    const base = tw.numeracion[fuente];
    const l = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', `#EXT-X-MEDIA-SEQUENCE:${base + desde}`,
      '#EXT-X-TWITCH-ELAPSED-SECS:10.000'];
    const [a, b] = tw.anuncios[fuente] || [-1, -1];
    for (let k = desde; k <= tw.ahora; k++) {
      const anuncio = k >= a && k < b;
      if (anuncio && k === Math.max(a, desde)) {
        l.push('#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="x",DURATION=15,X-TV-TWITCH-AD-POD-LENGTH="1"');
        l.push('#EXT-X-DISCONTINUITY');
      }
      l.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + k * 2000).toISOString()}`);
      l.push(anuncio ? '#EXTINF:2.000,Amazon|123' : '#EXTINF:2.000,live');
      l.push(`https://video-edge.ttvnw.net/v1/segment/${fuente}-${anuncio ? 'ad' : 'k' + k}.ts`);
    }
    return l.join('\n') + '\n';
  };
  tw.maestra = (fuente) => ['#EXTM3U', '#EXT-X-TWITCH-INFO:NODE="x"',
    `#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000`,
    `https://eus.playlist.ttvnw.net/v1/playlist/${fuente}-1080.m3u8`,
    `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000`,
    `https://eus.playlist.ttvnw.net/v1/playlist/${fuente}-720.m3u8`].join('\n') + '\n';
  tw.fetch = async (url, opciones = {}) => {
    url = String(url);
    tw.peticiones.push(url);
    const responder = (texto, status = 200) => ({ status, url, text: async () => texto, json: async () => JSON.parse(texto) });
    if (url === 'https://gql.twitch.tv/gql') {
      const cuerpo = JSON.parse(opciones.body);
      if (!cuerpo.variables) return responder('{}');
      tw.ultimasCabeceras = opciones.headers;
      return responder(JSON.stringify({ data: { streamPlaybackAccessToken: { value: '{"t":1}', signature: 'sig-' + cuerpo.variables.playerType } } }));
    }
    let m = /usher\.ttvnw\.net\/api\/channel\/hls\/([a-z0-9_]+)\.m3u8\?(.*)$/.exec(url);
    if (m) {
      const q = new URLSearchParams(m[2]);
      const sig = q.get('sig') || 'sig-principal';
      return responder(tw.maestra(sig.replace('sig-', '')));
    }
    m = /playlist\/([a-z_]+)-(\d+)\.m3u8/.exec(url);
    if (m) return responder(tw.lista(m[1]));
    if (url.includes('vod')) return responder(tw.vod);
    return responder('', 404);
  };
  return tw;
}

function cargar(tw) {
  const consola = [];
  class XHRFalso {
    open(metodo, url) { this.metodo = metodo; this.url = url; this.readyState = 1; }
    setRequestHeader() {}
    send() { this.enviada = true; }
    abort() {}
    addEventListener() {}
    dispatchEvent() { return true; }
  }
  const ventana = {
    fetch: tw.fetch,
    XMLHttpRequest: XHRFalso,
    console: { log: (...a) => consola.push(a.join(' ')) },
    Response: class { constructor(texto, o) { this.texto = texto; this.status = o.status; } async text() { return this.texto; } },
    Headers: class {},
    URLSearchParams, TextEncoder, Event: class { constructor(t) { this.type = t; } }, ProgressEvent: class { constructor(t) { this.type = t; } },
  };
  ventana.window = ventana;
  vm.createContext(ventana);
  vm.runInContext(CODIGO, ventana);
  return { ventana, consola };
}

async function pedir(ventana, url) {
  const r = await ventana.fetch(url);
  return r.text();
}

const USHER = 'https://usher.ttvnw.net/api/channel/hls/canal.m3u8?sig=sig-principal&token=x&allow_source=true&player_type=pulsar';
const MEDIA = 'https://eus.playlist.ttvnw.net/v1/playlist/principal-1080.m3u8';

function trozos(texto) {
  const lineas = texto.trim().split('\n');
  let sn = +lineas.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:')).split(':')[1];
  const ds = lineas.find((l) => l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:'));
  let cc = ds ? +ds.split(':')[1] : 0;
  const res = [];
  for (const l of lineas) {
    if (l === '#EXT-X-DISCONTINUITY') cc++;
    if (!l.startsWith('#')) res.push({ sn: sn++, url: l, cc });
  }
  return res;
}

test('sin anuncios, la lista pasa igual (misma numeración y trozos)', async () => {
  const tw = crearTwitch();
  const { ventana } = cargar(tw);
  await pedir(ventana, USHER);
  const t = trozos(await pedir(ventana, MEDIA));
  assert.equal(t.length, 6);
  assert.equal(t[0].sn, 1015);
  assert.ok(t.every((x) => x.url.includes('principal-k')));
});

test('con un anuncio al empezar, se ve por popout; luego se sigue por popout sin saltos', async () => {
  const tw = crearTwitch();
  tw.anuncios.principal = [15, 30];
  const { ventana, consola } = cargar(tw);
  await pedir(ventana, USHER);
  const a = trozos(await pedir(ventana, MEDIA));
  assert.ok(a.every((x) => x.url.includes('popout-k')), JSON.stringify(a));
  assert.ok(!(await pedir(ventana, MEDIA)).includes('stitched'));
  tw.ahora = 23;
  const b = trozos(await pedir(ventana, MEDIA));
  // Mismo trozo, mismo número: el k20 sigue siendo el mismo para el reproductor.
  const k20a = a.find((x) => x.url.endsWith('k20.ts')).sn;
  const k20b = b.find((x) => x.url.endsWith('k20.ts')).sn;
  assert.equal(k20a, k20b);
  assert.ok(consola.some((l) => l.includes('popout')));
});

test('si popout también trae anuncios y la normal ya no, se vuelve a la normal con su costura y la numeración seguida', async () => {
  const tw = crearTwitch();
  tw.anuncios.principal = [18, 21];
  const { ventana } = cargar(tw);
  await pedir(ventana, USHER);
  const a = trozos(await pedir(ventana, MEDIA));
  assert.ok(a.some((x) => x.url.includes('popout')));
  tw.ahora = 26;
  tw.anuncios.popout = [24, 40];
  const b = trozos(await pedir(ventana, MEDIA));
  const ultimoPopout = a[a.length - 1];
  const primeroNormal = b.find((x) => x.url.includes('principal'));
  assert.ok(!b.some((x) => x.url.includes('-ad.ts')), JSON.stringify(b));
  assert.ok(primeroNormal, JSON.stringify(b));
  // Números seguidos por la hora: el k24 de la normal va justo detrás del k23 de popout.
  assert.ok(primeroNormal.url.endsWith('principal-k21.ts'), JSON.stringify(b));
  assert.equal(primeroNormal.sn, ultimoPopout.sn + 1);
  assert.equal(primeroNormal.cc, ultimoPopout.cc + 1, 'hace falta una costura (DISCONTINUITY) en el cambio');
  const k20a = a.find((x) => x.url.endsWith('k20.ts')).sn;
  const k20b = b.find((x) => x.url.endsWith('k20.ts'));
  if (k20b) assert.equal(k20b.sn, k20a);
  // Y en la siguiente vuelta la costura sigue en su sitio aunque se vaya saliendo de la ventana.
  tw.ahora = 30;
  const c = trozos(await pedir(ventana, MEDIA));
  const k24c = c.find((x) => x.url.endsWith('principal-k25.ts'));
  assert.equal(k24c.sn, primeroNormal.sn + 4);
  assert.equal(k24c.cc, primeroNormal.cc);
  tw.ahora = 40;
  const d = trozos(await pedir(ventana, MEDIA));
  assert.equal(d[0].cc, primeroNormal.cc, 'al salir la costura de la ventana, la cuenta se queda');
});

test('si solo autoplay (360p) viene limpia, se usa mientras dure y se vuelve en cuanto la normal está limpia', async () => {
  const tw = crearTwitch();
  for (const f of ['principal', 'popout', 'site', 'embed', 'mobile_web']) tw.anuncios[f] = [10, 25];
  const { ventana } = cargar(tw);
  await pedir(ventana, USHER);
  const a = trozos(await pedir(ventana, MEDIA));
  assert.ok(a.every((x) => x.url.includes('autoplay')), JSON.stringify(a));
  assert.equal(tw.peticiones.filter((u) => u.includes('autoplay-')).length >= 1, true);
  // Cada 2 s, como el reproductor: mientras la normal traiga anuncios por delante, 360p.
  for (const ahora of [22, 24]) {
    tw.ahora = ahora;
    const x = trozos(await pedir(ventana, MEDIA));
    assert.ok(x.every((y) => y.url.includes('autoplay')), ahora + ' ' + JSON.stringify(x));
  }
  const antes = trozos(await pedir(ventana, MEDIA)).pop();
  // A los 26 la normal ya solo arrastra anuncios pasados: se vuelve a ella en el k25.
  tw.ahora = 26;
  const b = trozos(await pedir(ventana, MEDIA));
  const vuelta = b.find((x) => x.url.includes('principal'));
  assert.ok(vuelta && vuelta.url.endsWith('principal-k25.ts'), JSON.stringify(b));
  assert.equal(vuelta.sn, antes.sn + 1);
  assert.equal(vuelta.cc, antes.cc + 1);
  assert.ok(!b.some((x) => x.url.includes('-ad.ts')));
});

test('si no hay ninguna limpia, se quitan los trozos de anuncio (el reproductor espera)', async () => {
  const tw = crearTwitch();
  tw.ahora = 27;
  await (async () => {
    const { ventana } = cargar(tw);
    await pedir(ventana, USHER);
    const a = trozos(await pedir(ventana, MEDIA));
    assert.equal(a.length, 6);
    for (const f of Object.keys(tw.numeracion)) tw.anuncios[f] = [28, 50];
    tw.ahora = 33;
    const b = trozos(await pedir(ventana, MEDIA));
    assert.ok(!b.some((x) => x.url.includes('-ad.ts')), JSON.stringify(b));
    assert.equal(b[b.length - 1].url.endsWith('principal-k27.ts'), true);
  })();
});

test('las marcas de anuncios desaparecen de lo que ve la app', async () => {
  const tw = crearTwitch();
  const { ventana } = cargar(tw);
  await pedir(ventana, USHER);
  tw.anuncios.principal = [18, 22];
  tw.anuncios.popout = [0, 100];
  tw.anuncios.site = [0, 100];
  tw.anuncios.embed = [0, 100];
  tw.anuncios.mobile_web = [0, 100];
  tw.anuncios.autoplay = [0, 100];
  const texto = await pedir(ventana, MEDIA);
  assert.ok(!/stitched|Amazon|X-TV-TWITCH-AD/.test(texto), texto);
});

test('vídeos: fuera los trozos «Amazon», y los trozos sin título se quedan', async () => {
  const tw = crearTwitch();
  const { ventana } = cargar(tw);
  tw.vod = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:10.000,', '0.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:5.000,Amazon|9', 'https://x/ad.ts', '#EXT-X-DISCONTINUITY',
    '#EXTINF:10.000,', '1.ts', '#EXT-X-ENDLIST'].join('\n');
  const texto = await pedir(ventana, 'https://d1m7.cloudfront.net/abc_vod/chunked/index-dvr.m3u8');
  assert.ok(!texto.includes('ad.ts'));
  assert.ok(texto.includes('0.ts') && texto.includes('1.ts') && texto.includes('#EXT-X-ENDLIST'));
  tw.vod = tw.vod.replace(/#EXT-X-DISCONTINUITY\n#EXTINF:5.000,Amazon\|9\nhttps:\/\/x\/ad.ts\n#EXT-X-DISCONTINUITY\n/, '');
  const limpio = await pedir(ventana, 'https://d1m7.cloudfront.net/abc_vod/chunked/index-dvr.m3u8');
  assert.equal(limpio, tw.vod);
});

test('el token de reserva sale con las cabeceras de la app (su Client-Id y su sesión)', async () => {
  const tw = crearTwitch();
  tw.anuncios.principal = [0, 100];
  const { ventana } = cargar(tw);
  await ventana.fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-Id': 'cliente-tv', 'Authorization': 'OAuth abc', 'X-Device-Id': 'dev1' }, body: '{}' });
  await pedir(ventana, USHER);
  await pedir(ventana, MEDIA);
  assert.equal(tw.ultimasCabeceras['Client-Id'], 'cliente-tv');
  assert.equal(tw.ultimasCabeceras['Authorization'], 'OAuth abc');
});

test('una lista real de Twitch con anuncio al empezar (como la del 9-11): se ve la reserva y sin rastro del anuncio', async () => {
  const tw = crearTwitch();
  const real = (fuente, k0, n, anuncio) => {
    const l = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-TWITCH-ELAPSED-SECS:145730.000', '#EXT-X-TWITCH-TOTAL-SECS:145736.000', '#EXT-X-START:TIME-OFFSET=0.000',
      '#EXT-X-DATERANGE:ID="playlist-creation-1794227517",CLASS="timestamp",START-DATE="2026-11-09T12:31:57.802Z",END-ON-NEXT=YES,X-SERVER-TIME="1794227517.80"',
      '#EXT-X-DATERANGE:ID="playlist-session-1794227517",CLASS="twitch-session",START-DATE="2026-11-09T12:31:57.802Z",END-ON-NEXT=YES,X-TV-TWITCH-SESSIONID="2375758745544440255"'];
    if (anuncio) {
      l.push('#EXT-X-DATERANGE:ID="stitched-ad-1794227513-15235000000",CLASS="twitch-stitched-ad",START-DATE="2026-11-09T12:31:53.141Z",DURATION=15.235,X-TV-TWITCH-AD-LINE-ITEM-ID="2372251610258",X-TV-TWITCH-AD-POD-LENGTH="1",X-TV-TWITCH-AD-CREATIVE-ID="2488883100494",X-TV-TWITCH-AD-RADS-TOKEN="eyJ"');
      l.push('#EXT-X-DATERANGE:ID="source-1794227513",CLASS="twitch-stream-source",START-DATE="2026-11-09T12:31:53.141Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="Amazon|2488883100494"');
    } else {
      l.push('#EXT-X-DATERANGE:ID="source-1794227513",CLASS="twitch-stream-source",START-DATE="2026-11-09T12:31:53.141Z",END-ON-NEXT=YES,X-TV-TWITCH-STREAM-SOURCE="live"');
    }
    l.push('#EXT-X-DATERANGE:ID="trigger-1794227513",CLASS="twitch-trigger",START-DATE="2026-11-09T12:31:53.141Z",END-ON-NEXT=YES,X-TV-TWITCH-TRIGGER-URL="https://eus22.playlist.ttvnw.net/trigger/Cv"');
    if (anuncio) l.push('#EXT-X-DATERANGE:ID="quartile-1794227513-0",CLASS="twitch-ad-quartile",START-DATE="2026-11-09T12:31:53.141Z",DURATION=2.000,X-TV-TWITCH-AD-QUARTILE="0"', '#EXT-X-DISCONTINUITY');
    for (let k = k0; k < k0 + n; k++) {
      l.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + k * 2000).toISOString()}`);
      l.push(anuncio ? '#EXTINF:2.000,Amazon|2488883100494' : '#EXTINF:2.000,live');
      l.push(`https://4c2f.j.cloudfront.hls.ttvnw.net/v1/segment/${fuente}-${anuncio ? 'ad' : 'k' + k}`);
    }
    return l.join('\n') + '\n';
  };
  tw.lista = (fuente) => (fuente === 'principal' ? real('principal', 18, 3, true) : real(fuente, 15, 6, false));
  const { ventana } = cargar(tw);
  await pedir(ventana, USHER);
  const texto = await pedir(ventana, MEDIA);
  assert.ok(!/Amazon|stitched|quartile|trigger|X-TV-TWITCH-AD/.test(texto), texto);
  assert.ok(texto.includes('X-TV-TWITCH-STREAM-SOURCE="live"'));
  assert.ok(/popout-k20/.test(texto));
  assert.ok(!texto.includes('#EXT-X-DISCONTINUITY\n'), 'sin costuras en la primera lista');
});
