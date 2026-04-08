# Documentacion Onboarding - Bot WhatsApp (BuilderBot + Meta)

## 1. Objetivo del producto
Este bot automatiza 3 frentes principales:

1. Registro de gastos/pagos con comprobante adjunto (flujo conversacional guiado).
2. Envio de campanas por WhatsApp y captura de respuestas del cliente.
3. Envio de alertas/recordatorios (informes y servicio tecnico) y captura de respuestas.

Integra IA (Gemini) para extraer datos de comprobantes, y Google Apps Script para persistencia en Sheets y guardado de archivos en Drive.

---

## 2. Stack y arquitectura

- Runtime: Node.js (ESM).
- Framework bot: @builderbot/bot.
- Provider WhatsApp: @builderbot/provider-meta.
- DB runtime: MemoryDB (en memoria).
- IA: Gemini API (analisis de comprobantes).
- Persistencia externa:
  - Apps Script (catalogos + registrar gasto).
  - Webhook Sheets (registro de campanas y respuestas).

Componente principal:
- src/app.js

Caracteristicas operativas relevantes:
- Cola del bot configurada con:
  - timeout: 20000
  - concurrencyLimit: 50
- Logs debug para webhook y mensajes entrantes.

---

## 3. Flujos implementados

### 3.1 Flujo de pagos/gastos
Archivo: src/flows/payment.js

Trigger de inicio:
- gasto
- registrar gasto
- registrar pago

Resumen funcional:
1. Solicita comprobante (PNG/JPEG/PDF).
2. Descarga archivo y convierte a base64.
3. Ejecuta en paralelo:
   - Analisis IA del comprobante.
   - Carga de catalogos (proyectos, usuarios, responsables, sucursales, conceptos/subconceptos).
4. Valida reglas minimas:
   - Debe existir fecha de emision/pago detectada.
   - Si es Factura o RH, debe existir proveedor y RUC detectados.
   - Si es Boleta, debe existir RUC_EMPRESA configurado.
5. Preguntas manuales para completar payload:
   - condicion
   - metodo de pago (confirmar/corregir)
   - proyecto
   - usuarios
   - provincia
   - concepto y subconcepto
   - responsable compra
   - responsable pago
6. Construye payload final para Apps Script.
7. Envia payload al endpoint registrarGasto.
8. Muestra resumen final al usuario.

Comando de cancelacion en cualquier paso:
- cancelar
- salir
- terminar
- stop
- cancelar flujo
- terminar flujo

Nota tecnica:
- Por restriccion del linter/plugin BuilderBot, no se usa endFlow junto con flowDynamic en el mismo contexto.

### 3.2 Flujos de campanas
Archivos:
- src/flows/campaign-response.js
- src/flows/campaign-si.js
- src/flows/campaign-no.js

Resumen:
- Captura botones de respuesta de campanas (si/no programar).
- Usa timer de inactividad (IDLE_TIMEOUT) para consolidar multiples mensajes.
- Registra resultado en Google Sheets webhook.

### 3.3 Flujos de informe
Archivo: src/flows/informe-response.js

Resumen:
- Captura respuestas de botones tipo:
  - Ya lo envie
  - En proceso
  - Inconveniente
  - Ya regularice
  - Justificacion
- Responde con mensaje acorde al estado.

### 3.4 Flujo de consulta de recordatorio
Archivo: src/flows/recordatorio-consulta.js

Resumen:
- Rama cuando el usuario responde "Tengo una consulta".
- Acumula mensajes con timer de inactividad.
- Registra en Sheets y cierra con mensaje de asesor.

---

## 4. Reglas de negocio criticas (pagos)

### 4.1 Reglas por tipo de comprobante
- Factura:
  - proveedor y ruc salen del archivo/PDF detectado por IA.
- RH:
  - proveedor y ruc salen del archivo RH detectado por IA.
- Boleta:
  - proveedor = RAZON_SOCIAL_EMPRESA.
  - ruc = RUC_EMPRESA.

### 4.2 Nomenclatura
- Boleta: RUC_EMPRESA-codigo_movimiento.
- Factura: ruc_proveedor-codigo_movimiento.
- RH: numero_rh_codigo_pago.

### 4.3 Nombre de archivo para Drive
- Si existe nomenclatura, el archivo se renombra como nomenclatura + extension.
- Este nombre viaja a Apps Script para creacion del archivo en Drive.

### 4.4 Archivo adjunto
- Es obligatorio en el proceso de registro de gasto.
- Sin base64 no debe completarse registro.

### 4.5 Metodo de pago
- Se detecta por IA y se confirma/corrige con el usuario.
- Debe mapearse en GAS a columna T (metodo_pago).

