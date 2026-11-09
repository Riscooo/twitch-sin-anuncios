/*
 * Twitch sin anuncios — módulo de TizenBrew para la app de Twitch de las teles Samsung (samsung.tv.twitch.tv).
 *
 * Twitch mete los anuncios dentro de la propia lista del directo (trozos «Amazon|…» marcados con
 * CLASS="twitch-stitched-ad"). La app de teles reproduce con hls.js, que pide esas listas desde la página
 * (XMLHttpRequest o fetch). Aquí se cogen esas peticiones:
 *   1. La lista maestra (usher.ttvnw.net) se apunta: canal, calidades y a qué lista lleva cada una.
 *   2. Cada lista del directo se mira antes de dársela al reproductor. Si trae anuncios, se pide la misma
 *      emisión con otro tipo de reproductor (popout, site, embed, mobile_web y, en último caso, autoplay, a
 *      360p), que suele venir limpia, y se le da esa. Si ninguna viene limpia, se quitan los trozos de anuncio.
 *   3. Para que hls.js no se pierda al cambiar de una a otra, los números de trozo se recolocan por la hora de
 *      cada trozo (PROGRAM-DATE-TIME) y se marca la costura con DISCONTINUITY.
 * La idea de pedir otro tipo de reproductor viene de TwitchAdSolutions (pixeltris, y el fork de ryanbr; MIT).
 *
 * Escrito para el navegador de Tizen 6.5 (Chromium 85): sin ?. ni ??.
 */
