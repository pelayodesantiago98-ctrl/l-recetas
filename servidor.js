'use strict';
/*
 * Recetas — el recetario de casa, para lepayimio.es.
 *
 * QUE ES: lo que l-list es a las cosas que se tachan, esto es a las que se
 * cocinan. Nacio de que las recetas acababan repartidas entre capturas del
 * movil, notas del vault y la memoria, que es el peor de los tres sitios: una
 * receta hay que poder abrirla con las manos sucias y leerla de un vistazo,
 * no buscarla.
 *
 * ── Donde se guarda ────────────────────────────────────────────────────────
 *
 * Un JSON por usuario en datos/, con TODO lo suyo dentro. Mismo trato que
 * l-list y por los mismos motivos: son unas decenas de recetas por persona, se
 * lee entero en cada peticion sin que se note, el respaldo es copiar una
 * carpeta y el arreglo de urgencia es abrirlo con un editor.
 *
 * Cada escritura va a un temporal y luego se renombra. El rename es atomico
 * dentro del mismo sistema de ficheros, asi que un corte a media escritura
 * deja el fichero anterior entero en vez de uno a medias. Sin eso, un fallo
 * mientras se añade un paso se lleva el recetario.
 *
 * ── Las cantidades se guardan partidas ─────────────────────────────────────
 *
 * Un ingrediente se escribe como se dice —«200 g de harina»— pero se guarda
 * en tres piezas: cantidad, unidad y resto. Eso es lo que permite pedir la
 * receta para seis y que las cantidades suban solas, que es la mitad de la
 * gracia de tener el recetario aqui y no en una foto.
 *
 * Se parte AQUI y no en el navegador a proposito: asi la receta ya esta
 * partida en el fichero y no depende de que quien la lea sepa interpretarla.
 * Lo que no se entienda se guarda como texto y no se escala — nunca se
 * inventa un numero.
 *
 * ── Quien entra ────────────────────────────────────────────────────────────
 *
 * El SSO del portal, como los demas. Cada recetario es de quien lo escribe y
 * no hay ni una ruta que lea el fichero de otro. Lo unico que identifica es el
 * `id` del token, nunca el nombre, que su dueño puede cambiar cuando quiera.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const sso = require('/usr/local/lib/lepayimio/sso');
const temas = require('/usr/local/lib/lepayimio/tema');

const app = express();
const PUERTO = Number(process.env.PUERTO || 3013);
const DATOS = path.join(__dirname, 'datos');
const FOTOS = path.join(DATOS, 'fotos');

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const exige = sso.exigirSesion({ esApi: (req) => req.path.startsWith('/api/') });

/* El tema elegido, por usuario y en el servidor, igual que en el resto de la
   casa: asi sigue al usuario del movil al ordenador. */
const tema = temas.crear(
  path.join(DATOS, 'temas.json'),
  ['oscuro', 'crystal', 'dark-crystal'],
  'oscuro'
);

// ── Vocabulario ──────────────────────────────────────────────────────────────

/*
 * Dos apartados, y las etiquetas libres.
 *
 * Comidas y Postres, y ya. Lo intente primero con once categorias —entrantes,
 * primeros, salsas...— y era una taxonomia de libro de cocina, no de una casa:
 * obligaba a decidir si una empanada es un entrante o un primero para poder
 * guardarla. Un postre si es otra cosa (se busca en otro momento y con otra
 * cabeza), y ahi si hay una linea que todo el mundo sabe trazar.
 *
 * Todo lo demas —«fitness», «pollo», «oreo», «proteina»— son ETIQUETAS: van
 * varias en la misma receta, se inventan sobre la marcha y son con lo que se
 * busca de verdad. Una lista cerrada de pistas siempre se queda corta; un
 * apartado con dos opciones, no.
 */
const APARTADOS = ['Comidas', 'Postres'];

const DIFICULTADES = ['facil', 'media', 'dificil'];

/*
 * Unidades que se reconocen al partir un ingrediente.
 *
 * La clave es como se escribe y el valor es la forma con la que se vuelve a
 * pintar, para que «Kg», «kgs» y «kg» acaben siendo lo mismo. Las que no estan
 * aqui no son un error: «2 pimientos rojos» no lleva unidad, y se guarda con
 * cantidad 2 y sin unidad, que escala igual de bien.
 */