---

## 5. Endpoints HTTP disponibles

### 5.1 Mensajeria base
- POST /v1/messages
- POST /v1/register
- POST /v1/samples

### 5.2 Campanas
- POST /v1/campain/retail
- POST /v1/campain/pl
- POST /v1/campain/carrileria
- POST /v1/campain/test

### 5.3 Informes
- POST /v1/informe/recordatorio
- POST /v1/informe/alerta36h
- POST /v1/informe/alerta48h
- POST /v1/informe/alertas

### 5.4 Recordatorio servicio
- POST /v1/recordatorio/servicio

### 5.5 Blacklist
- POST /v1/blacklist
- GET /v1/blacklist/list

---

## 6. Variables de entorno requeridas

Minimas para operar:
- JWT_TOKEN
- NUMBER_ID
- VERIFY_TOKEN
- PORT
- GEMINI_APIKEY
- GEMINI_MODEL
- DEBUG_AI
- RUC_EMPRESA

Recomendadas:
- RAZON_SOCIAL_EMPRESA (si no se define, usa "SVC")
- TIPO_CAMBIO_USD_PEN (si no se define, usa 3.8)
- SUBCONCEPTOS_URL (opcional, override de catalogo)

---

## 7. Integraciones externas

### 7.1 Meta WhatsApp API
Uso:
- envio de templates
- envio de botones interactivos
- envio de listas interactivas

### 7.2 Gemini
Uso:
- OCR/extraccion estructurada de comprobante.
- campos clave: tipo_gasto, fecha_pago, codigo_movimiento, monto, moneda, metodo_pago, proveedor, ruc, etc.

### 7.3 Apps Script (catalogos y registro de gasto)
Endpoints usados:
- getProyectos
- getUsuariosActivos
- getSucursal
- getConceptoSubconcepto
- registrarGasto

### 7.4 Webhook Google Sheets
Uso:
- registrar envios de campana.
- registrar respuestas del usuario en campanas/recordatorios.

---

## 8. Estructura principal del codigo

- src/app.js: bootstrap del bot, provider, rutas, queue.
- src/flows/: logica conversacional.
- src/routes/: endpoints HTTP de entrada al bot.
- src/services/: integraciones externas (Gemini, Apps Script, Meta, Sheets).
- src/normalizers/: reglas de transformacion de datos/payload.
- src/catalogs/: carga y transformacion de catalogos.
- src/config/: env y urls.
- src/state/: memoria temporal de sesiones y timers.
- src/utils/: helpers reutilizables.

---

## 9. Operacion local

Instalacion:
1. npm install

Ejecucion desarrollo:
1. npm run dev

Ejecucion produccion:
1. npm start

Notas:
- Si cambias .env, reiniciar proceso para recargar variables.
- En dev corre eslint antes de iniciar.

---

## 10. Checklist para persona entrante

1. Verificar acceso a Meta API (JWT, NUMBER_ID, VERIFY_TOKEN).
2. Verificar GEMINI_APIKEY activa y cuota disponible.
3. Verificar RUC_EMPRESA y RAZON_SOCIAL_EMPRESA en .env.
4. Validar endpoints Apps Script (catalogos y registrarGasto).
5. Confirmar en GAS que columna T mapea metodo_pago.
6. Confirmar en GAS que adjunto es obligatorio para registrar gasto.
7. Probar escenario Boleta end-to-end:
   - nomenclatura = RUC_EMPRESA-codigo
   - proveedor/ruc de empresa
   - archivo en Drive con nombre de nomenclatura
8. Probar escenario Factura end-to-end:
   - proveedor/ruc del PDF
   - nomenclatura ruc_proveedor-codigo
9. Probar escenario RH end-to-end:
   - nomenclatura numero_rh_codigo_pago
   - proveedor/ruc del RH
10. Probar comandos de cancelacion de flujo en pagos.

---

## 11. Riesgos y puntos de atencion

1. MemoryDB no persiste reinicios (estado de conversacion se pierde al reiniciar proceso).
2. Dependencia alta de disponibilidad de Apps Script y Gemini.
3. Cambios en templates de Meta pueden romper envios si nombre/language no coincide.
4. Extraccion IA puede requerir ajuste de prompt si cambian formatos de comprobantes.

---

## 12. Recomendaciones inmediatas

1. Versionar este documento junto con cambios de negocio.
2. Parametrizar timeout/concurrency queue via .env si se requiere ajuste operativo rapido.
3. Crear prueba de humo automatizada para flujo de pago (mock de Apps Script/Gemini).
4. Agregar dashboard simple de errores por endpoint y por tipo de flujo.