(function () {
  'use strict';
  if (window.__twitchSinAnuncios) return;
  window.__twitchSinAnuncios = '1.0.1';

  var PREFIJO = '[Twitch sin anuncios]';
  var CLIENTE_TV = 'ue6666qo983tsx6so1t0vnawi233wa';
  var HASH_TOKEN = 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';
  // Los de calidad original primero; autoplay (360p) solo si los demás también traen anuncios.
  var RESERVAS = [
    { tipo: 'popout', plataforma: 'web' },
    { tipo: 'site', plataforma: 'web' },
    { tipo: 'embed', plataforma: 'web' },
    { tipo: 'mobile_web', plataforma: 'web' },
    { tipo: 'autoplay', plataforma: 'android', baja: true }
  ];
  var SENALES = ['stitched-ad', 'twitch-stitched', 'EXT-X-CUE-OUT', 'twitch-maf-ad'];
  var CADUCA_FALLO_MS = 20000;
  var CADUCA_MAESTRA_MS = 8 * 60 * 1000;

  var fetchReal = window.fetch.bind(window);
  var XHRReal = window.XMLHttpRequest;

  var cabecerasGql = {};          // las de la propia app (Client-Id, Authorization, X-Device-Id…)
  var variantes = {};             // lista (sin consulta) → { canal, resolucion, fps }
  var canales = {};               // canal → estado
  var registro = [];
  window.__twitchSinAnunciosRegistro = registro;
  window.__twitchSinAnunciosCanales = canales;
  // Solo para probarlo en un ordenador: { normalConAnunciosHasta: ms, soloBajaHasta: ms }.
  function prueba(clave) {
    var p = window.__twitchSinAnunciosPrueba;
    return !!(p && p[clave] && Date.now() < p[clave]);
  }

  function log() {
    var partes = [PREFIJO];
    for (var i = 0; i < arguments.length; i++) partes.push(arguments[i]);
    try { console.log.apply(console, partes); } catch (e) { /* nada */ }
    registro.push({ t: Date.now(), m: partes.slice(1).join(' ') });
    if (registro.length > 300) registro.shift();
  }

  function clave(url) { return String(url).split('?')[0]; }

  function atributos(linea) {
    var res = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    var m;
    while ((m = re.exec(linea))) res[m[1]] = m[2].charAt(0) === '"' ? m[2].slice(1, -1) : m[2];
    return res;
  }

  function tieneAnuncios(texto) {
    for (var i = 0; i < SENALES.length; i++) if (texto.indexOf(SENALES[i]) !== -1) return true;
    var lineas = texto.split('\n');
    for (var j = 0; j < lineas.length; j++) {
      if (lineas[j].indexOf('#EXTINF') === 0 && esAnuncio(lineas[j])) return true;
    }
    return false;
  }

  // «#EXTINF:2.000,live» es la emisión; «#EXTINF:2.000,Amazon|…», un anuncio; sin título (vídeos), la emisión.
  function esAnuncio(extinf) {
    var coma = extinf.indexOf(',');
    var titulo = coma === -1 ? '' : extinf.slice(coma + 1).trim();
    return titulo !== '' && titulo !== 'live';
  }

  /* ---------- Listas ---------- */

  // Una lista vale si no trae anuncios por delante de lo que ya vio el reproductor (los que ya pasaron se quitan).
  function sirve(canal, texto) {
    if (!tieneAnuncios(texto)) return true;
    if (!canal.ultimaFecha) return false;
    var lista = trocear(texto);
    var hayEmision = false;
    for (var i = 0; i < lista.trozos.length; i++) {
      var t = lista.trozos[i];
      if (t.anuncio && (!t.fecha || t.fecha > canal.ultimaFecha)) return false;
      if (!t.anuncio) hayEmision = true;
    }
    return hayEmision && !/EXT-X-CUE-OUT|twitch-maf-ad/.test(texto);
  }

  // Una lista de medios troceada: cabecera (sin secuencia ni discontinuidades) y trozos con su hora.
  function trocear(texto) {
    var lineas = texto.replace(/\r/g, '').split('\n');
    var cabecera = [];
    var trozos = [];
    var secuencia = 0;
    var pendientes = [];
    var fecha = null;
    var anuncio = false;
    for (var i = 0; i < lineas.length; i++) {
      var l = lineas[i];
      if (!l) continue;
      if (l.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) { secuencia = parseInt(l.split(':')[1], 10) || 0; continue; }
      if (l.indexOf('#EXT-X-DISCONTINUITY-SEQUENCE') === 0 || l === '#EXT-X-DISCONTINUITY') continue;
      if (l.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) { fecha = Date.parse(l.slice(25)); pendientes.push(l); continue; }
      if (l.indexOf('#EXT-X-DATERANGE') === 0) {
        // Fuera las marcas de anuncios (las que hacen que la app cuente un anuncio o pida uno).
        if (/twitch-stitched|stitched-ad|twitch-ad-quartile|twitch-trigger|twitch-maf-ad|X-TV-TWITCH-AD/.test(l)) continue;
        // «De dónde sale el trozo»: solo se deja cuando es el directo («live»), no «Amazon|…».
        if (l.indexOf('twitch-stream-source') !== -1 && l.indexOf('STREAM-SOURCE="live"') === -1) continue;
        if (trozos.length || pendientes.length) pendientes.push(l); else cabecera.push(l);
        continue;
      }
      if (l.indexOf('#EXTINF') === 0) {
        anuncio = esAnuncio(l);
        pendientes.push(l);
        continue;
      }
      if (l.charAt(0) !== '#') {
        trozos.push({ sn: secuencia + trozos.length, fecha: fecha, lineas: pendientes.concat([l]), anuncio: anuncio, dur: 0 });
        pendientes = [];
        fecha = null;
        anuncio = false;
        continue;
      }
      if (l.indexOf('#EXT-X-TWITCH-PREFETCH') === 0) continue; // anticipos: pueden ser de un anuncio
      if (trozos.length || pendientes.length) pendientes.push(l); else cabecera.push(l);
    }
    for (var k = 0; k < trozos.length; k++) {
      var inf = trozos[k].lineas.filter(function (x) { return x.indexOf('#EXTINF') === 0; })[0] || '#EXTINF:2';
      trozos[k].dur = parseFloat(inf.slice(8)) || 2;
    }
    return { cabecera: cabecera, trozos: trozos, final: pendientes };
  }

  // Lo que se le da a hls.js: una numeración propia del canal, que se mantiene por la hora de cada trozo aunque
  // cambie la fuente (o su sesión), y una costura (DISCONTINUITY) donde empieza otra fuente.
  function componer(canal, fuente, lista) {
    var trozos = lista.trozos.filter(function (t) { return !t.anuncio; });
    if (!trozos.length) return null;
    var desfase = desfasePorFecha(canal, trozos);
    if (desfase === null) desfase = canal.ultimoSn < 0 ? 0 : desfaseCercano(canal, trozos);
    if (canal.ultimaFuente !== null && canal.ultimaFuente !== fuente) {
      for (var i = 0; i < trozos.length; i++) {
        var sn = trozos[i].sn + desfase;
        if (sn > canal.ultimoSn) {
          if (canal.costuras.indexOf(sn) === -1) canal.costuras.push(sn);
          log('cambio de fuente', canal.ultimaFuente, '→', fuente, 'en el trozo', sn);
          break;
        }
      }
    }
    canal.ultimaFuente = fuente;
    var primero = trozos[0].sn + desfase;
    var viejas = canal.costuras.filter(function (c) { return c <= primero - 200; });
    canal.costurasViejas += viejas.length;
    canal.costuras = canal.costuras.filter(function (c) { return c > primero - 200; });
    var anteriores = canal.costuras.filter(function (c) { return c <= primero; }).length + canal.costurasViejas;
    var salida = ['#EXTM3U'];
    lista.cabecera.forEach(function (l) { if (l !== '#EXTM3U') salida.push(l); });
    salida.push('#EXT-X-MEDIA-SEQUENCE:' + primero);
    if (anteriores) salida.push('#EXT-X-DISCONTINUITY-SEQUENCE:' + anteriores);
    trozos.forEach(function (t) {
      var sn = t.sn + desfase;
      if (sn > primero && canal.costuras.indexOf(sn) !== -1) salida.push('#EXT-X-DISCONTINUITY');
      t.lineas.forEach(function (l) { salida.push(l); });
      if (t.fecha) apuntarFecha(canal, t.fecha, sn);
      if (sn > canal.ultimoSn) {
        canal.ultimoSn = sn;
        canal.ultimaFecha = t.fecha;
        canal.ultimaDur = t.dur;
      }
    });
    lista.final.forEach(function (l) { salida.push(l); });
    return salida.join('\n') + '\n';
  }

  function apuntarFecha(canal, fecha, sn) {
    for (var i = canal.mapa.length - 1; i >= 0 && i >= canal.mapa.length - 8; i--) {
      if (canal.mapa[i].sn === sn) return;
    }
    canal.mapa.push({ fecha: fecha, sn: sn });
    if (canal.mapa.length > 150) canal.mapa.splice(0, canal.mapa.length - 150);
  }

  // Si algún trozo de esta lista ya se dio (misma hora, ±0,3 s), su número manda.
  function desfasePorFecha(canal, trozos) {
    for (var i = trozos.length - 1; i >= 0; i--) {
      var t = trozos[i];
      if (!t.fecha) continue;
      for (var j = canal.mapa.length - 1; j >= 0; j--) {
        if (Math.abs(canal.mapa[j].fecha - t.fecha) < 300) return canal.mapa[j].sn - t.sn;
      }
    }
    return null;
  }

  // Si no, se cuenta desde el último trozo dado, por la diferencia de hora.
  function desfaseCercano(canal, trozos) {
    var mejor = trozos[0];
    var dif = Infinity;
    trozos.forEach(function (t) {
      if (!t.fecha || !canal.ultimaFecha) return;
      var d = Math.abs(t.fecha - canal.ultimaFecha);
      if (d < dif) { dif = d; mejor = t; }
    });
    var paso = canal.ultimaDur || mejor.dur || 2;
    var pasos = mejor.fecha && canal.ultimaFecha ? Math.round((mejor.fecha - canal.ultimaFecha) / (paso * 1000)) : 1;
    return canal.ultimoSn + pasos - mejor.sn;
  }

  function canalNuevo(nombre) {
    return {
      nombre: nombre, consulta: '', fuente: null, maestras: {}, fallos: {},
      mapa: [], costuras: [], costurasViejas: 0, ultimaFuente: null, ultimoSn: -1, ultimaFecha: null, ultimaDur: 2,
      enAnuncio: false
    };
  }

  /* ---------- Red ---------- */

  function textoDe(url) {
    return fetchReal(url, { credentials: 'omit' }).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, texto: t, url: r.url || url }; });
    });
  }

  function token(canal, reserva) {
    var cab = { 'Client-Id': cabecerasGql['client-id'] || CLIENTE_TV, 'Content-Type': 'text/plain;charset=UTF-8' };
    if (cabecerasGql['x-device-id']) cab['X-Device-Id'] = cabecerasGql['x-device-id'];
    if (cabecerasGql['authorization']) cab['Authorization'] = cabecerasGql['authorization'];
    if (cabecerasGql['client-integrity']) cab['Client-Integrity'] = cabecerasGql['client-integrity'];
    var cuerpo = {
      operationName: 'PlaybackAccessToken',
      variables: { isLive: true, login: canal, isVod: false, vodID: '', playerType: reserva.tipo, platform: reserva.plataforma },
      extensions: { persistedQuery: { version: 1, sha256Hash: HASH_TOKEN } }
    };
    return fetchReal('https://gql.twitch.tv/gql', { method: 'POST', headers: cab, body: JSON.stringify(cuerpo) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var t = (d && d.data && d.data.streamPlaybackAccessToken) || (d && d.streamPlaybackAccessToken);
        if (!t) throw new Error('sin token (' + JSON.stringify((d && d.errors) || d).slice(0, 120) + ')');
        return t;
      });
  }

  function maestraDeReserva(canal, reserva) {
    var guardada = canal.maestras[reserva.tipo];
    if (guardada && Date.now() - guardada.cuando < CADUCA_MAESTRA_MS) return Promise.resolve(guardada.texto);
    return token(canal.nombre, reserva).then(function (t) {
      var params = new URLSearchParams(canal.consulta);
      params.set('sig', t.signature);
      params.set('token', t.value);
      params.set('player_type', reserva.tipo);
      params.set('platform', reserva.plataforma);
      params.set('p', String(Math.floor(Math.random() * 1e7)));
      return textoDe('https://usher.ttvnw.net/api/channel/hls/' + canal.nombre + '.m3u8?' + params.toString());
    }).then(function (r) {
      if (r.status !== 200) throw new Error('usher ' + r.status);
      canal.maestras[reserva.tipo] = { texto: r.texto, cuando: Date.now() };
      return r.texto;
    });
  }

  function variante(maestra, info) {
    var lineas = maestra.replace(/\r/g, '').split('\n');
    var exacta = null;
    var cercana = null;
    var dif = Infinity;
    var objetivo = info.resolucion.split('x');
    var area = (+objetivo[0]) * (+objetivo[1]);
    for (var i = 0; i < lineas.length - 1; i++) {
      if (lineas[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var url = lineas[i + 1];
      if (!url || url.charAt(0) === '#') continue;
      var a = atributos(lineas[i]);
      if (!a.RESOLUTION) continue;
      if (a.RESOLUTION === info.resolucion && (!exacta || a['FRAME-RATE'] === info.fps)) exacta = url;
      var r = a.RESOLUTION.split('x');
      var d = Math.abs((+r[0]) * (+r[1]) - area);
      if (d < dif) { dif = d; cercana = url; }
    }
    return exacta || cercana;
  }

  function listaDeReserva(canal, reserva, info) {
    return maestraDeReserva(canal, reserva).then(function (maestra) {
      var url = variante(maestra, info);
      if (!url) throw new Error('sin calidades');
      return textoDe(url).then(function (r) {
        if (r.status !== 200) {
          delete canal.maestras[reserva.tipo];
          throw new Error('lista ' + r.status);
        }
        return r.texto;
      });
    });
  }

  /* ---------- Lo que ve el reproductor ---------- */

  function maestraVista(url, r) {
    var m = /\/channel\/hls\/([^\/?]+)\.m3u8/.exec(url);
    if (!m || r.status !== 200) return r;
    var nombre = decodeURIComponent(m[1]).toLowerCase();
    var canal = canales[nombre];
    if (!canal || !canal.consulta) canal = canales[nombre] = canalNuevo(nombre);
    var consulta = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1);
    if (canal.consulta && canal.consulta !== consulta) {
      // El reproductor ha empezado otra vez (otro canal, otra sesión): se empieza de cero.
      canal = canales[nombre] = canalNuevo(nombre);
    }
    canal.consulta = consulta;
    var lineas = r.texto.replace(/\r/g, '').split('\n');
    for (var i = 0; i < lineas.length - 1; i++) {
      if (lineas[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var a = atributos(lineas[i]);
      if (lineas[i + 1] && lineas[i + 1].charAt(0) !== '#') {
        variantes[clave(lineas[i + 1])] = { canal: nombre, resolucion: a.RESOLUTION || '1280x720', fps: a['FRAME-RATE'] };
      }
    }
    log('canal', nombre, '·', Object.keys(variantes).length, 'listas conocidas');
    return r;
  }

  function fuentesEnOrden(canal) {
    var lista = RESERVAS.slice();
    if (canal.fijada) {
      lista.sort(function (a, b) { return (b.tipo === canal.fijada) - (a.tipo === canal.fijada); });
    }
    return lista.filter(function (r) {
      var f = canal.fallos[r.tipo];
      return !f || Date.now() - f > CADUCA_FALLO_MS;
    });
  }

  function mediaVista(url, info) {
    var canal = canales[info.canal] || (canales[info.canal] = canalNuevo(info.canal));

    function principal() {
      return textoDe(url).then(function (r) {
        if (r.status !== 200) return { r: r };
        canal.vistas = (canal.vistas || 0) + 1;
        return { r: r, limpia: !prueba('normalConAnunciosHasta') && sirve(canal, r.texto) };
      });
    }

    function probarReservas(salvo) {
      var cola = fuentesEnOrden(canal).filter(function (r) { return r.tipo !== salvo; });
      function siguiente() {
        var reserva = cola.shift();
        if (!reserva) return Promise.resolve(null);
        return listaDeReserva(canal, reserva, info).then(function (texto) {
          if (!sirve(canal, texto) || (prueba('soloBajaHasta') && !reserva.baja)) {
            canal.fallos[reserva.tipo] = Date.now();
            return siguiente();
          }
          canal.fijada = reserva.tipo;
          return { tipo: reserva.tipo, texto: texto };
        }, function (e) {
          canal.fallos[reserva.tipo] = Date.now();
          log('reserva', reserva.tipo, 'no vale:', e.message);
          return siguiente();
        });
      }
      return siguiente();
    }

    function entregar(fuente, texto, status) {
      var salida = componer(canal, fuente, trocear(texto));
      if (salida === null) {
        // Todo eran anuncios y no hubo reserva limpia: la última lista buena (el reproductor espera).
        salida = canal.ultimaSalida || componerVacia(texto);
      }
      canal.ultimaSalida = salida;
      canal.servidas = (canal.servidas || 0) + 1;
      canal.porFuente = canal.porFuente || {};
      canal.porFuente[fuente] = (canal.porFuente[fuente] || 0) + 1;
      return { status: status || 200, texto: salida };
    }

    function anuncioEmpieza(fuente) {
      if (!canal.enAnuncio) { canal.enAnuncio = true; log('anuncio en', fuente); }
    }
    function anuncioAcaba() {
      if (canal.enAnuncio) { canal.enAnuncio = false; log('fin del anuncio'); }
    }

    // Se sigue con la fuente que va bien; solo se cambia cuando trae anuncios. La de 360p, solo mientras la
    // emisión normal los traiga.
    if (canal.fuente) {
      var reservaActual = RESERVAS.filter(function (r) { return r.tipo === canal.fuente; })[0];
      if (reservaActual.baja) {
        return principal().then(function (p) {
          if (p.limpia) { log('vuelve a la emisión normal'); canal.fuente = null; anuncioAcaba(); return entregar('principal', p.r.texto); }
          return listaDeReserva(canal, reservaActual, info).then(function (texto) {
            return entregar(canal.fuente, texto);
          }, function () { canal.fuente = null; return entregar('principal', p.r ? p.r.texto : ''); });
        });
      }
      return listaDeReserva(canal, reservaActual, info).then(function (texto) {
        if (sirve(canal, texto) && !(prueba('soloBajaHasta') && !reservaActual.baja)) { anuncioAcaba(); return entregar(canal.fuente, texto); }
        anuncioEmpieza(canal.fuente);
        canal.fallos[canal.fuente] = Date.now();
        return principal().then(function (p) {
          if (p.limpia) { log('vuelve a la emisión normal'); canal.fuente = null; anuncioAcaba(); return entregar('principal', p.r.texto); }
          return probarReservas(canal.fuente).then(function (otra) {
            if (otra) { canal.fuente = otra.tipo; return entregar(otra.tipo, otra.texto); }
            log('sin fuente limpia: se quitan los trozos de anuncio');
            return entregar(canal.fuente, texto);
          });
        });
      }, function (e) {
        log('la reserva', canal.fuente, 'falla:', e.message);
        canal.fuente = null;
        return mediaVista(url, info);
      });
    }

    return principal().then(function (p) {
      if (!p.limpia) {
        if (!p.r || p.r.status !== 200) return p.r;
        anuncioEmpieza('principal');
        return probarReservas(null).then(function (otra) {
          if (otra) {
            log('se ve por', otra.tipo, 'mientras haya anuncios');
            canal.fuente = otra.tipo;
            return entregar(otra.tipo, otra.texto);
          }
          log('sin fuente limpia: se quitan los trozos de anuncio');
          return entregar('principal', p.r.texto);
        });
      }
      anuncioAcaba();
      return entregar('principal', p.r.texto);
    });
  }

  function componerVacia(texto) {
    var lista = trocear(texto);
    var salida = ['#EXTM3U'];
    lista.cabecera.forEach(function (l) { if (l !== '#EXTM3U') salida.push(l); });
    salida.push('#EXT-X-MEDIA-SEQUENCE:0');
    return salida.join('\n') + '\n';
  }

  // Listas de vídeos (VOD) y cualquier otra con trozos de anuncio: fuera esos trozos.
  function otraLista(r) {
    if (r.status !== 200 || !tieneAnuncios(r.texto)) return r;
    if (r.texto.indexOf('#EXT-X-PLAYLIST-TYPE:VOD') === -1 && r.texto.indexOf('#EXT-X-ENDLIST') === -1) return r;
    var lista = trocear(r.texto);
    var salida = ['#EXTM3U'];
    lista.cabecera.forEach(function (l) { if (l !== '#EXTM3U') salida.push(l); });
    var quitados = 0;
    var previoAnuncio = false;
    lista.trozos.forEach(function (t, i) {
      if (t.anuncio) { quitados++; previoAnuncio = true; return; }
      if (previoAnuncio && i > 0) salida.push('#EXT-X-DISCONTINUITY');
      previoAnuncio = false;
      t.lineas.forEach(function (l) { salida.push(l); });
    });
    lista.final.forEach(function (l) { salida.push(l); });
    log('vídeo: fuera', quitados, 'trozos de anuncio');
    return { status: 200, texto: salida.join('\n') + '\n', url: r.url };
  }

  // ¿Esta petición es nuestra? Devuelve una promesa con { status, texto } o null.
  function atender(url) {
    try {
      url = String(url);
      if (/^https:\/\/usher\.ttvnw\.net\/api\/(v2\/)?channel\/hls\//.test(url)) {
        return textoDe(url).then(function (r) { return maestraVista(url, r); });
      }
      var info = variantes[clave(url)];
      if (info) return mediaVista(url, info);
      if (/\.m3u8(\?|$)/.test(url) && /(ttvnw\.net|cloudfront\.net|twitch\.tv)\//.test(url) && url.indexOf('usher.ttvnw.net') === -1) {
        return textoDe(url).then(otraLista);
      }
    } catch (e) {
      log('error', e && e.message);
    }
    return null;
  }

  /* ---------- Ganchos ---------- */

  function anotarCabeceras(cabeceras) {
    if (!cabeceras) return;
    try {
      if (typeof Headers !== 'undefined' && cabeceras instanceof Headers) {
        cabeceras.forEach(function (v, k) { anotar(k, v); });
      } else if (Array.isArray(cabeceras)) {
        cabeceras.forEach(function (par) { anotar(par[0], par[1]); });
      } else {
        Object.keys(cabeceras).forEach(function (k) { anotar(k, cabeceras[k]); });
      }
    } catch (e) { /* nada */ }
    function anotar(k, v) {
      k = String(k).toLowerCase();
      if (['client-id', 'authorization', 'x-device-id', 'client-integrity', 'client-version', 'client-session-id'].indexOf(k) !== -1 && v) {
        cabecerasGql[k] = String(v);
      }
    }
  }

  window.fetch = function (entrada, opciones) {
    var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada);
    var metodo = (opciones && opciones.method) || (entrada && entrada.method) || 'GET';
    if (url.indexOf('https://gql.twitch.tv/') === 0) {
      anotarCabeceras(entrada && entrada.headers);
      anotarCabeceras(opciones && opciones.headers);
    }
    if (String(metodo).toUpperCase() === 'GET') {
      var nuestra = atender(url);
      if (nuestra) {
        return nuestra.then(function (r) {
          if (!r || !r.status) throw new TypeError('Failed to fetch');
          return new Response(r.texto, { status: r.status, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
        });
      }
    }
    return fetchReal(entrada, opciones);
  };

  function XHR() {
    var x = new XHRReal();
    var abrir = x.open;
    var enviar = x.send;
    var abortar = x.abort;
    var datos = null;
    x.open = function (metodo, url) {
      datos = { metodo: String(metodo).toUpperCase(), url: String(url), cancelada: false };
      return abrir.apply(x, arguments);
    };
    x.abort = function () {
      if (datos) datos.cancelada = true;
      return abortar.apply(x, arguments);
    };
    x.send = function () {
      var nuestra = datos && datos.metodo === 'GET' ? atender(datos.url) : null;
      if (!nuestra) return enviar.apply(x, arguments);
      var d = datos;
      nuestra.then(function (r) { if (!d.cancelada) responder(x, d.url, r.status, r.texto); },
        function (e) { log('fallo', e && e.message); if (!d.cancelada) responder(x, d.url, 0, ''); });
    };
    return x;
  }
  XHR.prototype = XHRReal.prototype;
  ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (k, i) { XHR[k] = i; });

  function responder(x, url, status, texto) {
    function fijar(nombre, valor) { Object.defineProperty(x, nombre, { value: valor, configurable: true, writable: true }); }
    fijar('readyState', 4);
    fijar('status', status);
    fijar('statusText', status === 200 ? 'OK' : '');
    fijar('responseURL', url);
    fijar('responseText', texto);
    fijar('response', x.responseType === 'arraybuffer' ? new TextEncoder().encode(texto).buffer : texto);
    var total = texto.length;
    try { if (typeof x.onprogress === 'function') x.onprogress({ loaded: total, total: total, lengthComputable: true }); } catch (e) { log('onprogress', e.message); }
    try { if (typeof x.onreadystatechange === 'function') x.onreadystatechange(new Event('readystatechange')); } catch (e) { log('onreadystatechange', e.message); }
    try { x.dispatchEvent(new Event('readystatechange')); } catch (e) { /* nada */ }
    var fin = status ? 'load' : 'error';
    try { if (typeof x['on' + fin] === 'function') x['on' + fin](new ProgressEvent(fin, { loaded: total, total: total })); } catch (e) { log('on' + fin, e.message); }
    try { x.dispatchEvent(new ProgressEvent(fin, { loaded: total, total: total })); } catch (e) { /* nada */ }
    try { if (typeof x.onloadend === 'function') x.onloadend(new ProgressEvent('loadend')); x.dispatchEvent(new ProgressEvent('loadend')); } catch (e) { /* nada */ }
  }

  window.XMLHttpRequest = XHR;
  log('listo', window.__twitchSinAnuncios);
})();