const UNIDADES = {
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
  mg: 'mg',
  l: 'l', litro: 'l', litros: 'l',
  dl: 'dl', cl: 'cl', ml: 'ml',
  cucharada: 'cucharadas', cucharadas: 'cucharadas', cda: 'cucharadas', cdas: 'cucharadas',
  cucharadita: 'cucharaditas', cucharaditas: 'cucharaditas', cdta: 'cucharaditas', cdtas: 'cucharaditas',
  taza: 'tazas', tazas: 'tazas',
  pizca: 'pizcas', pizcas: 'pizcas',
  diente: 'dientes', dientes: 'dientes',
  rama: 'ramas', ramas: 'ramas',
  hoja: 'hojas', hojas: 'hojas',
  lata: 'latas', latas: 'latas',
  sobre: 'sobres', sobres: 'sobres',
  puñado: 'puñados', puñados: 'puñados', punado: 'puñados', punados: 'puñados',
  vaso: 'vasos', vasos: 'vasos',
  loncha: 'lonchas', lonchas: 'lonchas',
  rodaja: 'rodajas', rodajas: 'rodajas',
  filete: 'filetes', filetes: 'filetes',
  ud: 'ud', uds: 'ud', unidad: 'ud', unidades: 'ud',
};

// ── Almacen ──────────────────────────────────────────────────────────────────

/*
 * El id del SSO convertido en nombre de fichero.
 *
 * Los ids de hoy son numeros o nombres cortos, pero de aqui sale una RUTA, y
 * una ruta armada con algo que viene de fuera es por donde se cuelan los
 * `../`. En vez de confiar en que el formato no cambie nunca, se troceja: lo
 * que no sea letra, digito, punto, guion o guion bajo se sustituye, y si
 * despues de eso no queda nada reconocible se usa un resumen del original.
 * Legible en el caso normal y seguro en todos. Copiado de l-list.
 */
function ficheroDe(id) {
  const limpio = String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  const nombre = /^[a-zA-Z0-9]/.test(limpio)
    ? limpio
    : 'u' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 16);
  return path.join(DATOS, nombre + '.json');
}

function leer(id) {
  let d = null;
  try {
    d = JSON.parse(fs.readFileSync(ficheroDe(id), 'utf8'));
  } catch {
    /* Sin fichero todavia, o roto: recetario vacio. No es un error, es el
       estado de quien entra por primera vez. */
    d = null;
  }
  if (!d || typeof d !== 'object') d = {};
  if (!Array.isArray(d.recetas)) d.recetas = [];
  /* Un fichero escrito por una version anterior —o a mano con un editor, que
     es medio motivo de guardar esto en JSON— puede traer un apartado que ya no
     existe. Se corrige al leer y no al arrancar: asi no hace falta una
     migracion que solo sirva una vez. */
  for (const r of d.recetas) {
    if (!APARTADOS.includes(r.apartado)) {
      r.apartado = (r.categoria === 'Postres' || r.apartado === 'Postres') ? 'Postres' : 'Comidas';
      delete r.categoria;
    }
  }
  return d;
}

function guardar(id, d) {
  const fichero = ficheroDe(id);
  fs.mkdirSync(DATOS, { recursive: true });
  const tmp = fichero + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, recetas: d.recetas }, null, 2) + '\n', { mode: 0o640 });
  fs.renameSync(tmp, fichero);
}

function nuevoId() {
  return crypto.randomBytes(8).toString('hex');
}

// ── Limpieza de lo que llega ─────────────────────────────────────────────────

/*
 * Texto de una linea.
 *
 * Los caracteres de control se sustituyen por un espacio en vez de borrarse:
 * pegar dos lineas de una web tiene que dar «harina y sal» y no «harinay sal».
 *
 * Aqui no se escapa nada: esto se guarda en JSON y se pinta con textContent,
 * asi que el < de «reducir a <100 ml» tiene que sobrevivir tal cual. El dia
 * que alguien lo pinte con innerHTML, el fallo estara alli.
 */
function texto(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/*
 * Texto de varias lineas, para las notas.
 *
 * Aqui los saltos SI se conservan —una nota es un parrafo, no un renglon— pero
 * se normalizan los retornos de Windows y se recortan las tandas de mas de dos
 * saltos seguidos, que es lo que llega al pegar de una web y deja media
 * pantalla en blanco.
 */
function parrafos(v, max) {
  return String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, max)
    .trim();
}

