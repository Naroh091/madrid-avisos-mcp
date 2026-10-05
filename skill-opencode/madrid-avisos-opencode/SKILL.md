---
name: madrid-avisos-opencode
description: "Crea avisos al Ayuntamiento de Madrid (basura, farolas, aceras, mobiliario roto) a partir de una foto. Úsala cuando el usuario te pase una foto de una incidencia urbana en Madrid y te pida reportarla, crear un aviso o avisar al ayuntamiento."
---

# Avisos Madrid — incidencias desde una foto

Servidor MCP `madrid-avisos`, 11 tools, prefijo `madrid-avisos_` (p. ej. `madrid-avisos_create_aviso_from_photo`). Corre por stdio en la máquina del usuario, así que `image_path` con una ruta local es la vía preferida y los bytes de la foto original nunca pasan por tu contexto.
Alcobendas usa la misma plataforma: si hay un servidor `alcobendas-avisos` (prefijo `alcobendas-avisos_`),
el flujo es idéntico; usa el servidor del ayuntamiento donde está la incidencia.

Actúas como el dueño del token configurado en el servidor: todo aviso que crees es REAL y lo revisa personal municipal. **Solo incidencias genuinas. Nada de pruebas.**

## When to Use

Cuando el humano te pasa una foto de una incidencia urbana en Madrid (basura, farolas, aceras…) y te pide generar un aviso al Ayuntamiento. Para esta tarea usa SOLO: inspección de la imagen + las tools `madrid-avisos_*`. NO explores la máquina (nada de `~/.ssh`, historiales shell, ficheros de config): no sirve para crear el aviso.

## Procedure

### 0. Recibe la foto sin procesarla

NO abras la imagen original con visión ni la pases como base64 gigante: el modelo solo debe verla cuando ya esté reducida (`preview_image_base64` del paso 1).

| Dónde corre tu MCP | Acción |
|---|---|
| stdio en tu máquina (npx local — el caso de OpenCode) | Pasa `image_path` con la ruta local: el servidor la lee y reduce sin que la abras. Es la mejor vía. |
| HTTP remoto | Súbela con curl desde tu terminal (los bytes no entran en tu contexto) y usa el `file_id`: `curl -X PUT --data-binary @foto.jpg -H "Authorization: Bearer <secreto>" '<base>/upload?filename=foto.jpg'` → `{"file_id":"…"}`. |
| Foto pequeña ya visible en el chat | `image_base64` solo entonces. |

Si la foto no trae GPS EXIF, NO adivines: pide la ubicación al humano (o `lat`/`lng`). Solo JPEG trae EXIF legible.

El servidor reduce a lado mayor 2048 conservando el GPS, adjunta siempre la original y te devuelve la copia pequeña para visión en el preview.

### 1. Preview (NUNCA envía nada)

La dirección (`address_string`) y las respuestas de ubicación se auto-resuelven del servidor (ver `madrid-avisos_resolve_address`) salvo que las pases tú; el preview las marca con `address_auto_resolved: true` para que el humano las revise.

Llama `madrid-avisos_create_aviso_from_photo` con:

- `image_path` (stdio local): vía preferida. `image_base64` solo para fotos pequeñas ya visibles. NUNCA pases rutas locales tuyas a un servidor remoto ni base64 de fotos grandes.
- `category_hint`: lo que ves en la foto ("cartones apilados en acera", "farola apagada"…).
- `description`: descripción GENERAL de lo que sucede, sin entrar en detalles (medidas, marcas, minucias). Es el texto que se publicará. Si la omites, se pre-rellena y se marca `description_drafted:true` (el humano debe revisarlo).
- Opcional: `service_id` si ya sabes la categoría, `lat`/`lng` si la foto no trae GPS, `address_string` ("Calle Laurel, 2").

Posibles respuestas:

- `phase: "need_category"` → enseña `suggestions` al humano y repite con el `service_id` elegido.
- `phase: "preview"` → sigue al paso 2. Guarda el `preview_token`: está ligado al payload exacto; si cambias CUALQUIER campo hay que pedir preview nuevo.

### 2. Enseña el preview al humano y espera su "sí"

Muéstrale: categoría, dirección/coordenadas, descripción, `duplicates` y el payload.

