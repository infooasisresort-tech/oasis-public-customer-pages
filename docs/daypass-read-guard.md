# Day Pass: comprobación de lectura OR, versión mínima

Esta rama `fix/daypass-live-read-guard` aplica una comprobación de disponibilidad mediante el Worker existente. El candidato completo con reservas temporales permanece separado en `fix/daypass-authoritative-availability`. Esta versión no genera holds, no modifica OR/CRM, no descuenta plazas en el navegador y no promete retención.

## Contrato backend

La versión exigida para disponibilidad, pedidos y creación de Checkout es `capacityGuard: "or-reservas-read-v1"`. El backend debe leer la disponibilidad vigente de OR/RESERVAS antes de cada pedido y antes de cada sesión Stripe. Debe admitir el valor numérico vigente de la celda de disponibilidad, tanto literal como resultado de fórmula; resolver fecha y campos con las cabeceras vivas. Una lectura ausente, ambigua, inválida o fallida bloquea la operación. No usar una copia hardcodeada ni exportar filas/PII.

```http
GET /availability?date=2026-10-08&adults=2&children=1
```

```json
{
  "capacityGuard": "or-reservas-read-v1",
  "date": "2026-10-08",
  "adults": 2,
  "children": 1,
  "remaining": 3,
  "available": true,
  "checkedAt": "2026-10-07T12:00:00Z"
}
```

Todos los valores son ejemplos sintéticos, sin afirmar disponibilidad actual. El eco fecha/adultos/niños debe coincidir exactamente. `remaining` es entero seguro no negativo; negativos se normalizan a cero en el backend. `available === (remaining >= adults + children)`. ISO `checkedAt` debe ser válido, no anterior a 30 segundos ni más de 5 segundos futuro respecto al navegador. Los 30 segundos son frescura técnica de la consulta, no retención de plazas.

En «Personas» se muestra `Máximo disponible para esta fecha: X personas.` solo si el grupo supera `remaining`, incluido cero. Si cabe o coincide, el mensaje positivo no muestra capacidad numérica. Una lectura nueva, un error o la caducidad elimina el máximo anterior. Se consultan cambios de fecha/adultos/niños; AbortController y versión impiden que una respuesta tardía habilite una selección posterior. Ambos botones están bloqueados desde HTML, sin depender de JavaScript para el estado inicial.

```http
POST /reservations
```

Conserva el payload existente y añade `paymentMethod: "card" | "transfer"` y un `idempotencyKey` UUID v4 en memoria para el mismo payload/método. Respuesta necesaria:

```json
{ "reference": "DP-EJEMPLO", "capacityGuard": "or-reservas-read-v1" }
```

No se exige ni simula `holdExpiresAt`. El backend puede admitir UUID como recibo idempotente sin romper al frontend anterior sin UUID durante el despliegue. Si no implementa ese recibo, una respuesta POST perdida puede haber creado un pedido: no hay reintento automático de POST; un reintento manual conserva clave, pero la deduplicación depende del backend y debe documentarse/verificarse antes de afirmar garantía. La referencia ya recibida se reutiliza al reintentar Checkout.

```http
POST /create-checkout-session
```

Recibe el mismo payload, método, UUID y referencia. El Worker contrasta la selección con el pedido previo y vuelve a leer OR, sin confiar en la comprobación del navegador. Conserva la idempotencia Stripe existente por referencia. Respuesta necesaria:

```json
{ "capacityGuard": "or-reservas-read-v1", "url": "https://checkout.stripe.com/c/pay/ejemplo" }
```

Solo se permite HTTPS, hostname exacto `checkout.stripe.com`, sin usuario/password ni puerto adicional. Una respuesta sin guard o del candidato completo no se acepta. Doble clic/Enter/ambos métodos quedan bajo un guard común, con controles congelados; cambios programáticos del payload durante las respuestas se rechazan antes de mostrar transferencia o abrir Stripe.

Transferencia también hace POST `/reservations` con método `transfer` y exige guard antes de mostrar banco, concepto, importe o WhatsApp preparado. No se abre WhatsApp real en las pruebas. Cambiar cualquier dato del pedido/cliente, volver a leer con error o caducar la consulta oculta y limpia las instrucciones y enlace. No se promete una reserva temporal ni se habilita un pedido cuando hay cero plazas por conservar una referencia anterior.

El retorno de Stripe se comprueba con el endpoint original de solo lectura. La confirmación visible dice «Tu pago con tarjeta está confirmado» y confirma únicamente el pago; no afirma una plaza retenida o reserva confirmada. Pago pendiente, retorno cancelado/contradictorio, falta de sesión o error no generan otra orden/cobro y advierten no repetir el pago.

## Límites de esta entrega

Esta versión corrige el acceso a pedido/cobro cuando la lectura vigente indica cero, insuficiencia o error. No resuelve carreras entre una lectura y escrituras externas de OR, no registra/descuenta capacidad automáticamente en CRM y no reserva plazas durante la estancia en Stripe. Una sesión ya abierta puede recibir un pago después de cambiar OR. Una transferencia bancaria externa posterior tampoco puede bloquearse desde el frontend. Esos casos y el control completo de inventario requieren el candidato separado y una política/backend verificados. No efectuar reembolsos ni comunicaciones reales para probarlos.

## Verificación

```powershell
node --check daypass/app.js
node --test test/frontend.test.cjs
git diff --check
```

Las pruebas usan VM, DOM reducido, reloj, red simulada y ventanas simuladas: no escriben Sheets, pedidos o pagos reales. Cubren cero/insuficiencia/igualdad/cabe, máximo condicional, lectura nueva/error sin capacidad anterior, frescura, fallos HTTP/JSON/timeout, fecha/grupo/respuesta tardía, doble envío, guard de pedido y Checkout, transferencia, reintentos con UUID/ref, campos obligatorios/opcionales y retorno de pago sin prometer plaza.

La publicación corresponde al flujo existente del repositorio. Quedan pendientes integrar/verificar el Worker real, probar desktop/móvil y comprobar el commit de la URL pública. No afirmar despliegue u operación completa basándose en estos tests locales.