/*
 * Un numero de los que se escriben en una receta.
 *
 * Acepta «200», «1,5», «1.5», «1/2» y «1 1/2», porque las tres formas se usan
 * de verdad y obligar a una sola es obligar a traducir mientras se copia una
 * receta. Devuelve null si no hay nada que entender, que es distinto de cero:
 * «sal al gusto» no lleva cantidad, no lleva cantidad cero.
 */
function numero(t) {
  const s = String(t).replace(',', '.').trim();
  let m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(s);          // 1 1/2
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);                       // 1/2
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  m = /^(\d+(?:\.\d+)?)$/.exec(s);                          // 200 · 1.5
  if (m) return Number(m[1]);
  return null;
}

/*
 * Partir un ingrediente en cantidad, unidad y resto.
 *
 * El orden importa: primero se intenta leer un numero al principio, y solo si
 * hay numero se mira si la palabra siguiente es una unidad conocida. Al
 * contrario —buscar la unidad por su cuenta— «un diente de ajo» acabaria con
 * unidad «diente» y sin cantidad, que no sirve para escalar y encima cambia lo
 * que el usuario escribio.
 *
 * Lo que no encaje se guarda entero en `resto` con cantidad null. Eso NO es un
 * fallo: «aceite de oliva», «sal» y «pimienta al gusto» son ingredientes
 * perfectamente validos que no se multiplican por nada.
 */
function partirIngrediente(linea) {
  const t = texto(linea, 160);
  if (!t) return null;

  const m = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)\s*(.*)$/.exec(t);
  if (!m) return { id: nuevoId(), cantidad: null, unidad: '', resto: t };

  const cantidad = numero(m[1]);
  let resto = m[2].trim();
  let unidad = '';

  /* La unidad es la primera palabra de lo que queda, y solo si esta en la
     lista. «2 pimientos» deja unidad vacia y resto «pimientos», que es
     exactamente lo que hay que volver a escribir al pintarlo. */
  const p = /^([^\s.,;]+)\b\.?\s*(.*)$/.exec(resto);
  if (p) {
    const clave = p[1].toLowerCase().replace(/\.$/, '');
    if (Object.prototype.hasOwnProperty.call(UNIDADES, clave)) {
      unidad = UNIDADES[clave];
      resto = p[2].trim();
    }
  }

  if (cantidad === null) return { id: nuevoId(), cantidad: null, unidad: '', resto: t };
  return { id: nuevoId(), cantidad, unidad, resto };
}

/*
 * Las etiquetas: minusculas, sin repetidas y con tope.
 *
 * Minusculas porque «Rápido» y «rápido» son la misma pista escrita por dos
 * manos distintas, y dos chips iguales en una receta no significan nada.
 *
 * Y la comparacion va sin acentos, aunque lo que se guarda los lleve: quien
 * escribe «clasico» con el movil en una mano esta poniendo la misma etiqueta
 * que puso «clásico» ayer, y lo que no se puede es acabar con las dos.
 */
function etiquetas(v) {
  if (!Array.isArray(v)) return null;
  const vistas = [];
  const llanas = new Set();
  for (const e of v) {
    const t = texto(e, 30).toLowerCase();
    if (!t) continue;
    const llana = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (llanas.has(llana)) continue;
    llanas.add(llana);
    vistas.push(t);
    if (vistas.length >= 12) break;
  }
  return vistas;
}

function recetaNueva(titulo) {
  const ahora = new Date().toISOString();
  return {
    id: nuevoId(),
    titulo,
    descripcion: '',
    apartado: 'Comidas',
    etiquetas: [],
    raciones: 4,
    tiempo: 30,
    dificultad: 'media',
    ingredientes: [],
    pasos: [],
    notas: '',
    foto: null,
    favorita: false,
    veces: 0,
    ultimaVez: null,
    creada: ahora,
    editada: ahora,
  };
}

// ── API ──────────────────────────────────────────────────────────────────────

/* Todo de una vez. El recetario entero cabe en una respuesta —son decenas de
   recetas, no miles—, asi que pedirlo por trozos solo serviria para que la
   pantalla se dibujase a saltos y para tener que inventar paginacion. */