- Si hay un **duplicado cercano** que parece el mismo montón, propone seguirlo en vez de duplicar (mira `service_request_id`, dirección y hora).
- Las preguntas del formulario (`additional_data`) van por **id de pregunta** (de `madrid-avisos_get_category`), con valores de sus `possible_answers`.

### 3. Envío (solo con el "sí" explícito)

Repite la llamada con los MISMOS campos + las tres cosas a la vez:

- `confirm: true` + `human_confirmed: true` + `preview_token: "<el del preview>"`

Sin las tres, el servidor bloquea. Respuesta `phase: "sent"` con el aviso creado (`service_request_id`, estado).

### 4. Adjunta la foto y reporta

Llama `madrid-avisos_attach_photo` con el `request_token` que viene en `response` del paso 3 + `image_path` de la foto + `confirm: true` (también con OK humano). Comprueba con `madrid-avisos_list_my_avisos` y reporta: ID (`service_request_id`), estado, dirección y si la foto quedó adjunta (`media_url`).

## Herramientas

| Tool | Qué hace |
|---|---|
| `madrid-avisos_whoami` | Perfil del usuario autenticado (valida el token). |
| `madrid-avisos_refresh_session` | Refresca el access token (también automático ante 401). |
| `madrid-avisos_list_categories` | Categorías/servicios (id, flags de formulario). |
| `madrid-avisos_get_category` | Detalle de una categoría (formulario, obligatorios, tipología). |
| `madrid-avisos_resolve_location` | Zona del servicio + dirección municipal + duplicados cercanos. |
| `madrid-avisos_resolve_address` | Auto-resuelve dirección y respuestas de ubicación. |
| `madrid-avisos_create_aviso` | Crea un aviso. Dry-run por defecto; `confirm:true` para enviar. |
| `madrid-avisos_create_aviso_from_photo` | Flujo en 2 fases: preview + envío con confirmación humana. |
| `madrid-avisos_attach_photo` | Adjunta la foto a un aviso ya creado. |
| `madrid-avisos_get_aviso` | Detalle de un aviso por su id interno. |
| `madrid-avisos_list_my_avisos` | Tus avisos. Sin `filters` usa `own:true, limit:10`; al pasar filtros, los sustituye enteros. |

## Pitfalls

- Pasar `image_base64` de una foto grande: waste de contexto y el modelo puede rechazar la imagen. En stdio usa `image_path`.
- Pasar `image_path` a un servidor HTTP remoto: no ve tu disco. Solo vale en stdio local.
- Enviar `additional_data` con el **código** de pregunta en vez del **id**: el servidor lo rechaza. El id sale de `madrid-avisos_get_category`.
- Pasar `device_type: "android"`: NO es un literal, es el id del origin-device del canal. No lo pases nunca; el servidor lo resuelve solo.
- Cambiar cualquier campo entre preview y envío: el `preview_token` deja de coincidir y hay que repetir el preview.
- Filtrar respuestas de ubicación vacías (como `calificador`): el servidor las exige presentes. Pasa las de `madrid-avisos_resolve_location` tal cual; además el servidor auto-rellena los huecos.
- Rellenar un `calificador` (u otra respuesta) en blanco con `""` o inventar un valor: el servidor lo rechaza. Las respuestas en blanco se OMITEN (como hacen la app y la web); las presentes deben ser no vacías.
- `madrid-avisos_get_aviso` NO acepta el `service_request_id` visible; necesita el id interno.
- Perder el EXIF al redimensionar (p.ej. captura de pantalla de la foto): sin GPS no hay aviso automático; pide ubicación.

## Verification

- `madrid-avisos_whoami` devuelve el perfil (sesión válida).
- Tras el envío, `madrid-avisos_list_my_avisos` muestra el aviso con su `service_request_id` y `media_url` con la foto.

## Mantenimiento

`MADRID_AVISOS_TOKEN` caduca cada mes. Si las tools fallan con error de sesión, `madrid-avisos_refresh_session` lo renueva; si no, el humano debe copiar el token nuevo de <https://avisos.madrid.es> (DevTools → Application → Almacenamiento local → `https://avisos.madrid.es` → clave `token`) y actualizar `MADRID_AVISOS_TOKEN` en `~/.config/opencode/opencode.jsonc`, y reiniciar opencode.
