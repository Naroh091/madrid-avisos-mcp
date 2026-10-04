---
name: madrid-avisos
description: "Crea avisos al Ayto. de Madrid desde una foto"
version: 1.1.0
platforms: [linux, macos]
metadata:
  hermes:
    tags: [madrid, avisos, ayuntamiento, incidencias, limpieza, mcp]
    category: civic
---

# Avisos Madrid — incidencias desde una foto

Servidor MCP `madrid-avisos` (11 tools, prefijo `mcp__madrid_avisos__`). Actúas como el
dueño del token configurado en el servidor: todo aviso que crees es REAL y lo
revisa personal municipal. **Solo incidencias genuinas. Nada de pruebas.**

## When to Use

Cuando el humano te pasa una foto de una incidencia urbana en Madrid (basura, farolas,
aceras…) y te pide generar un aviso al Ayuntamiento. Para esta tarea usa SOLO:
inspección de la imagen + las tools `mcp__madrid_avisos__*` + redimensionar la foto si
hace falta. NO explores la máquina (nada de `~/.ssh`, historiales shell, ficheros de
config): no sirve para crear el aviso.

## Procedure

### 0. Recibe la foto sin procesarla

NO abras la imagen original con visión ni la pases como base64 gigante: el modelo solo
debe verla cuando ya esté reducida (`preview_image_base64` del paso 1).

| Dónde corre tu MCP | Acción |
|---|---|
| stdio en tu misma máquina (npx local) | Pasa `image_path` con la ruta local: el servidor la lee y reduce sin que la abras. Es la mejor vía. |
| HTTP remoto | Súbela con curl desde tu terminal (los bytes no entran en tu contexto) y usa el `file_id`: `curl -X PUT --data-binary @foto.jpg -H "Authorization: Bearer <secreto>" '<base>/upload?filename=foto.jpg'` → `{"file_id":"…"}`. |
| Foto pequeña ya visible en el chat | `image_base64` solo entonces. |

### Vía Telegram (gateway Hermes)

1. Envía la foto **como archivo/documento** (sin comprimir). Como "foto" Telegram la
   recomprime y **pierde el GPS EXIF**: sin ubicación no hay aviso automático.
2. La foto queda en la caché del Hermes (`~/.hermes/image_cache/`); súbela al MCP con
   curl desde tu terminal (los bytes no entran en tu contexto):
   `curl -X PUT --data-binary @<foto> -H "Authorization: Bearer <secreto>" '<base>/upload?filename=foto.jpg'`
   → `{"file_id":"…"}`. Límite 20 MB con la Bot API pública (local Bot API server lo
   sube a 2 GB).
3. Usa ese `file_id` en `create_aviso_from_photo` y `attach_photo`.

Si la foto no trae GPS EXIF, NO adivines: pide ubicación al humano (o `lat`/`lng`).
Solo JPEG trae EXIF legible.

El servidor reduce a lado mayor 2048 conservando el GPS, adjunta siempre la original
y te devuelve la copia pequeña para visión en el preview.

### 1. Preview (NUNCA envía nada)

La dirección (`address_string`) y las respuestas de ubicación se auto-resuelven del
servidor (ver `resolve_address`) salvo que las pases tú; el preview las marca con
`address_auto_resolved: true` para que el humano las revise.

Llama `mcp__madrid_avisos__create_aviso_from_photo` con:

- `file_id` (HTTP remoto) o `image_path` (stdio local): VÍAS PREFERIDAS según dónde
  corra tu MCP. `image_base64` solo para fotos pequeñas ya visibles. NUNCA pases rutas
  locales tuyas a un servidor remoto ni base64 de fotos grandes.
- `category_hint`: lo que ves en la foto ("cartones apilados en acera", "farola apagada"…).
- `description`: descripción GENERAL de lo que sucede, sin entrar en detalles (medidas,
  marcas, minucias). Es el texto que se publicará. Si la omites, se pre-rellena y se
  marca `description_drafted:true` (el humano debe revisarlo).
- Opcional: `service_id` si ya sabes la categoría, `lat`/`lng` si la foto no trae GPS,
  `address_string` ("Calle Laurel, 2").

Posibles respuestas:

- `phase: "need_category"` → enseña `suggestions` al humano y repite con el `service_id` elegido.
- `phase: "preview"` → sigue al paso 2. Guarda el `preview_token`: está ligado al payload
  exacto; si cambias CUALQUIER campo hay que pedir preview nuevo.

### 2. Enseña el preview al humano y espera su "sí"

Muéstrale: categoría, dirección/coordenadas, descripción, `duplicates` y el payload.

- Si hay un **duplicado cercano** que parece el mismo montón, propone seguirlo en vez de
  duplicar (mira `service_request_id`, dirección y hora).
- Las preguntas del formulario (`additional_data`) van por **id de pregunta**
  (de `get_category`), con valores de su `possible_answers`.

### 3. Envío (solo con el "sí" explícito)

Repite la llamada con los MISMOS campos + las tres cosas a la vez:

- `confirm: true` + `human_confirmed: true` + `preview_token: "<el del preview>"`

Sin las tres, el servidor bloquea. Respuesta `phase: "sent"` con el aviso creado
(`service_request_id`, estado).

### 4. Adjunta la foto y reporta

Llama `mcp__madrid_avisos__attach_photo` con el `request_token` que viene en `response` del
paso 3 + la foto (`file_id`, o `image_path` en stdio local, o `image_base64`) +
`confirm: true` (también con OK humano). Comprueba con
`mcp__madrid_avisos__list_my_avisos` y reporta: ID (`service_request_id`), estado,
dirección y si la foto quedó adjunta (`media_url`).

## Pitfalls

- Pasar `image_path` a un servidor MCP **remoto**: no ve tu disco. `image_path` solo vale en
  stdio/CLI en la misma máquina (ahí es la vía preferida); para remoto, sube la foto con
  `PUT /upload` y usa el `file_id`, o `image_base64` si ya la tienes en el contexto.
- Enviar `additional_data` con el **código** de pregunta en vez del **id**: el servidor lo
  rechaza. El id sale de `get_category`.
- Pasar `device_type: "android"`: NO es un literal, es el id del origin-device del canal.
  No lo pases nunca; el servidor lo resuelve solo.
- Cambiar cualquier campo entre preview y envío: el `preview_token` deja de coincidir y
  hay que repetir el preview.
- Filtrar respuestas de ubicación vacías (como `calificador`): el servidor las exige
  presentes. Pasa las de `resolve_location` tal cual; además el servidor auto-rellena
  los huecos.
- Rellenar un `calificador` (u otra respuesta) en blanco con `""` o inventar un valor:
  el servidor lo rechaza. Las respuestas en blanco se OMITEN (como hacen la app y la
  web); las presentes deben ser no vacías.
- `get_aviso` NO acepta el `service_request_id` visible; necesita el id interno.
- Perder el EXIF al redimensionar (p.ej. captura de pantalla de la foto): sin GPS no hay
  aviso automático; pide ubicación.

## Verification

- `mcp__madrid_avisos__whoami` devuelve el perfil (sesión válida).
- Tras el envío, `mcp__madrid_avisos__list_my_avisos` muestra el aviso con su
  `service_request_id` y `media_url` con la foto.