app.get('/api/estado', exige, (req, res) => {
  const d = leer(req.sesion.id);
  res.json({
    yo: { id: req.sesion.id, nombre: req.sesion.nombre },
    tema: tema.de(req.sesion.id),
    apartados: APARTADOS,
    dificultades: DIFICULTADES,
    recetas: d.recetas,
  });
});

app.post('/api/recetas', exige, (req, res) => {
  const titulo = texto((req.body || {}).titulo, 120);
  if (!titulo) return res.status(400).json({ error: 'La receta necesita un nombre.' });

  const d = leer(req.sesion.id);
  if (d.recetas.length >= 500) return res.status(400).json({ error: 'Quinientas recetas son muchas recetas.' });

  const receta = recetaNueva(titulo);
  d.recetas.push(receta);
  guardar(req.sesion.id, d);
  res.json({ receta });
});

/* La receta buscada, o null. Se usa en todas las rutas de abajo y devuelve la
   pareja receta+fichero para no leerlo dos veces. */
function conReceta(req, res, hacer) {
  const d = leer(req.sesion.id);
  const r = d.recetas.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Esa receta no existe.' });
  return hacer(d, r);
}

/*
 * Cambiar una receta. Solo los campos que lleguen.
 *
 * Un PATCH por campo y no un PUT de la receta entera: aqui se edita a la vez
 * que se lee —se corrige el tiempo mientras esta el arroz al fuego— y mandar
 * la receta completa en cada tecla pisaria lo que se acabe de escribir desde
 * el movil.
 */
app.patch('/api/recetas/:id', exige, (req, res) => conReceta(req, res, (d, r) => {
  const c = req.body || {};

  if (c.titulo !== undefined) {
    const t = texto(c.titulo, 120);
    if (!t) return res.status(400).json({ error: 'La receta necesita un nombre.' });
    r.titulo = t;
  }
  if (c.descripcion !== undefined) r.descripcion = texto(c.descripcion, 300);
  if (c.apartado !== undefined) {
    if (!APARTADOS.includes(String(c.apartado))) return res.status(400).json({ error: 'Ese apartado no existe.' });
    r.apartado = String(c.apartado);
  }
  if (c.dificultad !== undefined) {
    if (!DIFICULTADES.includes(String(c.dificultad))) return res.status(400).json({ error: 'Esa dificultad no existe.' });
    r.dificultad = String(c.dificultad);
  }
  if (c.raciones !== undefined) {
    const n = Math.round(Number(c.raciones));
    if (!Number.isFinite(n) || n < 1 || n > 99) return res.status(400).json({ error: 'Las raciones van de 1 a 99.' });
    r.raciones = n;
  }
  if (c.tiempo !== undefined) {
    /* El tiempo admite quedarse vacio: hay recetas que no lo tienen —un
       aliño— y poner un cero seria mentir con un numero. */
    if (c.tiempo === null || c.tiempo === '') r.tiempo = null;
    else {
      const n = Math.round(Number(c.tiempo));
      if (!Number.isFinite(n) || n < 0 || n > 6000) return res.status(400).json({ error: 'Ese tiempo no me cuadra.' });
      r.tiempo = n;
    }
  }
  if (c.etiquetas !== undefined) {
    const e = etiquetas(c.etiquetas);
    if (!e) return res.status(400).json({ error: 'Las etiquetas llegan mal.' });
    r.etiquetas = e;
  }
  if (c.notas !== undefined) r.notas = parrafos(c.notas, 4000);
  if (c.favorita !== undefined) r.favorita = !!c.favorita;

  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ receta: r });
}));

app.delete('/api/recetas/:id', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const antes = d.recetas.length;
  const borrada = d.recetas.find((x) => x.id === req.params.id);
  d.recetas = d.recetas.filter((x) => x.id !== req.params.id);
  if (d.recetas.length === antes) return res.status(404).json({ error: 'Esa receta no existe.' });
  /* Y sus fotos con ella —la de la receta y la de cada paso—: si no, el disco
     se va llenando de imagenes que ya nada vuelve a nombrar. */
  for (const id of [req.params.id].concat((borrada ? borrada.pasos : []).map((p) => p.id))) {
    const f = ficheroFoto(id);
    if (f) { try { fs.unlinkSync(f); } catch { /* no tenia */ } }
  }
  guardar(req.sesion.id, d);
  res.json({ ok: true });
});

