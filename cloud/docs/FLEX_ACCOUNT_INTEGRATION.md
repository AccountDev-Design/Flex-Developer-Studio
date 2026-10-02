# Flex Cloud ↔ Flex Account

Flex Cloud **no tiene usuarios, contraseñas ni login propios**. Cada petición se
identifica preguntando a Flex Account, y la cuenta que se usa sale **siempre**
de esa respuesta: nunca de un `accountId`, `ownerId` o similar enviado por el
cliente.

## Qué se encontró al auditar

- El código de Flex Account (sesión web de Flex Developer Studio, `/activate`,
  `POST/GET /api/devices/code`, catálogo de Flex Store) **no está en este
  repositorio**: vive en el sitio publicado
  (`flex-developer-studio.ralvarezsantos980.chatgpt.site`). Este repositorio
  solo contenía el SDK de paquetes.
- El P4 (`FlexOS_Account.cpp`) vincula el dispositivo generando dentro del
  ESP32-P4 una credencial aleatoria de 32 bytes (43 caracteres base64url) y
  enviando **solo su SHA-256** (`tokenHash`). Flex Account guarda esa huella
  asociada a la cuenta cuando la persona aprueba el código.

Con eso, Flex Cloud puede autenticar al P4 sin conocer nunca la credencial en
claro del lado de Flex Account, y la web sin interpretar su cookie.

## Contrato de introspección (lo que Flex Account debe exponer)

```
POST {FLEX_ACCOUNT_INTROSPECT_URL}
Authorization: Bearer {FLEX_ACCOUNT_SERVICE_KEY}
Content-Type: application/json
```

Cuerpo, uno de:

```json
{ "kind": "device",  "tokenHash": "<sha256 hex de la credencial del P4>" }
{ "kind": "session", "cookie": "<cabecera Cookie tal cual la envió el navegador>" }
```

Respuesta `200` (siempre JSON):

```json
{ "active": true,
  "account": { "id": "acc_123", "flexAddress": "ana@flex", "displayName": "Ana", "plan": "free" },
  "device":  { "id": "dev_9", "label": "FlexOS Ultra de Ana" } }
```

```json
{ "active": false, "reason": "device_revoked" | "token_expired" | "auth_required" }
```

- `account.id`: identificador estable de Flex Account (`[A-Za-z0-9_.:-]{1,128}`).
- `account.plan` (opcional): nombre de un plan de `FLEX_CLOUD_PLANS`. Así la
  cuota de 5/10/50/100 GB la decide Flex Account (o la facturación), no la web.
- Cualquier respuesta no‑200, cuerpo ilegible o con forma inesperada →
  Flex Cloud responde `503 account_unavailable`. **Nunca** lo trata como
  "sin sesión".

### Referencia de implementación (lado Flex Developer Studio)

```js
// POST /api/internal/introspect
if (req.headers.authorization !== `Bearer ${process.env.FLEX_CLOUD_SERVICE_KEY}`) return res.status(401).end();
const { kind, tokenHash, cookie } = req.body;
if (kind === 'device') {
  const d = await db.devices.findByTokenHash(tokenHash);          // lo que ya guarda /api/devices/code
  if (!d || d.revokedAt) return res.json({ active: false, reason: 'device_revoked' });
  const a = await db.accounts.get(d.accountId);
  return res.json({ active: true, account: { id: a.id, flexAddress: a.flexAddress, displayName: a.displayName, plan: a.cloudPlan },
                    device: { id: d.id, label: d.label } });
}
if (kind === 'session') {
  const s = await sessions.fromCookieHeader(cookie);               // el mismo mecanismo de la web
  if (!s) return res.json({ active: false, reason: 'auth_required' });
  if (s.expired) return res.json({ active: false, reason: 'token_expired' });
  const a = await db.accounts.get(s.accountId);
  return res.json({ active: true, account: { id: a.id, flexAddress: a.flexAddress, displayName: a.displayName, plan: a.cloudPlan } });
}
```

## Despliegue recomendado (mismo origen)

```
https://flex-developer-studio…/cloud/        → Flex Cloud web   (cloud/web, estáticos)
https://flex-developer-studio…/api/cloud/*   → Flex Cloud API   (node src/server.js)
https://flex-developer-studio…/*             → Flex Developer Studio (sin cambios)
```

- Con el mismo dominio, la cookie de sesión de Flex Developer Studio llega sola
  a `/api/cloud/*` y no hace falta CORS.
- `FLEX_CLOUD_TRUST_PROXY=1` si va detrás de un proxy (IP real para el
  limitador de intentos).
- `FLEX_CLOUD_PUBLIC_URL=https://flex-developer-studio…` para los enlaces
  firmados.
- La web de Flex Cloud responde en **`/cloud/`** (y `/cloud` redirige a `/cloud/`);
  esa es la ruta estable. Si el servicio va detrás de un proxy, basta con
  reenviarle `/cloud*` y `/api/cloud/*` sin reescribir nada: también sirve la
  web en su propia raíz (puerto propio, sin proxy).
- **Acceso directo desde Flex Developer Studio**: el sitio de Studio no está en
  este repositorio, así que el enlace se añade allí (barra de navegación, panel
  de la cuenta o página de inicio) con la ruta relativa, sin dominio fijo:
  `<a href="/cloud/">Flex Cloud</a>`. Quien no tenga sesión pasa por
  `/login?next=/cloud/` y vuelve a Flex Cloud.
- En `web/index.html`, `flex-account-login` y `flex-account-logout` apuntan a
  las páginas de entrada y salida de Flex Developer Studio.

## El P4

- Valida su vínculo con `GET /api/cloud/me` y `Authorization: Bearer <credencial>`
  (`FLEX_ACCOUNT_SESSION_URL` en el firmware). `200` = vinculado y validado;
  `401` con `error.code` `device_revoked` / `token_expired` = hay que volver a
  vincular; cualquier otra cosa = servicio no disponible (el P4 **sigue
  vinculado** y reintenta con espera creciente).
- Todas las peticiones de Flex Cloud del P4 usan esa misma credencial.

## Modo desarrollo

`FLEX_ACCOUNT_MODE=dev` (prohibido con `NODE_ENV=production`) sustituye la
introspección por tablas locales para probar la web y el P4 sin el Flex Account
real: `POST /api/cloud/dev/login` crea una sesión de prueba y
`POST /api/cloud/dev/devices {tokenHash}` registra la huella de un P4 en la
cuenta de la sesión, exactamente lo que haría Flex Account al aprobar el código.
