# Recetas (`l-recetas`)

El recetario de casa para `lepayimio.es`. Node + Express, sin dependencias más
allá de Express y sin compilación, como el resto de la casa.

Vive en `l-recetas.lepayimio.es`, detrás del mismo nginx y con la sesión
compartida del portal (`/usr/local/lib/lepayimio/sso.js`).

## Qué hace

- Un recetario por usuario, partido en **dos apartados: Comidas y Postres**.
  Dos y no once categorías a propósito: una lista larga obliga a decidir si una
  empanada es entrante o primero para poder guardarla, y un postre sí es otra
  cosa de verdad —se busca en otro momento y con otra cabeza—.
- **Etiquetas libres** («fitness», «pollo», «oreo», «proteína», «tarta de
  queso»…) y **filtro por ellas en el carril**: cada etiqueta que existe se
  convierte sola en un chip, y pulsando varias se exigen todas a la vez
  («fitness» + «pollo» da lo que es las dos cosas, no la suma).
- **Una foto por receta.** Sube por PUT con el cuerpo crudo, como el buzón de
  películas. El navegador la reduce antes con un canvas (1600 px, JPEG 0,82):
  de ocho megas del móvil a un par de cientos de kilobytes, sin metadatos —ni
  la posición donde se hizo la foto— y convertida a JPEG aunque llegue en HEIC.
  En el carril se ve como miniatura.
- Cada receta lleva además: de qué va, tiempo, dificultad, raciones,
  ingredientes, pasos y notas.
- **Escalador de raciones.** Los ingredientes se guardan partidos en cantidad,
  unidad y resto, así que pedir la receta para seis sube las cantidades solas.
  Lo que no se entiende como cantidad —«sal al gusto»— se queda como está: no
  se inventa un número.
- **Modo cocina.** La misma pantalla con los estorbos apagados: texto grande,
  sin carril ni campos de edición, ingredientes y pasos que se marcan a toque y
  la pantalla del móvil sin apagarse (Wake Lock, cuando el navegador lo tiene).
- Buscador que mira también **dentro de los ingredientes**, que es la pregunta
  que se hace de verdad delante de la nevera.
- Contador de veces cocinada y fecha de la última.
- Descargar el recetario entero en un JSON desde el menú del avatar.

Las marcas de «ya lo tengo» y «este paso está hecho» **no se guardan**: son de
esta vez que se cocina, no de la receta. Las raciones del escalador tampoco: la
receta está escrita para las que dice su ficha.

## Dónde se guarda

Un JSON por usuario en `datos/`, con todo lo suyo dentro, y las fotos en
`datos/fotos/<id de receta>.jpg`. Servir una foto no se conforma con que el
fichero exista: comprueba que esa receta esté en el fichero de quien pregunta,
porque «id difícil de adivinar» no es un permiso. Mismo trato que
l-list y por los mismos motivos: son decenas de recetas, se lee entero en cada
petición sin que se note, el respaldo es copiar una carpeta y el arreglo de
urgencia es abrirlo con un editor. Cada escritura va a un temporal y se
renombra, que es atómico: un corte a media escritura deja el fichero anterior
entero.

`datos/temas.json` guarda el tema elegido por usuario, como en los demás
servicios.

Un apartado desconocido —de una versión anterior o de un fichero editado a
mano— se corrige al leer, no con una migración que solo serviría una vez.

## Puesta en marcha

```bash
npm install
PUERTO=3013 node servidor.js
```

En el VPS corre como `www-data` bajo `l-recetas.service`, escuchando solo en
`127.0.0.1:3013`. El servicio **no arranca** si no puede leer
`/etc/lepayimio/sso.key`: sin esa clave validaría todas las sesiones como
inválidas y mandaría a todo el mundo al login, en silencio y pareciendo un
problema del portal.

## La capa de acabado

`public/mejoras.css` es el puente (las diez líneas de arriba, que traducen las
variables de esta casa a `--m-*`) más el núcleo común, idéntico byte a byte en
todos los servicios que lo llevan. Si hay que arreglar algo del núcleo, se
arregla una vez y se copia a todos.

`public/linesidebar.js` es el mismo componente de l-list y l-notes, con un
cambio retrocompatible: el contenedor puede pedir `data-indice="no"` para que
no numere las filas. Aquí el carril va partido en dos apartados y una
numeración corrida entre ellos no ordena nada; sin el atributo, como en l-list,
se numera igual que siempre.

La CSP de este sitio **no lleva `unsafe-inline` en `style-src` ni en
`script-src`**: aquí no vale ni un atributo `style=` ni una etiqueta `<style>`,
solo ficheros y CSSOM (`elemento.style.x = …`, que sí está permitido y es como
crecen las notas).
