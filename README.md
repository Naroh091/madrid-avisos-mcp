# madrid-avisos-mcp

Servidor **MCP** (y CLI de apoyo) para la API de Avisos del Ayuntamiento de Madrid.
Permite a un agente listar categorías, resolver una ubicación, consultar avisos y crear avisos con inteligencia artificial— incluso desde una foto.

La finalidad de este proyecto es hacer más fácil que los ciudadanos puedan reportar problemas al Ayuntamiento de Madrid. Saca una foto
de la incidencia (por ejemplo, basura tirada en la calle, una farola que no funciona…) pásasela al agente pidiéndole que genere un aviso para
que de forma autónoma describa el problema, seleccione la categoría más adecuada, añada la ubicación (la foto tiene que estar geolocalizada) y lance
el aviso al Ayuntamiento.

- [Inicio rápido](#inicio-rápido)
- [Fotos demasiado grandes para el modelo](#fotos-demasiado-grandes-para-el-modelo)
- [¿Eres un agente IA? Lee esto primero](#eres-un-agente-ia-lee-esto-primero)
- [Añadir el MCP vía npx](#añadir-el-mcp-vía-npx)
- [Herramientas MCP](#herramientas-mcp)
- [Configuración](#configuración)
- [Uso como CLI](#uso-como-cli)
- [Servidor HTTP (opcional, avanzado)](#servidor-http-opcional-avanzado)
- [Arquitectura](#arquitectura)
- [Licencia](#licencia)

## Inicio rápido

1. Inicia sesión en <https://avisos.madrid.es> con tu usuario.
2. Abre las DevTools del navegador (F12) → pestaña **Application** o **Aplicación**, y
ahí en la barra lateral ve a Almacenamiento > Almacenamiento local y selecciona https://avisos.madrid.es.
Copia el valor de la clave `token` (empieza por `ey…`). Ese es tu `MADRID_AVISOS_TOKEN` (caduca al mes; repite el paso
   cuando deje de funcionar).
3. Añade el servidor a tu cliente MCP ([ejemplos](#añadir-el-mcp-vía-npx)) o configúralo
   a mano:

```json
{
  "mcpServers": {
    "madrid-avisos": {
      "command": "npx",
      "args": ["-y", "madrid-avisos-mcp"],
      "env": { "MADRID_AVISOS_TOKEN": "<tu-token>" }
    }
  }
}
```

4. Flujo del agente: `list_categories` → `resolve_location` → `create_aviso` en dry-run →
   enseña el preview al humano → `confirm: true` solo con su "sí" → `attach_photo`.
   O directamente `create_aviso_from_photo` con la imagen.

Todo corre en tu máquina y el token no sale de ella: cada aviso se crea como tu usuario.

## Fotos demasiado grandes para el modelo

Algunos modelos rechazan fotos muy grandes (`image decode limit exceeded`). El servidor
reduce en TypeScript (sin dependencias) conservando el GPS, así que el modelo nunca
necesita procesar la original:

* **Remoto (HTTP)**: sube la foto con curl y usa el `file_id` (los bytes no pasan por el
  modelo). Requiere el secreto del servidor:
  ```bash
  curl -X PUT --data-binary @foto.jpg \
    -H "Authorization: Bearer <secreto>" \
    'http://127.0.0.1:3000/upload?filename=foto.jpg'
  # → {"file_id":"…","bytes":…}
  ```
  El preview devuelve `preview_image_base64` (copia reducida) para visión y adjunta
  siempre la original.
* **Local (stdio/CLI)**: pasa `image_path`; el servidor lee y reduce sin que el modelo
  abra el fichero. O reduce tú con `node dist/cli.js prep-photo foto.jpg [foto-ligera.jpg]`.

## ¿Eres un agente IA? Lee esto primero

Hay una skill por familia de cliente y **no se autoinstalan**: cópiala al directorio de
tu cliente y abre sesión nueva.

```bash
cp -r skill ~/.hermes/skills/madrid-avisos        # Hermes
cp -r skill ~/.claude/skills/madrid-avisos        # Claude Code
# OpenCode (mkdir -p necesario: el destino suele no existir aún)
mkdir -p ~/.config/opencode/skills/madrid-avisos-opencode
cp -r skill-opencode/madrid-avisos-opencode/SKILL.md ~/.config/opencode/skills/madrid-avisos-opencode/
```

O descárgala:

- Claude Code / Hermes / OpenClaw: [`skill/SKILL.md`](skill/SKILL.md)
- OpenCode: [`skill-opencode/madrid-avisos-opencode/SKILL.md`](skill-opencode/madrid-avisos-opencode/SKILL.md)

> OpenCode usa otro prefijo de tools (`madrid-avisos_*`, no `mcp__madrid_avisos__`), así
> que trae su propia variante en
> [`skill-opencode/`](skill-opencode/madrid-avisos-opencode/SKILL.md), con nombre propio
> (`madrid-avisos-opencode`) a propósito.
>
> OpenCode también lee `~/.claude/skills/`. Si tienes ahí la variante de Claude y
> OpenCode, con las dos instaladas gana la que se escanee última y la otra se descarta con
> un warning en el log; por eso la variante de OpenCode se instala en su propia ruta con
> nombre propio. Si ya copiaste la de Claude a `~/.claude/skills/madrid-avisos` y no usas
> Claude Code, bórrala.

Instálalo así (requiere Node 18+):

1. **Token**: pide al humano su `token` de <https://avisos.madrid.es> (DevTools → Application →
   Almacenamiento local → `https://avisos.madrid.es` → clave `token`). Sin token
   no hay nada que hacer.
2. **Instalación** según tu cliente ([comandos exactos](#añadir-el-mcp-vía-npx)):
   Claude Code (`claude mcp add … -- npx -y madrid-avisos-mcp`), OpenCode (`opencode mcp add …
   --env MADRID_AVISOS_TOKEN=… -- npx -y madrid-avisos-mcp`), Hermes (`hermes mcp add …
   --command npx … --args -y madrid-avisos-mcp`) u OpenClaw (`openclaw mcp add …
   --command npx --arg -y --arg madrid-avisos-mcp`). El token viaja en la variable
   `MADRID_AVISOS_TOKEN` de tu config.
3. **Verifica** (`mcp list` / `test` / `doctor --probe` según cliente): debes ver 11 tools.
4. **Uso**: skill completa según tu cliente —
   [`skill/SKILL.md`](skill/SKILL.md) (Claude Code, Hermes, OpenClaw) o
   [`skill-opencode/madrid-avisos-opencode/SKILL.md`](skill-opencode/madrid-avisos-opencode/SKILL.md) (OpenCode).
   Lo esencial: solo incidencias genuinas; `create_aviso_from_photo` en 2 fases
   (preview → mostrar al humano → envío solo con su "sí" + `confirm` + `human_confirmed` +
   `preview_token`); la foto por `image_path` si el MCP corre en stdio en tu máquina, o por
   `image_base64` si es remota; sin GPS no adivines la ubicación.

## Añadir el MCP vía npx

Requiere Node 18+. `<tu-token>` es tu bearer (paso 2 del [inicio rápido](#inicio-rápido)).

### Claude Code

```bash
claude mcp add madrid-avisos -e MADRID_AVISOS_TOKEN=<tu-token> -- npx -y madrid-avisos-mcp
claude mcp list   # verificar
```

### OpenCode

```bash
opencode mcp add madrid-avisos --env MADRID_AVISOS_TOKEN=<tu-token> -- npx -y madrid-avisos-mcp
opencode mcp list   # verificar: madrid-avisos connected
```

Equivalente a editar `~/.config/opencode/opencode.jsonc` a mano (esto es justo lo que
escribe el comando anterior):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "madrid-avisos": {
      "type": "local",
      "command": ["npx", "-y", "madrid-avisos-mcp"],
      "environment": { "MADRID_AVISOS_TOKEN": "<tu-token>" }
    }
  }
}
```

Reinicia opencode después de tocar la config: no se recarga en caliente. Las tools
aparecen como `madrid-avisos_*`.

<details>
<summary><b>OpenCode v2 (experimental): los servers van bajo <code>mcp.servers</code></b></summary>

En la config v2 la sección `mcp` tiene una forma distinta: los servers se anidan bajo
`mcp.servers` y `enabled: true` se invierte a `disabled: false`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "madrid-avisos": {
        "type": "local",
        "command": ["npx", "-y", "madrid-avisos-mcp"],
        "disabled": false,
        "environment": { "MADRID_AVISOS_TOKEN": "<tu-token>" }
      }
    }
  }
}
```

No hay schema JSON publicado para v2 todavía, así que el editor no puede validarla. Y una
clave mal escrita **no falla de forma visible**: el server simplemente no aparece en
`opencode mcp list` y el comando sale con éxito. Solo lo verás si buscas en los logs:

```bash
opencode mcp list --print-logs --log-level DEBUG 2>&1 | grep -i malformed
# WARN configuration compatibility diagnostic … kind=invalid … "Native setting could not be lowered because it is malformed"
```

**v2 no es estable: la forma puede cambiar sin aviso.** Usa la v1 de arriba salvo que sepas
que tu versión la pide. Verifica con `opencode mcp list` que `madrid-avisos` sale
`connected` antes de darlo por instalado.

</details>

### Hermes

```bash
hermes mcp add madrid-avisos --command npx --env MADRID_AVISOS_TOKEN=<tu-token> --args -y madrid-avisos-mcp
hermes mcp test madrid-avisos   # verificar (lista las 11 tools)
```

### OpenClaw

```bash
openclaw mcp add madrid-avisos \
  --command npx \
  --arg -y \
  --arg madrid-avisos-mcp \
  --env MADRID_AVISOS_TOKEN=<tu-token>
openclaw mcp doctor madrid-avisos --probe   # verificar
```

### Desde código

```bash
npm install
npm run build
npx -y -p madrid-avisos-mcp madrid-avisos-mcp-http   # HTTP en 127.0.0.1:3000/mcp
```

## Herramientas MCP

| Tool | Qué hace |
|---|---|
| `whoami` | Perfil del usuario autenticado (valida el token). |
| `refresh_session` | Refresca el access token con el refresh token (también automático ante 401). |
| `list_categories` | Categorías/servicios (id, flags de formulario). |
| `get_category` | Detalle de una categoría (formulario, obligatorios, tipología). |
| `resolve_location` | Valida zona del servicio + dirección municipal + preguntas de ubicación + duplicados. |
| `resolve_address` | Geocodificación inversa propia: coords → dirección municipal + respuestas pre-rellenadas. |
| `create_aviso` | Crea un aviso. **Dry-run por defecto**; `confirm: true` para enviar de verdad. |
| `create_aviso_from_photo` | Aviso desde foto en 2 fases: preview (GPS EXIF + categoría + ubicación) y envío solo con `confirm: true` + `human_confirmed: true` + `preview_token`. Acepta `image_base64` o `image_path`. |
| `attach_photo` | Adjunta una foto al aviso (`image_base64` o `image_path`). Dry-run por defecto. |
| `get_aviso` | Detalle de un aviso por su id interno. |
| `list_my_avisos` | Avisos propios (`own: true` por defecto). |

### Seguridad de envío

`create_aviso` es **dry-run por defecto**: devuelve el payload **sin crear nada**. Solo con
`confirm: true` hace el `POST` real — un aviso real que revisa personal municipal.
Envía únicamente incidencias reales.

`create_aviso_from_photo` exige confirmación humana en dos fases:

1. **Preview** (`confirm` ausente/false): extrae el GPS EXIF (o usa `lat`/`lng` manuales),
   sugiere categoría desde `category_hint` si falta `service_id`, resuelve ubicación
   (validación + duplicados) y devuelve el payload + un `preview_token`. No envía nada.
2. **Envío**: el agente muestra el preview al humano y espera su "sí"; solo entonces repite
   la llamada con los MISMOS campos + `confirm: true` + `human_confirmed: true` +
   `preview_token`. Si cambió cualquier campo, hay que repetir el preview.

## Uso como CLI

```bash
export MADRID_AVISOS_TOKEN=<tu-token>
node dist/cli.js categories
node dist/cli.js category 591b39e24e4ea83a018b46ad
node dist/cli.js resolve 591b39e24e4ea83a018b46ad 40.4168 -3.7038
node dist/cli.js create 591b39e24e4ea83a018b46ad 40.4168 -3.7038 "Farola apagada"          # dry-run
node dist/cli.js create 591b39e24e4ea83a018b46ad 40.4168 -3.7038 "Farola apagada" --send   # ENVÍA de verdad
node dist/cli.js from-photo foto.jpg 591b126d4e4ea840018b45b6 "Cartones en la acera"      # preview desde foto
node dist/cli.js aviso <id>
node dist/cli.js prep-photo foto.jpg [foto-ligera.jpg]   # reduce para el modelo, conserva EXIF/GPS
```

## Servidor HTTP (opcional)

Por stdio cada uno corre su copia con su token. La entrada **HTTP** sirve para el caso
contrario: exponer el servidor que corre en TU máquina (con TU token) para que un agente
en OTRA máquina lo use — en ese caso actúa como tú, no como el dueño del agente remoto.
Para uso personal normal no la necesitas.

```bash
export MADRID_AVISOS_TOKEN=<tu-token>
export MADRID_AVISOS_MCP_SECRET=<un-secreto-largo>            # exige x-mcp-secret o Bearer
export MADRID_AVISOS_ALLOWED_HOSTS=tu-host.tu-tailnet.ts.net  # anti DNS-rebinding
npm run start:http     # 127.0.0.1:3000/mcp
```

Variables: `MADRID_AVISOS_HTTP_PORT` (3000), `MADRID_AVISOS_HTTP_HOST` (127.0.0.1),
`MADRID_AVISOS_HTTP_PATH` (/mcp). Expón solo en red privada (p.ej. `tailscale serve`,
nunca `funnel`): quien llegue a la URL actúa como tu usuario. Para persistencia,
`launchd`/`pm2`/`tmux` o similar.

## Arquitectura

- `src/client.ts` — HTTP: cabeceras de app + bearer, GET/POST/multipart, auto-refresh ante 401.
- `src/avisos.ts` — **núcleo** de negocio (reutilizado por MCP y CLI).
- `src/photo.ts` — foto: EXIF/GPS, subida a tmp, token de preview.
- `src/types.ts` — esquemas zod de entrada + payload de creación.
- `src/mcp.ts` — `buildServer()`: registra las 11 tools (compartido por stdio y HTTP).
- `src/server.ts` — entrada stdio · `src/http.ts` — entrada HTTP (`/mcp` + `PUT /upload`) · `src/cli.ts` — CLI.

## Notas

- Algunas categorías exigen usuario registrado; con `login-anonymous` no se envían.

## Licencia

AGPLv3. Ver [LICENSE](LICENSE).