/*
 * Duplicar.
 *
 * Para la variante: la misma receta con pollo en vez de con cerdo. Se copia
 * todo menos lo que no es de la receta sino de su historia —las veces que se
 * ha hecho y cuando fue la ultima—, que empiezan de cero porque esta version
 * no se ha cocinado todavia.
 *
 * Los ids de ingredientes y pasos se renuevan: si se copiaran, editar un paso
 * de la copia tocaria el de la original, que comparten id.
 */
app.post('/api/recetas/:id/duplicar', exige, (req, res) => conReceta(req, res, (d, r) => {
  if (d.recetas.length >= 500) return res.status(400).json({ error: 'Quinientas recetas son muchas recetas.' });

  const ahora = new Date().toISOString();
  const copia = {
    ...r,
    id: nuevoId(),
    titulo: texto(r.titulo + ' (copia)', 120),
    ingredientes: r.ingredientes.map((i) => ({ ...i, id: nuevoId() })),
    pasos: r.pasos.map((p) => ({ ...p, id: nuevoId(), foto: null })),
    etiquetas: r.etiquetas.slice(),
    favorita: false,
    veces: 0,
    ultimaVez: null,
    creada: ahora,
    editada: ahora,
  };
  /* La foto se copia de verdad, no se comparte el fichero: son dos recetas, y
     cambiarle la foto a una no puede cambiarsela a la otra. */
  if (r.foto) {
    try {
      fs.copyFileSync(ficheroFoto(r.id), ficheroFoto(copia.id));
      copia.foto = Date.now();
    } catch { copia.foto = null; }
  }
  /* Y las de los pasos, cada una a su id nuevo. */
  r.pasos.forEach((p, i) => {
    if (!p.foto) return;
    try {
      fs.copyFileSync(ficheroFoto(p.id), ficheroFoto(copia.pasos[i].id));
      copia.pasos[i].foto = Date.now();
    } catch { copia.pasos[i].foto = null; }
  });

  /* Justo detras de la original y no al final: se acaba de duplicar, se va a
     editar ahora, y buscarla en la Z del carril no tiene ningun sentido. */
  d.recetas.splice(d.recetas.indexOf(r) + 1, 0, copia);
  guardar(req.sesion.id, d);
  res.json({ receta: copia });
}));

/*
 * «La he hecho».
 *
 * Un contador y una fecha. Es el unico dato de esta casa que no se escribe a
 * mano y el que contesta a la pregunta que de verdad se hace delante del
 * recetario: no «que recetas tengo», sino «que hicimos el mes pasado que
 * saliera bien».
 */
app.post('/api/recetas/:id/cocinada', exige, (req, res) => conReceta(req, res, (d, r) => {
  r.veces = Number(r.veces || 0) + 1;
  r.ultimaVez = new Date().toISOString();
  /* `editada` no se toca: cocinarla no es editarla, y si contara como edicion
     el orden por «lo ultimo que toque» se llenaria de recetas que no han
     cambiado. */
  guardar(req.sesion.id, d);
  res.json({ receta: r });
}));

// ── Ingredientes y pasos ─────────────────────────────────────────────────────

app.post('/api/recetas/:id/ingredientes', exige, (req, res) => conReceta(req, res, (d, r) => {
  if (r.ingredientes.length >= 100) return res.status(400).json({ error: 'Cien ingredientes son demasiados.' });
  const i = partirIngrediente((req.body || {}).texto);
  if (!i) return res.status(400).json({ error: 'El ingrediente está vacío.' });

  r.ingredientes.push(i);
  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ ingrediente: i });
}));

/*
 * Cambiar un ingrediente o un paso.
 *
 * Se buscan por todas las recetas y no se pide la receta en la ruta: el id ya
 * es unico dentro del fichero del usuario, y pedir las dos cosas solo abre la
 * puerta a que lleguen descuadradas. Igual que las tareas de l-list.
 */
function buscarEn(d, campo, id) {
  for (const r of d.recetas) {
    const x = r[campo].find((y) => y.id === id);
    if (x) return { receta: r, item: x };
  }
  return null;
}

