# Twitch sin anuncios (TizenBrew)

Módulo de [TizenBrew](https://github.com/reisxd/TizenBrew) para ver Twitch en una tele Samsung sin los anuncios de los directos.

Abre la app oficial de Twitch para teles (`samsung.tv.twitch.tv`), la que se maneja con el mando, y le añade un script que mira cada lista del directo antes de que llegue al reproductor:

- Si Twitch ha metido un anuncio, pide la **misma emisión con otro tipo de reproductor** (popout, site, embed, mobile_web) y le da esa, que suele venir limpia y con la misma calidad. Si todas traen anuncio, tira de la de 360p (autoplay) solo mientras dure y vuelve sola a la calidad normal.
- Si ninguna viene limpia, quita los trozos del anuncio: la imagen se queda quieta unos segundos en vez de poner el anuncio.
- Las marcas de anuncio desaparecen de las listas, así que la app no enseña su aviso de «Anuncio».

En los vídeos (VOD) quita los trozos de anuncio que vengan dentro.

## Instalar

En TizenBrew: gestor de módulos (el icono de la caja) → **Añadir módulo GitHub**, escribe

```
Riscooo/twitch-sin-anuncios
```

y cierra el teclado con «Hecho» (no hay botón: se añade al salir del cuadro).

Sale como «Twitch» en la lista de TizenBrew. Para iniciar sesión, la app te da un código para `twitch.tv/activate`.

TizenBrew mete el script al abrirse la página, no antes (con `evaluateScriptOnDocumentStart` el módulo no llega a abrirse en TizenBrew 2.0.5: la app espera un aviso del servicio que no casa con su nombre). Da igual: hls.js crea cada petición en el momento, así que coge el XMLHttpRequest y el fetch del script.

## Límites

Twitch cambia cómo mete los anuncios de vez en cuando; si algún día vuelven a salir, toca actualizar el script. Durante algunos cortes puede verse a 360p unos segundos.

## Pruebas

```
npm test                                  # con un Twitch de mentira
node pruebas/navegador.cjs <canal> 60     # con la app real, en un Firefox sin ventana (Playwright)
PRUEBA='{"normalConAnunciosHasta":30,"soloBajaHasta":30}' node pruebas/navegador.cjs <canal> 60
```

La idea de pedir la emisión con otro tipo de reproductor viene de [TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions) (y su continuación, [ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions)), con licencia MIT.
