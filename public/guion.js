'use strict';
/*
 * Recetas. Sin dependencias ni compilacion, como el resto de la casa.
 *
 * ── Como se pinta ──────────────────────────────────────────────────────────
 *
 * El estado entero vive en `datos.recetas` y la pantalla se redibuja desde
 * ahi. Nada se lee del DOM para saber que hay: el DOM es solo la foto de ese
 * objeto en un momento dado. Eso evita el error clasico de estas pantallas,
 * que es cambiar las raciones y que la mitad de las cantidades se queden como
 * estaban porque una se actualizo y la otra no.
 *
 * ── Lo que se guarda y lo que no ───────────────────────────────────────────
 *
 * Se guarda la receta. NO se guardan las marcas de «esto ya lo tengo» ni «este
 * paso ya esta hecho», que viven en un Set aqui al lado y se van al recargar:
 * son de esta vez que se cocina, no de la receta. Guardarlas obligaria a
 * acordarse de limpiarlas antes de la siguiente.
 *
 * Tampoco se guardan las raciones del escalador. La receta esta escrita para
 * las que diga su ficha; el escalador contesta «y si somos seis» sin reescribir
 * nada, y por eso al salir y volver se lee otra vez como esta escrita.
 *
 * ── Por que se cambia antes de que conteste el servidor ────────────────────
 *
 * Marcar, escalar y tachar repintan al instante; lo que hay que guardar se
 * manda despues. Esto se usa con una mano pringada y el movil apoyado en la
 * encimera: esperar 300 ms a que conteste el servidor para tachar un paso se
 * nota muchisimo. Si la peticion falla se avisa y se recarga el estado, que es
 * el trato: rapido casi siempre, honesto cuando falla.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var datos = { recetas: [], apartados: [], dificultades: [] };
  var abiertaId = null;

  /*
   * Los filtros del carril, que son tres cosas distintas y por eso son tres
   * variables y no una:
   *
   *   · el apartado: '*', 'Comidas' o 'Postres'
   *   · las favoritas: si o no
   *   · las etiquetas elegidas, que se acumulan y se exigen TODAS
   *
   * Lo ultimo es a proposito: «fitness» y «pollo» juntas tienen que dar las
   * recetas que son las dos cosas, no la suma de las dos listas. Sumar es lo
   * que hace un buscador; cruzar es lo que hace un filtro.
   */
  var filtroApartado = '*';
  var soloFav = false;
  var tags = new Set();
  var busca = '';

  /* Las raciones que se estan leyendo. null significa «las de la receta», y es
     distinto de tener el mismo numero a mano: al cambiar de receta hay que
     volver a las suyas, no quedarse en las seis de la anterior. */
  var racionesVista = null;

  /* Marcas de esta sesion. Un Set de ids de ingredientes y de pasos, sin
     separar: los ids ya son unicos dentro del recetario. */
  var marcados = new Set();

  var cocinando = false;
  var candado = null;   /* el Wake Lock, si el navegador lo tiene */

  /* ── Utilidades ───────────────────────────────────────────────────────── */

  async function api(ruta, opciones) {
    var r = await fetch(ruta, opciones);
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || ('Error ' + r.status));
    return d;
  }

  function json(metodo, cuerpo) {
    return {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    };
  }

  function recado(t, clase) {
    var r = $('recado');
    if (!t) { r.hidden = true; return; }
    r.textContent = t;
    r.className = 'recado' + (clase ? ' ' + clase : '');
    r.hidden = false;
    clearTimeout(recado.reloj);
    recado.reloj = setTimeout(function () { r.hidden = true; }, clase === 'malo' ? 7000 : 3500);
  }

  function laAbierta() {
    return datos.recetas.find(function (r) { return r.id === abiertaId; }) || null;
  }

  /* Un fallo al guardar no se puede dejar pasar en silencio: la pantalla ya
     ensena el cambio. Se avisa y se vuelve a pedir el estado, que es mas
     honesto que intentar deshacer a mano cada tipo de cambio. */
  async function falloAlGuardar(e) {
    recado(e.message, 'malo');
    try {
      var d = await api('/api/estado');
      datos.recetas = d.recetas || [];
      pintar();
    } catch (_) { /* si esto tambien falla, el recado ya lo dice */ }
  }

  /*
   * Texto comparable: sin acentos, sin mayusculas y sin espacios de sobra.
   *
   * Buscar «jalapeno» tiene que encontrar «jalapeño» y buscar «PURE» tiene que
   * encontrar «puré». Quien escribe en el buscador tiene una mano ocupada y no
   * va a poner la tilde.
   */
  function llano(t) {
    return String(t == null ? '' : t)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim();
  }

  /* Un debounce por campo: los campos de texto se guardan al parar de escribir
     y no en cada tecla. La clave los separa, para que escribir en las notas no
     cancele el guardado del titulo. */
  var relojes = {};
  function alParar(clave, ms, hacer) {
    clearTimeout(relojes[clave]);
    relojes[clave] = setTimeout(hacer, ms);
  }

  /* ── Cantidades ───────────────────────────────────────────────────────── */

  var FRACCIONES = [
    [1 / 2, '½'], [1 / 3, '⅓'], [2 / 3, '⅔'],
    [1 / 4, '¼'], [3 / 4, '¾'], [1 / 8, '⅛'],
  ];

  /*
   * Una cantidad, escrita como se escribe en una receta.
   *
   * Media cebolla es «½ cebolla» y no «0.5 cebolla»; 375 g son 375 g y no
   * 375,000. Las reglas, de mas fuerte a mas debil:
   *
   *   · de 10 para arriba se redondea a entero, o a medio si la mitad importa
   *     (12,5 g de levadura es un dato; 187,3 g de harina es ruido de calculo)
   *   · por debajo de 10 se busca una fraccion conocida con tolerancia, porque
   *     un tercio de vaso es «⅓» y no «0,33»
   *   · si no encaja ninguna, dos decimales como maximo y sin ceros de relleno
   */
  function cifra(n) {
    if (!isFinite(n) || n === null) return '';
    if (n === 0) return '0';

    if (n >= 10) {
      var medio = Math.round(n * 2) / 2;
      return (medio % 1 === 0 ? String(medio) : String(medio).replace('.', ','));
    }

    var entero = Math.floor(n);
    var resto = n - entero;

    for (var i = 0; i < FRACCIONES.length; i++) {
      if (Math.abs(resto - FRACCIONES[i][0]) < 0.04) {
        return (entero ? entero : '') + FRACCIONES[i][1];
      }
    }
    if (resto < 0.04) return String(entero);
    if (resto > 0.96) return String(entero + 1);

    return String(Math.round(n * 100) / 100).replace('.', ',');
  }

  /* Cuantas raciones se estan leyendo ahora mismo. */
  function racionesDe(r) {
    return racionesVista || r.raciones || 1;
  }

  /* El factor por el que se multiplican las cantidades. 1 cuando se lee la
     receta tal y como esta escrita, que es el caso normal. */
  function factorDe(r) {
    var base = r.raciones || 1;
    return racionesDe(r) / base;
  }

  /* La cantidad de un ingrediente, ya escalada y con su unidad. Vacio si esa
     linea no traia cantidad: «sal al gusto» no se multiplica por nada. */
  function cantidadDe(ing, factor) {
    if (ing.cantidad === null || ing.cantidad === undefined) return '';
    var n = cifra(ing.cantidad * factor);
    return ing.unidad ? n + ' ' + ing.unidad : n;
  }

  /* La linea entera tal y como se escribiria a mano. Es lo que se manda al
     servidor al editar, y lleva SIEMPRE la cantidad de la receta —nunca la
     escalada—, porque lo que se guarda es la receta. */
  function lineaDe(ing) {
    var trozos = [];
    if (ing.cantidad !== null && ing.cantidad !== undefined) trozos.push(cifra(ing.cantidad));
    if (ing.unidad) trozos.push(ing.unidad);
    if (ing.resto) trozos.push(ing.resto);
    return trozos.join(' ');
  }

  /* ── Iconos ───────────────────────────────────────────────────────────── */

  /* Se pintan con innerHTML a proposito y no con textContent: son marcas fijas
     escritas aqui, no datos. Todo lo que venga del usuario va con textContent,
     sin excepcion. */
  var TIC = '<svg class="ico ico-tic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ico-marca" d="M5 12l5 5l10 -10"/></svg>';
  var ASPA = '<svg class="ico ico-aspa" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6l-12 12"/><path d="M6 6l12 12"/></svg>';
  var ESTRELLA = '<svg class="ico ico-estrella" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1.002l3.086 -6.253l3.086 6.253l6.9 1.002l-5 4.867l1.179 6.873z"/></svg>';
  var ARRIBA = '<svg class="ico ico-arriba" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6 -6l6 6"/></svg>';
  var ABAJO = '<svg class="ico ico-abajo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6"/></svg>';

  /* ── El carril ────────────────────────────────────────────────────────── */

  /*
   * Las recetas que pasan el filtro y la busqueda.
   *
   * La busqueda mira el nombre, la descripcion, las etiquetas, el apartado y
   * los INGREDIENTES. Eso ultimo es lo que la hace util: delante de la nevera
   * la pregunta no es «como se llamaba» sino «que hago con dos calabacines».
   */
  function visibles() {
    var t = llano(busca);
    return datos.recetas.filter(function (r) {
      if (soloFav && !r.favorita) return false;
      if (filtroApartado !== '*' && r.apartado !== filtroApartado) return false;

      /* Todas las etiquetas elegidas, no una cualquiera. */
      if (tags.size) {
        var suyas = (r.etiquetas || []).map(llano);
        var faltaAlguna = false;
        tags.forEach(function (e) { if (suyas.indexOf(llano(e)) === -1) faltaAlguna = true; });
        if (faltaAlguna) return false;
      }

      if (!t) return true;

      var paja = [r.titulo, r.descripcion, r.apartado].concat(r.etiquetas || []);
      (r.ingredientes || []).forEach(function (i) { paja.push(i.resto); });
      return llano(paja.join(' ')).indexOf(t) !== -1;
    }).sort(function (a, b) {
      return llano(a.titulo).localeCompare(llano(b.titulo), 'es');
    });
  }

  /*
   * Las etiquetas que existen, de la mas usada a la menos.
   *
   * Por frecuencia y no por orden alfabetico: las que se repiten son las que
   * de verdad sirven para filtrar —«pollo», «fitness»— y las que se pusieron
   * una vez van al final, que es donde estorban menos.
   */
  function etiquetasDelRecetario() {
    var cuenta = new Map();
    datos.recetas.forEach(function (r) {
      (r.etiquetas || []).forEach(function (e) { cuenta.set(e, (cuenta.get(e) || 0) + 1); });
    });
    return [...cuenta.entries()]
      .sort(function (a, b) { return b[1] - a[1] || llano(a[0]).localeCompare(llano(b[0]), 'es'); })
      .map(function (x) { return x[0]; });
  }

  /* Un chip de filtro. `puesto` dice si esta activo y `alPulsar` lo cambia;
     todos los filtros se comportan igual, asi que se pintan igual. */
  function chip(caja, etiqueta, puesto, alPulsar, icono) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (puesto ? ' activo' : '') + (icono ? ' chip-estrella' : '');
    b.setAttribute('aria-pressed', puesto ? 'true' : 'false');
    if (icono) {
      var i = document.createElement('span');
      i.innerHTML = icono;
      b.appendChild(i);
    }
    b.appendChild(document.createTextNode(etiqueta));
    b.onclick = function () { alPulsar(); pintar(); };
    caja.appendChild(b);
    return b;
  }

  /* Cuantas etiquetas se enseñan antes de plegar el resto. Ocho caben en dos
     lineas del carril; a partir de ahi el filtro empieza a comerse la lista
     que tiene que filtrar. */
  var TOPE_TAGS = 8;
  var tagsDesplegadas = false;

  function pintarFiltros() {
    var caja = $('filtros');
    caja.textContent = '';

    chip(caja, 'Todo', filtroApartado === '*' && !soloFav && !tags.size, function () {
      /* «Todo» no es un filtro mas: es el boton de quitarlos todos, incluidas
         las etiquetas. Sin el hay que acordarse de despulsar una por una. */
      filtroApartado = '*';
      soloFav = false;
      tags.clear();
    });

    datos.apartados.forEach(function (a) {
      if (!datos.recetas.some(function (r) { return r.apartado === a; })) return;
      chip(caja, a, filtroApartado === a, function () {
        filtroApartado = (filtroApartado === a) ? '*' : a;
      });
    });

    if (datos.recetas.some(function (r) { return r.favorita; })) {
      chip(caja, 'Favoritas', soloFav, function () { soloFav = !soloFav; }, ESTRELLA);
    }

    /* ── Las etiquetas ── */
    var cajaTags = $('filtros-tags');
    cajaTags.textContent = '';
    var todas = etiquetasDelRecetario();
    /* Una etiqueta elegida se enseña siempre, aunque este mas alla del tope:
       si no, pulsarla y que desaparezca de su sitio es imposible de deshacer. */
    var visiblesTags = tagsDesplegadas
      ? todas
      : todas.filter(function (e, i) { return i < TOPE_TAGS || tags.has(e); });

    visiblesTags.forEach(function (e) {
      chip(cajaTags, e, tags.has(e), function () {
        if (tags.has(e)) tags.delete(e);
        else tags.add(e);
      });
    });

    if (todas.length > visiblesTags.length || tagsDesplegadas) {
      var mas = document.createElement('button');
      mas.type = 'button';
      mas.className = 'chip chip-mas';
      mas.textContent = tagsDesplegadas ? 'menos' : '+' + (todas.length - visiblesTags.length) + ' más';
      mas.onclick = function () { tagsDesplegadas = !tagsDesplegadas; pintarFiltros(); };
      cajaTags.appendChild(mas);
    }
  }

  /* Una fila del carril. */
  function filaDe(r) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'lista-enlace' + (r.id === abiertaId ? ' activa' : '');
    b.setAttribute('role', 'listitem');

    /* La miniatura, si la hay. Un recetario con fotos se recorre mirando, y
       esto es lo que lo diferencia de una lista de nombres. Quien no tenga
       foto no deja hueco: una fila mas baja es mejor que un cuadro gris. */
    if (r.foto) {
      var img = document.createElement('img');
      img.className = 'lista-foto';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = '/fotos/' + r.id + '.jpg?v=' + r.foto;
      b.appendChild(img);
    }

    if (r.favorita) {
      var e = document.createElement('span');
      e.className = 'lista-estrella';
      e.innerHTML = ESTRELLA;
      b.appendChild(e);
    }

    var n = document.createElement('span');
    n.className = 'lista-nombre';
    n.textContent = r.titulo;
    b.appendChild(n);

    b.onclick = function () { abrir(r.id); };
    return b;
  }

  function pintarCarril() {
    var caja = $('listas');
    caja.textContent = '';

    var lista = visibles();
    $('carril-nota').hidden = datos.recetas.length > 0;

    /*
     * Dos apartados con su rotulo, y no una lista seguida.
     *
     * Comidas y postres se buscan en momentos distintos, asi que tenerlos
     * mezclados por orden alfabetico obliga a leer la lista entera para
     * encontrar el bizcocho. Un apartado sin nada no se pinta: un rotulo con
     * hueco debajo se lee como que algo ha fallado.
     */
    datos.apartados.forEach(function (a) {
      var suyas = lista.filter(function (r) { return r.apartado === a; });
      if (!suyas.length) return;

      var rotulo = document.createElement('p');
      rotulo.className = 'carril-apartado';
      rotulo.textContent = a;
      caja.appendChild(rotulo);

      suyas.forEach(function (r) { caja.appendChild(filaDe(r)); });
    });

    /* Que no haya ninguna receta y que ninguna pase el filtro son dos cosas
       distintas, y la segunda necesita decir como se deshace. */
    if (!lista.length && datos.recetas.length) {
      var p = document.createElement('p');
      p.className = 'carril-nota';
      p.textContent = busca
        ? 'Nada con «' + busca + '».'
        : 'Ninguna receta con esos filtros. Pulsa «Todo» para quitarlos.';
      caja.appendChild(p);
    }
  }

  /* ── La receta ────────────────────────────────────────────────────────── */

  function pintarFicha(r) {
    $('titulo-receta').value = r.titulo;
    $('descripcion').value = r.descripcion || '';

    $('apartado').value = r.apartado;
    pintarFoto(r);

    $('tiempo').value = (r.tiempo === null || r.tiempo === undefined) ? '' : r.tiempo;
    $('dificultad').value = r.dificultad;
    $('raciones').value = r.raciones;

    var fav = $('favorita');
    fav.setAttribute('aria-pressed', r.favorita ? 'true' : 'false');
    fav.setAttribute('aria-label', r.favorita ? 'Quitar de favoritas' : 'Marcar como favorita');

    $('notas').value = r.notas || '';
    ajustarNotas();

    /* El pie: las veces que se ha hecho y cuando fue la ultima. */
    var cuenta = $('pie-cuenta');
    if (!r.veces) cuenta.textContent = 'Todavía no la has hecho.';
    else {
      cuenta.textContent = 'Hecha ' + (r.veces === 1 ? 'una vez' : r.veces + ' veces') +
        (r.ultimaVez ? ' · la última, ' + fecha(r.ultimaVez) : '');
    }
  }

  /*
   * La foto de la receta.
   *
   * La direccion lleva la marca de tiempo de la subida (`?v=`), que es lo que
   * hace que al cambiarla se vea la nueva: sin eso el navegador reaprovecha la
   * que ya tiene en cache —misma direccion, misma imagen— y parece que no se
   * ha guardado.
   */
  function pintarFoto(r) {
    var hay = !!r.foto;
    $('foto-caja').hidden = !hay;
    $('poner-foto').hidden = hay;
    if (hay) {
      $('foto-imagen').src = '/fotos/' + r.id + '.jpg?v=' + r.foto;
      $('foto-imagen').alt = 'Foto de ' + r.titulo;
    } else {
      /* Se vacia al quitarla: si no, al abrir la siguiente receta sin foto se
         quedaria un instante la de la anterior. */
      $('foto-imagen').removeAttribute('src');
    }
  }

  /*
   * Reducir la imagen antes de subirla.
   *
   * Una foto de movil son ocho megas y 4000 px de ancho; aqui se ve a 700 px
   * como mucho. Pasarla por un canvas a 1600 px y JPEG de calidad 0,82 la deja
   * en un par de cientos de kilobytes sin que se note, y eso es lo que decide
   * si subir una receta desde el movil con datos tarda un segundo o veinte.
   *
   * De paso resuelve dos cosas gratis: quita los metadatos —incluido DONDE se
   * hizo la foto, que no tiene por que viajar— y convierte a JPEG cualquier
   * formato que el navegador sepa abrir, HEIC de iPhone incluido.
   */
  function reducir(fichero) {
    return new Promise(function (bien, mal) {
      var url = URL.createObjectURL(fichero);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var LADO = 1600;
        var escala = Math.min(1, LADO / Math.max(img.naturalWidth, img.naturalHeight));
        var lienzo = document.createElement('canvas');
        lienzo.width = Math.round(img.naturalWidth * escala);
        lienzo.height = Math.round(img.naturalHeight * escala);
        lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
        lienzo.toBlob(function (blob) {
          if (blob) bien(blob);
          else mal(new Error('No he podido preparar esa imagen.'));
        }, 'image/jpeg', 0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        mal(new Error('No he podido leer esa imagen.'));
      };
      img.src = url;
    });
  }

  async function subirFoto(fichero) {
    var r = laAbierta();
    if (!r || !fichero) return;
    try {
      recado('Preparando la foto…');
      var blob = await reducir(fichero);
      var resp = await fetch('/api/recetas/' + r.id + '/foto', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      var d = await resp.json().catch(function () { return {}; });
      if (!resp.ok) throw new Error(d.error || ('Error ' + resp.status));
      Object.assign(r, d.receta);
      pintarFoto(r);
      pintarCarril();
      recado('Foto guardada.');
    } catch (e) {
      recado(e.message, 'malo');
    }
  }

  function pedirFoto() {
    $('campo-foto').click();
  }

  $('poner-foto').onclick = pedirFoto;
  $('cambiar-foto').onclick = pedirFoto;
  $('campo-foto').onchange = function () {
    var f = $('campo-foto').files && $('campo-foto').files[0];
    /* El campo se vacia despues de leerlo: si no, volver a elegir la MISMA
       foto no dispara change y parece que la app se ha quedado colgada. */
    subirFoto(f);
    $('campo-foto').value = '';
  };

  $('quitar-foto').onclick = async function () {
    var r = laAbierta();
    if (!r) return;
    try {
      var d = await api('/api/recetas/' + r.id + '/foto', { method: 'DELETE' });
      Object.assign(r, d.receta);
      pintarFoto(r);
      pintarCarril();
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  /* Una fecha como se dice, no como se escribe en un log. */
  function fecha(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var dias = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    if (dias < 7) return 'hace ' + dias + ' días';
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function pintarEtiquetas(r) {
    var caja = $('etiquetas');
    caja.textContent = '';
    (r.etiquetas || []).forEach(function (e) {
      var chip = document.createElement('span');
      chip.className = 'etiqueta';
      chip.appendChild(document.createTextNode(e));

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'etiqueta-quitar';
      x.setAttribute('aria-label', 'Quitar la etiqueta ' + e);
      x.innerHTML = ASPA;
      x.onclick = function () {
        guardarCampos(r, {
          etiquetas: r.etiquetas.filter(function (o) { return o !== e; }),
        });
      };
      chip.appendChild(x);
      caja.appendChild(chip);
    });
  }

  /*
   * El rotulo de los ingredientes.
   *
   * En modo cocina el escalador no esta —no se toquetean raciones con las manos
   * en la masa— asi que las raciones se dicen aqui. Sin esto quedaba la cifra
   * suelta a la derecha, sin sus botones y sin nada que explicara que era.
   */
  function rotularIngredientes(r) {
    $('rotulo-ingredientes').textContent = cocinando
      ? 'Ingredientes · para ' + racionesDe(r)
      : 'Ingredientes';
  }

  function pintarEscalador(r) {
    var n = racionesDe(r);
    $('escalador-cifra').textContent = n;
    var cambiado = n !== (r.raciones || 1);
    $('escalador-cifra').parentNode.classList.toggle('cambiado', cambiado);
    $('volver-raciones').hidden = !cambiado;
  }

  function pintarIngredientes(r) {
    var caja = $('ingredientes');
    caja.textContent = '';

    var factor = factorDe(r);
    /* Con la vista escalada las lineas no se editan: lo que se lee no es lo que
       hay guardado, y dejar guardar ahi seria la forma mas facil de convertir
       «para 6» en la receta de verdad sin querer. El escalador ya avisa en azul
       y ofrece volver. */
    var editable = factor === 1;

    r.ingredientes.forEach(function (ing) {
      var li = document.createElement('li');
      li.className = 'ingrediente';
      if (marcados.has(ing.id)) li.classList.add('marcado');
      if (ing.cantidad === null || ing.cantidad === undefined) li.classList.add('sin-cantidad');

      var casilla = document.createElement('button');
      casilla.type = 'button';
      casilla.className = 'casilla';
      casilla.setAttribute('aria-pressed', marcados.has(ing.id) ? 'true' : 'false');
      casilla.setAttribute('aria-label', 'Ya tengo ' + (ing.resto || 'esto'));
      casilla.innerHTML = TIC;
      casilla.onclick = function () { marcar(ing.id); };
      li.appendChild(casilla);

      var cant = document.createElement('span');
      cant.className = 'ing-cantidad';
      cant.textContent = cantidadDe(ing, factor);
      if (editable) {
        cant.contentEditable = 'plaintext-only';
        cant.setAttribute('aria-label', 'Cantidad');
        alSalir(cant, function () {
          var texto = (cant.textContent || '').trim() + ' ' + (ing.resto || '');
          cambiarIngrediente(ing, texto.trim(), cant);
        });
      }
      li.appendChild(cant);

      var txt = document.createElement('div');
      txt.className = 'ing-texto';
      txt.textContent = ing.resto || '';
      if (editable) {
        txt.contentEditable = 'plaintext-only';
        txt.setAttribute('aria-label', 'Ingrediente');
        alSalir(txt, function () {
          /* La cantidad se vuelve a poner delante desde lo GUARDADO, no desde
             lo que se ve: asi editar «harina» en la vista de seis raciones no
             podria colar un 300 donde habia un 200. */
          var trozos = [];
          if (ing.cantidad !== null && ing.cantidad !== undefined) trozos.push(cifra(ing.cantidad));
          if (ing.unidad) trozos.push(ing.unidad);
          trozos.push((txt.textContent || '').trim());
          cambiarIngrediente(ing, trozos.join(' ').trim(), txt);
        });
      }
      li.appendChild(txt);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'linea-quitar';
      x.setAttribute('aria-label', 'Quitar este ingrediente');
      x.innerHTML = ASPA;
      x.onclick = function () { quitarIngrediente(r, ing); };
      li.appendChild(x);

      caja.appendChild(li);
    });
  }

  function pintarPasos(r) {
    var caja = $('pasos');
    caja.textContent = '';

    r.pasos.forEach(function (paso, indice) {
      var li = document.createElement('li');
      li.className = 'paso';
      if (marcados.has(paso.id)) li.classList.add('marcado');

      /* El numero lo pinta el CSS con un contador. Aqui solo va el boton, que
         es lo que se toca para marcar el paso como hecho. */
      var num = document.createElement('button');
      num.type = 'button';
      num.className = 'paso-num';
      num.setAttribute('aria-pressed', marcados.has(paso.id) ? 'true' : 'false');
      num.setAttribute('aria-label', 'Paso ' + (indice + 1) + ', marcar como hecho');
      num.onclick = function () { marcar(paso.id); };
      li.appendChild(num);

      /* El texto y la foto van juntos en una columna: la foto es de ESE paso y
         tiene que quedar debajo de sus palabras, no suelta en la receta. */
      var cuerpo = document.createElement('div');
      cuerpo.className = 'paso-cuerpo';

      var txt = document.createElement('div');
      txt.className = 'paso-texto';
      txt.contentEditable = 'plaintext-only';
      txt.setAttribute('aria-label', 'Paso ' + (indice + 1));
      txt.textContent = paso.texto;
      alSalir(txt, function () {
        var t = (txt.textContent || '').trim();
        if (t === paso.texto) return;
        if (!t) { txt.textContent = paso.texto; return recado('Un paso vacío no es un paso.', 'malo'); }
        paso.texto = t;
        api('/api/pasos/' + paso.id, json('PATCH', { texto: t })).catch(falloAlGuardar);
      });
      cuerpo.appendChild(txt);

      li.appendChild(cuerpo);

      var mando = document.createElement('span');
      mando.className = 'paso-mando';

      mando.appendChild(mover(r, indice, -1, ARRIBA, 'Subir este paso'));
      mando.appendChild(mover(r, indice, 1, ABAJO, 'Bajar este paso'));
      li.appendChild(mando);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'linea-quitar';
      x.setAttribute('aria-label', 'Quitar este paso');
      x.innerHTML = ASPA;
      x.onclick = function () { quitarPaso(r, paso); };
      li.appendChild(x);

      caja.appendChild(li);
    });
  }

  function mover(r, indice, salto, icono, rotulo) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'paso-mover';
    b.innerHTML = icono;
    b.setAttribute('aria-label', rotulo);
    b.disabled = (indice + salto < 0) || (indice + salto >= r.pasos.length);
    b.onclick = function () {
      var otros = r.pasos.slice();
      var uno = otros.splice(indice, 1)[0];
      otros.splice(indice + salto, 0, uno);
      r.pasos = otros;
      pintarPasos(r);
      api('/api/recetas/' + r.id + '/orden', json('POST', {
        que: 'pasos',
        ids: otros.map(function (p) { return p.id; }),
      })).catch(falloAlGuardar);
    };
    return b;
  }

  function pintarTablero() {
    var r = laAbierta();
    $('vacio').hidden = !!r;
    $('receta-abierta').hidden = !r;

    if (!r) {
      $('vacio-texto').textContent = datos.recetas.length
        ? 'Elige una receta.'
        : 'Escribe el nombre de tu primera receta ahí al lado.';
      return;
    }

    pintarFicha(r);
    pintarEtiquetas(r);
    rotularIngredientes(r);
    pintarEscalador(r);
    pintarIngredientes(r);
    pintarPasos(r);
    pintarCocina(r);
  }

  function pintar() {
    pintarFiltros();
    pintarCarril();
    pintarTablero();
  }

  function abrir(id) {
    abiertaId = id;
    /* Cada receta se abre como esta escrita, con sus raciones y sin marcas de
       la anterior: son cosas de la sesion, no del recetario. */
    racionesVista = null;
    marcados.clear();
    pintar();
    if (window.innerWidth <= 832) verCarril(false);
    $('tablero').scrollTop = 0;
  }

  /* ── Cambios ──────────────────────────────────────────────────────────── */

  /*
   * Guardar campos de la receta.
   *
   * Se aplican en el objeto antes de mandarlos y se repinta: el resto de la
   * pantalla depende de ellos —el nombre esta en el carril, la categoria en el
   * filtro, las raciones en el escalador— y esperar la respuesta para eso se ve
   * como un tiron.
   */
  function guardarCampos(r, cambios, silencioso) {
    Object.assign(r, cambios);
    if (!silencioso) pintar();
    return api('/api/recetas/' + r.id, json('PATCH', cambios)).catch(falloAlGuardar);
  }

  function marcar(id) {
    if (marcados.has(id)) marcados.delete(id);
    else marcados.add(id);
    var r = laAbierta();
    if (!r) return;
    pintarIngredientes(r);
    pintarPasos(r);
    pintarCocina(r);
  }

  async function cambiarIngrediente(ing, texto, caja) {
    if (!texto) {
      /* Vaciar una linea no borra el ingrediente: para eso esta el aspa, que no
         se pulsa por accidente al seleccionar todo y darle a borrar. */
      caja.textContent = caja.classList.contains('ing-cantidad') ? cantidadDe(ing, 1) : (ing.resto || '');
      return recado('Para quitarlo, la aspa de la derecha.', 'malo');
    }
    if (texto === lineaDe(ing)) return;
    try {
      var d = await api('/api/ingredientes/' + ing.id, json('PATCH', { texto: texto }));
      Object.assign(ing, d.ingrediente);
      pintarIngredientes(laAbierta());
    } catch (e) {
      falloAlGuardar(e);
    }
  }

  async function quitarIngrediente(r, ing) {
    r.ingredientes = r.ingredientes.filter(function (x) { return x.id !== ing.id; });
    pintarIngredientes(r);
    try {
      await api('/api/ingredientes/' + ing.id, { method: 'DELETE' });
    } catch (e) { falloAlGuardar(e); }
  }

  async function quitarPaso(r, paso) {
    r.pasos = r.pasos.filter(function (x) { return x.id !== paso.id; });
    pintarPasos(r);
    pintarCocina(r);
    try {
      await api('/api/pasos/' + paso.id, { method: 'DELETE' });
    } catch (e) { falloAlGuardar(e); }
  }

  /*
   * Guardar al salir de un campo que se escribe dentro de la pagina.
   *
   * Intro guarda y Escape deshace, que es lo que se espera de un campo que no
   * tiene boton de aceptar. El blur guarda tambien: en el movil no se pulsa
   * Intro, se toca en otro sitio.
   */
  function alSalir(caja, guardar) {
    var original = caja.textContent;
    caja.addEventListener('focus', function () { original = caja.textContent; });
    caja.addEventListener('blur', function () { guardar(); });
    caja.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); caja.blur(); }
      if (ev.key === 'Escape') { ev.preventDefault(); caja.textContent = original; caja.blur(); }
    });
  }

  /* ── Formularios ──────────────────────────────────────────────────────── */

  $('form-receta').onsubmit = async function (ev) {
    ev.preventDefault();
    var campo = $('nueva-receta');
    var titulo = campo.value.trim();
    if (!titulo) return;
    try {
      var d = await api('/api/recetas', json('POST', { titulo: titulo }));
      campo.value = '';
      datos.recetas.push(d.receta);
      /* Se abre la recien creada: se acaba de nombrar para escribirla ahora, no
         para verla en una lista. */
      filtroApartado = '*';
      soloFav = false;
      tags.clear();
      busca = '';
      $('buscar').value = '';
      $('limpiar-busca').hidden = true;
      abrir(d.receta.id);
      $('nuevo-ingrediente').focus();
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  $('form-ingrediente').onsubmit = async function (ev) {
    ev.preventDefault();
    var r = laAbierta();
    var campo = $('nuevo-ingrediente');
    var texto = campo.value.trim();
    if (!r || !texto) return;
    try {
      var d = await api('/api/recetas/' + r.id + '/ingredientes', json('POST', { texto: texto }));
      campo.value = '';
      r.ingredientes.push(d.ingrediente);
      /* La vista vuelve a las raciones de la receta al añadir: lo que se acaba
         de escribir es una cantidad de la receta, y verla multiplicada por 1,5
         justo debajo de haberla escrito se lee como un error. */
      racionesVista = null;
      pintarEscalador(r);
      pintarIngredientes(r);
      campo.focus();
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  $('form-paso').onsubmit = async function (ev) {
    ev.preventDefault();
    var r = laAbierta();
    var campo = $('nuevo-paso');
    var texto = campo.value.trim();
    if (!r || !texto) return;
    try {
      var d = await api('/api/recetas/' + r.id + '/pasos', json('POST', { texto: texto }));
      campo.value = '';
      r.pasos.push(d.paso);
      pintarPasos(r);
      pintarCocina(r);
      campo.focus();
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  $('form-etiqueta').onsubmit = function (ev) {
    ev.preventDefault();
    var r = laAbierta();
    var campo = $('nueva-etiqueta');
    var t = campo.value.trim().toLowerCase();
    if (!r || !t) return;
    campo.value = '';
    if ((r.etiquetas || []).indexOf(t) !== -1) return;
    guardarCampos(r, { etiquetas: (r.etiquetas || []).concat([t]) });
  };

  /* ── La ficha ─────────────────────────────────────────────────────────── */

  $('titulo-receta').oninput = function () {
    var r = laAbierta();
    if (!r) return;
    var t = $('titulo-receta').value.trim();
    if (!t) return;
    r.titulo = t;
    /* El carril se repinta ya —el nombre esta alli— pero el guardado espera a
       que se pare de escribir: una peticion por tecla llenaria el journal. */
    pintarCarril();
    alParar('titulo', 600, function () {
      api('/api/recetas/' + r.id, json('PATCH', { titulo: t })).catch(falloAlGuardar);
    });
  };

  $('descripcion').oninput = function () {
    var r = laAbierta();
    if (!r) return;
    r.descripcion = $('descripcion').value;
    alParar('descripcion', 600, function () {
      api('/api/recetas/' + r.id, json('PATCH', { descripcion: r.descripcion })).catch(falloAlGuardar);
    });
  };

  $('notas').oninput = function () {
    var r = laAbierta();
    if (!r) return;
    r.notas = $('notas').value;
    ajustarNotas();
    alParar('notas', 800, function () {
      api('/api/recetas/' + r.id, json('PATCH', { notas: r.notas })).catch(falloAlGuardar);
    });
  };

  /* Las notas crecen con lo escrito. Se toca la altura por CSSOM y no con un
     atributo style en el HTML: la CSP de este sitio no admite lo segundo. */
  function ajustarNotas() {
    var t = $('notas');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight + 2, 600) + 'px';
  }

  $('apartado').onchange = function () {
    var r = laAbierta();
    if (r) guardarCampos(r, { apartado: $('apartado').value });
  };

  $('dificultad').onchange = function () {
    var r = laAbierta();
    if (r) guardarCampos(r, { dificultad: $('dificultad').value });
  };

  $('tiempo').onchange = function () {
    var r = laAbierta();
    if (!r) return;
    var v = $('tiempo').value;
    guardarCampos(r, { tiempo: v === '' ? null : Number(v) }, true);
  };

  $('raciones').onchange = function () {
    var r = laAbierta();
    if (!r) return;
    var n = Math.round(Number($('raciones').value));
    if (!isFinite(n) || n < 1 || n > 99) { $('raciones').value = r.raciones; return; }
    /* Cambiar las raciones de la receta NO reescribe las cantidades: dice para
       cuantos esta escrita. Si el escalador estaba en otro numero se queda
       donde estaba, que es justo lo que se suele querer al corregir la ficha.
       Lo que si hay que repintar es el escalador, que compara con esto. */
    r.raciones = n;
    guardarCampos(r, { raciones: n }, true);
    pintarEscalador(r);
    pintarIngredientes(r);
  };

  $('favorita').onclick = function () {
    var r = laAbierta();
    if (r) guardarCampos(r, { favorita: !r.favorita });
  };

  $('duplicar').onclick = async function () {
    var r = laAbierta();
    if (!r) return;
    try {
      var d = await api('/api/recetas/' + r.id + '/duplicar', json('POST', {}));
      datos.recetas.splice(datos.recetas.indexOf(r) + 1, 0, d.receta);
      abrir(d.receta.id);
      recado('Duplicada. Cámbiale el nombre y lo que haga falta.');
      $('titulo-receta').select();
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  /*
   * Borrar.
   *
   * Con confirm() y no con un deshacer, al contrario que en l-list: una receta
   * son veinte lineas escritas a mano y no una tarea que se vuelve a teclear en
   * tres segundos. El confirm es del navegador a proposito —bloquea de verdad—
   * y aqui esa interrupcion es lo que se busca.
   */
  $('borrar-receta').onclick = async function () {
    var r = laAbierta();
    if (!r) return;
    if (!window.confirm('¿Borrar «' + r.titulo + '»? Esto no se puede deshacer.')) return;
    try {
      await api('/api/recetas/' + r.id, { method: 'DELETE' });
      datos.recetas = datos.recetas.filter(function (x) { return x.id !== r.id; });
      abiertaId = null;
      pintar();
      recado('Receta borrada.');
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  $('cocinada').onclick = async function () {
    var r = laAbierta();
    if (!r) return;
    try {
      var d = await api('/api/recetas/' + r.id + '/cocinada', json('POST', {}));
      Object.assign(r, d.receta);
      pintarFicha(r);
      recado(r.veces === 1 ? '¡La primera vez! Queda apuntado.' : 'Apuntado: van ' + r.veces + '.');
    } catch (e) {
      recado(e.message, 'malo');
    }
  };

  /* ── El escalador ─────────────────────────────────────────────────────── */

  function escalar(n) {
    var r = laAbierta();
    if (!r) return;
    var cuantas = Math.max(1, Math.min(99, n));
    racionesVista = cuantas;
    pintarEscalador(r);
    pintarIngredientes(r);
  }

  $('menos-raciones').onclick = function () {
    var r = laAbierta();
    if (r) escalar(racionesDe(r) - 1);
  };
  $('mas-raciones').onclick = function () {
    var r = laAbierta();
    if (r) escalar(racionesDe(r) + 1);
  };
  $('volver-raciones').onclick = function () {
    var r = laAbierta();
    if (!r) return;
    racionesVista = null;
    pintarEscalador(r);
    pintarIngredientes(r);
  };

  /* ── Buscar y filtrar ─────────────────────────────────────────────────── */

  $('buscar').oninput = function () {
    busca = $('buscar').value;
    $('limpiar-busca').hidden = !busca;
    pintarCarril();
  };
  $('limpiar-busca').onclick = function () {
    busca = '';
    $('buscar').value = '';
    $('limpiar-busca').hidden = true;
    pintarCarril();
    $('buscar').focus();
  };

  /* ── Modo cocina ──────────────────────────────────────────────────────── */

  /*
   * La pantalla encendida mientras se cocina.
   *
   * Wake Lock no esta en todos los navegadores y no pasa nada: sin el, el modo
   * cocina sigue siendo util —texto grande, sin estorbos— y la pantalla se
   * apagara cuando le toque. Por eso va en un try y su fallo no se cuenta: no
   * hay nada que el usuario pueda hacer al respecto.
   */
  async function pedirCandado() {
    try {
      if ('wakeLock' in navigator) candado = await navigator.wakeLock.request('screen');
    } catch (_) { candado = null; }
  }

  function soltarCandado() {
    if (candado) { try { candado.release(); } catch (_) { /* ya estaba */ } }
    candado = null;
  }

  /* El sistema suelta el candado al irse la pagina a segundo plano —mirar una
     receta en otra pestaña, contestar un mensaje— y no lo devuelve solo. */
  document.addEventListener('visibilitychange', function () {
    if (cocinando && document.visibilityState === 'visible' && !candado) pedirCandado();
  });

  function pintarCocina(r) {
    if (!cocinando || !r) return;
    $('cocina-titulo').textContent = r.titulo;
    var hechos = r.pasos.filter(function (p) { return marcados.has(p.id); }).length;
    $('cocina-progreso').textContent = r.pasos.length
      ? hechos + ' de ' + r.pasos.length + ' pasos'
      : '';
  }

  function verCocina(si) {
    var r = laAbierta();
    if (si && !r) return;
    cocinando = si;
    document.body.classList.toggle('cocinando', si);
    $('cocina-barra').hidden = !si;
    if (si) {
      /* Al entrar se sueltan las marcas: se entra en modo cocina para empezar a
         cocinar, no para seguir donde lo dejo la ultima consulta. */
      marcados.clear();
      pintarTablero();
      pedirCandado();
      $('tablero').scrollTop = 0;
    } else {
      soltarCandado();
      pintarTablero();
    }
  }

  $('modo-cocina').onclick = function () { verCocina(true); };
  $('salir-cocina').onclick = function () { verCocina(false); };

  /* ── El carril en estrecho ────────────────────────────────────────────── */

  function verCarril(si) {
    $('carril').classList.toggle('abierto', si);
    $('carril-velo').hidden = !si;
    $('abrir-carril').setAttribute('aria-expanded', si ? 'true' : 'false');
  }
  $('abrir-carril').onclick = function () { verCarril(!$('carril').classList.contains('abierto')); };
  $('volver-carril').onclick = function () { verCarril(true); };
  $('carril-velo').onclick = function () { verCarril(false); };

  /* ── El menú del avatar y el tema ─────────────────────────────────────── */

  var botonMenu = $('boton-menu');
  var menu = $('menu-usuario');

  function verMenu(si) {
    menu.hidden = !si;
    botonMenu.setAttribute('aria-expanded', si ? 'true' : 'false');
    if (!si) {
      $('submenu-temas').hidden = true;
      $('abrir-temas').setAttribute('aria-expanded', 'false');
    }
  }
  botonMenu.onclick = function (ev) { ev.stopPropagation(); verMenu(menu.hidden); };
  document.addEventListener('click', function (ev) {
    if (!menu.hidden && !menu.contains(ev.target) && ev.target !== botonMenu) verMenu(false);
  });

  $('abrir-temas').onclick = function () {
    var abierto = $('submenu-temas').hidden;
    $('submenu-temas').hidden = !abierto;
    $('abrir-temas').setAttribute('aria-expanded', abierto ? 'true' : 'false');
  };

  function marcarTema(cual) {
    document.documentElement.setAttribute('data-tema', cual);
    /* El oscuro es el de por defecto y va SIN atributo: con el puesto, una
       regla escrita para :root sin atributo dejaria de aplicarse. */
    if (cual === 'oscuro') document.documentElement.removeAttribute('data-tema');

    Array.prototype.forEach.call(document.querySelectorAll('.menu-tema'), function (b) {
      b.setAttribute('aria-checked', b.dataset.tema === cual ? 'true' : 'false');
    });
    $('tema-actual').className = 'tema-muestra tema-mini ' + cual;
  }

  Array.prototype.forEach.call(document.querySelectorAll('.menu-tema'), function (b) {
    b.onclick = async function () {
      var antes = document.documentElement.getAttribute('data-tema') || 'oscuro';
      marcarTema(b.dataset.tema);
      try {
        await api('/api/tema', json('POST', { tema: b.dataset.tema }));
      } catch (e) {
        marcarTema(antes);
        recado(e.message, 'malo');
      }
    };
  });

  /* ── El avatar ────────────────────────────────────────────────────────── */

  /*
   * Las iniciales primero y la foto encima, si llega.
   *
   * El portal contesta 404 a /perfil/foto de quien no tenga una puesta, asi que
   * poner el src en el HTML dejaba el icono de imagen rota en la barra a todo
   * el que no hubiera subido foto. Aqui se enganchan load y error ANTES de
   * asignar el src, que es lo unico que garantiza no perderse el evento si la
   * imagen ya estaba en la cache y responde al instante.
   */
  function ponerAvatar(nombre) {
    var iniciales = String(nombre || '?')
      .trim().split(/\s+/).slice(0, 2)
      .map(function (p) { return p.charAt(0); })
      .join('') || '?';
    $('avatar-iniciales').textContent = iniciales;

    var img = $('avatar');
    img.addEventListener('load', function () {
      /* naturalWidth a 0 es una respuesta que no era una imagen: el 404 del
         portal devuelve HTML, y en algunos navegadores eso dispara load. */
      if (!img.naturalWidth) return;
      img.hidden = false;
      $('avatar-iniciales').hidden = true;
    });
    img.addEventListener('error', function () { img.hidden = true; });
    img.src = 'https://lepayimio.es/perfil/foto';
  }

  /* ── Teclado ──────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') {
      if (!menu.hidden) return verMenu(false);
      if (cocinando) return verCocina(false);
      if ($('carril').classList.contains('abierto')) return verCarril(false);
      return;
    }
    /* Barra inclinada para buscar, como en media web. Solo si no se esta
       escribiendo en algun sitio, que si no se come la tecla. */
    if (ev.key === '/' && !cocinando) {
      var d = document.activeElement;
      var escribiendo = d && (d.isContentEditable || d.tagName === 'INPUT' || d.tagName === 'TEXTAREA' || d.tagName === 'SELECT');
      if (!escribiendo) {
        ev.preventDefault();
        verCarril(true);
        $('buscar').focus();
      }
    }
  });

  /* ── Arranque ─────────────────────────────────────────────────────────── */

  (async function () {
    try {
      var d = await api('/api/estado');
      datos.recetas = d.recetas || [];
      datos.apartados = d.apartados || [];
      datos.dificultades = d.dificultades || [];
      $('menu-nombre').textContent = d.yo.nombre;
      ponerAvatar(d.yo.nombre);
      marcarTema(d.tema);
      /* Se abre la primera de partida: con una sola receta —que es el caso del
         primer dia— un tablero vacio pidiendo que elijas entre una opcion es
         una pantalla de mas. */
      var lista = visibles();
      if (lista.length) abiertaId = lista[0].id;
      pintar();
    } catch (e) {
      recado(e.message, 'malo');
      pintar();
    }
  })();
})();