app.patch('/api/ingredientes/:id', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'ingredientes', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese ingrediente no existe.' });

  const nuevo = partirIngrediente((req.body || {}).texto);
  if (!nuevo) return res.status(400).json({ error: 'El ingrediente está vacío.' });

  /* Se vuelve a partir de cero pero conservando el id: la linea puede pasar de
     «harina» a «200 g de harina», y eso cambia cantidad y unidad. Lo que no
     puede cambiar es quien es, o el navegador perderia la fila que acaba de
     editar. */
  Object.assign(hallado.item, nuevo, { id: hallado.item.id });
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ ingrediente: hallado.item });
});

app.delete('/api/ingredientes/:id', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'ingredientes', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese ingrediente no existe.' });

  hallado.receta.ingredientes = hallado.receta.ingredientes.filter((x) => x.id !== req.params.id);
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ ok: true });
});

app.post('/api/recetas/:id/pasos', exige, (req, res) => conReceta(req, res, (d, r) => {
  if (r.pasos.length >= 100) return res.status(400).json({ error: 'Cien pasos son demasiados.' });
  const t = texto((req.body || {}).texto, 1000);
  if (!t) return res.status(400).json({ error: 'El paso está vacío.' });

  const paso = { id: nuevoId(), texto: t, foto: null };
  r.pasos.push(paso);
  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ paso });
}));

app.patch('/api/pasos/:id', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'pasos', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese paso no existe.' });

  const t = texto((req.body || {}).texto, 1000);
  if (!t) return res.status(400).json({ error: 'El paso está vacío.' });
  hallado.item.texto = t;
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ paso: hallado.item });
});

app.delete('/api/pasos/:id', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'pasos', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese paso no existe.' });

  hallado.receta.pasos = hallado.receta.pasos.filter((x) => x.id !== req.params.id);
  /* Y su foto, que si no se queda en el disco sin que nada vuelva a nombrarla. */
  if (hallado.item.foto) {
    const f = ficheroFoto(hallado.item.id);
    if (f) { try { fs.unlinkSync(f); } catch { /* no estaba */ } }
  }
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ ok: true });
});

/*
 * Reordenar ingredientes o pasos.
 *
 * En una receta el orden ES informacion: los pasos van en el orden en el que
 * se hacen y los ingredientes en el que se usan. Por eso hay una ruta para
 * esto y no se resuelve borrando y volviendo a escribir.
 *
 * Lo que el navegador no nombre se queda al final en el orden que tenia: una
 * pestaña con la receta vieja abierta no puede borrar un paso añadido desde
 * otra solo por mandar una lista incompleta. Misma regla que el orden de las
 * listas en l-list.
 */
app.post('/api/recetas/:id/orden', exige, (req, res) => conReceta(req, res, (d, r) => {
  const cuerpo = req.body || {};
  const campo = cuerpo.que === 'ingredientes' ? 'ingredientes' : cuerpo.que === 'pasos' ? 'pasos' : null;
  if (!campo) return res.status(400).json({ error: 'No sé qué hay que ordenar.' });
  if (!Array.isArray(cuerpo.ids)) return res.status(400).json({ error: 'Falta el orden.' });

  const porId = new Map(r[campo].map((x) => [x.id, x]));
  const nuevos = [];
  for (const id of cuerpo.ids.map(String)) {
    const x = porId.get(id);
    if (x) { nuevos.push(x); porId.delete(id); }
  }
  for (const x of porId.values()) nuevos.push(x);

  r[campo] = nuevos;
  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ ok: true, [campo]: nuevos });
}));

/* ── La foto ─────────────────────────────────────────────────────────────── */

/*
 * Sube por PUT con el cuerpo crudo, no como formulario multipart.
 *
 * Es lo mismo que hace el buzon de peliculas, y por un motivo parecido: con el
 * cuerpo crudo el fichero es el cuerpo y ya esta, sin separadores que analizar
 * ni una dependencia mas para leerlos. Aqui ademas llega ya reducida —el
 * navegador la pasa por un canvas antes de mandarla— asi que lo que sube es un
 * JPEG de un par de cientos de kilobytes y no los ocho megas que hace un movil.
 *
 * El limite de 4 MB es el cinturon por si alguien manda la foto sin reducir:
 * express corta la peticion por su cuenta al pasarse, sin llegar al disco.
 */
const cuerpoDeImagen = express.raw({ type: ['image/jpeg', 'image/webp', 'image/png'], limit: '4mb' });

function ficheroFoto(idReceta) {
  /* El id lo genera esta casa (16 hex) pero viene por la URL, asi que se
     comprueba en vez de confiar: de aqui sale una ruta. */
  if (!/^[a-f0-9]{16}$/.test(String(idReceta))) return null;
  return path.join(FOTOS, idReceta + '.jpg');
}

/*
 * Lo que dicen los primeros bytes, que es mas de fiar que la cabecera
 * Content-Type: esa la escribe quien sube. Si no es una imagen de las tres que
 * se aceptan, no se guarda nada.
 */
function formatoDe(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

app.put('/api/recetas/:id/foto', exige, cuerpoDeImagen, (req, res) => conReceta(req, res, (d, r) => {
  const fichero = ficheroFoto(r.id);
  if (!fichero) return res.status(400).json({ error: 'Esa receta no existe.' });
  if (!formatoDe(req.body)) return res.status(400).json({ error: 'Eso no es una imagen que yo sepa leer.' });

  fs.mkdirSync(FOTOS, { recursive: true });
  /* Temporal y rename, como el JSON: si se corta a medias, la foto de antes
     sigue entera en vez de quedarse una imagen truncada. */
  const tmp = fichero + '.tmp';
  fs.writeFileSync(tmp, req.body, { mode: 0o640 });
  fs.renameSync(tmp, fichero);

  /* Se guarda CUANDO se subio, no un simple true: es lo que va en la direccion
     de la imagen y lo que hace que el navegador se baje la nueva en vez de
     seguir enseñando la vieja de su cache. */
  r.foto = Date.now();
  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ receta: r });
}));

/*
 * La foto de un paso.
 *
 * Una receta sacada de un video se entiende mucho mejor con la imagen de como
 * queda cada paso que con el parrafo solo — «doblar las tiras alternando» se
 * lee tres veces y se ve una. Van en el mismo sitio y con el mismo trato que
 * la foto de la receta: fichero con el id del paso, temporal y rename.
 */
app.put('/api/pasos/:id/foto', exige, cuerpoDeImagen, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'pasos', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese paso no existe.' });

  const fichero = ficheroFoto(hallado.item.id);
  if (!fichero) return res.status(400).json({ error: 'Ese paso no existe.' });
  if (!formatoDe(req.body)) return res.status(400).json({ error: 'Eso no es una imagen que yo sepa leer.' });

  fs.mkdirSync(FOTOS, { recursive: true });
  const tmp = fichero + '.tmp';
  fs.writeFileSync(tmp, req.body, { mode: 0o640 });
  fs.renameSync(tmp, fichero);

  hallado.item.foto = Date.now();
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ paso: hallado.item });
});

app.delete('/api/pasos/:id/foto', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hallado = buscarEn(d, 'pasos', req.params.id);
  if (!hallado) return res.status(404).json({ error: 'Ese paso no existe.' });

  const fichero = ficheroFoto(hallado.item.id);
  if (fichero) { try { fs.unlinkSync(fichero); } catch { /* ya no estaba */ } }
  hallado.item.foto = null;
  hallado.receta.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ paso: hallado.item });
});

app.delete('/api/recetas/:id/foto', exige, (req, res) => conReceta(req, res, (d, r) => {
  const fichero = ficheroFoto(r.id);
  if (fichero) { try { fs.unlinkSync(fichero); } catch { /* ya no estaba */ } }
  r.foto = null;
  r.editada = new Date().toISOString();
  guardar(req.sesion.id, d);
  res.json({ receta: r });
}));

/*
 * Servir una foto: la de una receta o la de uno de sus pasos.
 *
 * No vale con que el fichero exista: se comprueba que lo que pide sea de quien
 * pregunta. Los ids son aleatorios, pero «dificil de adivinar» no es un permiso
 * — el permiso es que este en TU fichero.
 *
 * Va con max-age privado y largo porque la direccion lleva la marca de tiempo
 * de la subida: cambiar la foto cambia la direccion, asi que la cache nunca se
 * queda con una imagen vieja.
 */
app.get('/fotos/:nombre', exige, (req, res) => {
  /* El nombre entero y no un :id con «.jpg» pegado detras en la ruta: como se
     escribe ahi el punto cambia entre versiones de Express, y esto se lee
     igual en todas. */
  const id = String(req.params.nombre).replace(/\.jpg$/, '');
  const d = leer(req.sesion.id);
  /* El mismo id puede ser de una receta o de un paso: los dos guardan su foto
     con su propio id, y los dos son suyos o no lo son. */
  const suyo = d.recetas.some((x) => x.id === id || x.pasos.some((p) => p.id === id));
  const fichero = suyo ? ficheroFoto(id) : null;
  if (!fichero || !fs.existsSync(fichero)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('image/jpeg').send(fs.readFileSync(fichero));
});

/*
 * El recetario entero, para guardarlo fuera.
 *
 * Aqui no hay base de datos que exportar ni un boton de respaldo en ningun
 * sitio, asi que esto es lo que separa «mis recetas» de «mis recetas mientras
 * el VPS siga en pie». Sale con Content-Disposition para que el navegador lo
 * baje en vez de pintarlo.
 */
app.get('/api/exportar', exige, (req, res) => {
  const d = leer(req.sesion.id);
  const hoy = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', 'attachment; filename="recetas-' + hoy + '.json"');
  res.set('Cache-Control', 'no-store');
  res.type('application/json').send(JSON.stringify({ v: 1, recetas: d.recetas }, null, 2) + '\n');
});

app.post('/api/tema', exige, (req, res) => {
  const cual = String((req.body || {}).tema || '');
  if (!tema.poner(req.sesion.id, cual)) return res.status(400).json({ error: 'Ese tema no existe.' });
  res.json({ ok: true, tema: cual });
});

/*
 * Cerrar sesion. Se hace aqui y no contra el /salir del portal porque su nginx
 * corta con 403 las peticiones que llegan de otro origen, y este subdominio lo
 * es. La galleta es del dominio padre, asi que desde aqui se puede borrar: hay
 * que repetir dominio y ruta o el navegador no la da por la misma.
 *
 * Copiado tal cual de l-list y l-gym. Si algun dia hay que tocarlo, hay que
 * tocarlo en los tres sitios.
 */
app.post('/salir', (req, res) => {
  res.clearCookie(sso.COOKIE, {
    httpOnly: true, secure: true, sameSite: 'lax', domain: '.lepayimio.es', path: '/',
  });
  res.redirect(sso.LOGIN);
});

// ── Pantalla ─────────────────────────────────────────────────────────────────

/* El index se sirve a mano y no como estatico para poder marcar el tema en el
   <html> antes de mandarlo. Dejarselo al navegador obliga a pintar el tema por
   defecto y corregirlo despues, y ese fogonazo se ve en cada carga. */
app.get('/', exige, (req, res) => {
  const suTema = tema.de(req.sesion.id);
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  if (suTema !== 'oscuro') html = html.replace('<html lang=es>', `<html lang=es data-tema="${suTema}">`);
  res.type('html').set('Cache-Control', 'no-store').send(html);
});

app.use('/', express.static(path.join(__dirname, 'public'), { index: false }));

/* Manejador propio: sin el, el de serie de Express mete el stack trace en la
   respuesta que ve el cliente cuando NODE_ENV no es production. */
app.use((err, req, res, siguiente) => {
  console.error('Fallo sin recoger:', err && err.stack ? err.stack : err);
  if (res.headersSent) return siguiente(err);
  res.status(500).json({ error: 'Algo se ha roto por aquí dentro.' });
});

/* La clave del SSO se comprueba al arrancar y no en la primera peticion. Sin
   ella esto valida todas las sesiones como invalidas y manda a todo el mundo
   al login, en silencio y pareciendo un problema del portal. Mejor no arrancar
   y que se vea en el journal. */
try {
  fs.readFileSync(process.env.SSO_KEY_FILE || '/etc/lepayimio/sso.key');
} catch (e) {
  console.error('No puedo leer la clave del SSO:', e.message);
  process.exit(1);
}

fs.mkdirSync(DATOS, { recursive: true });
fs.mkdirSync(FOTOS, { recursive: true });
app.listen(PUERTO, '127.0.0.1', () => {
  console.log('Recetas escuchando en http://127.0.0.1:' + PUERTO);
});
