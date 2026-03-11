import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import dotenv from "dotenv"
dotenv.config()

const PORT = process.env.PORT ?? 3008
const IDLE_TIMEOUT = 35000 // 35 segundos de inactividad

// URL del webhook de Google Apps Script para registrar envíos
const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwksLwMI7M-RgphlPYYz9EXunhDJluNN1RBQ-nS5j71Nqf2HituNqlNvQo2XOjqe-Xf/exec'

// URL pública del flyer para campañas con imagen (PL)
const FLYER_URL = 'https://drive.google.com/uc?export=download&id=1IQBdGczI-DIBrlrIRl4RRUZq5QmJdFCK'

// Referencia global al provider para enviar mensajes desde timers
let providerRef = null

// Función helper para registrar en Google Sheets
async function registrarEnSheets(data) {
    try {
        await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        })
    } catch (err) {
        console.error('Error registrando en Google Sheets:', err)
    }
}

// Almacén temporal para datos de campaña por número
const campainDataByNumber = {}

// Almacén de timers de inactividad por número
const idleTimers = {}

/**
 * Inicia o reinicia el timer de inactividad para un número.
 * Cuando el timer expire (IDLE_TIMEOUT ms sin mensajes), ejecuta onExpire.
 */
function resetIdleTimer(numberClean, onExpire) {
    if (idleTimers[numberClean]) {
        clearTimeout(idleTimers[numberClean])
    }
    idleTimers[numberClean] = setTimeout(async () => {
        delete idleTimers[numberClean]
        try {
            await onExpire()
        } catch (err) {
            console.error(`[IDLE] Error en onExpire para ${numberClean}:`, err)
        }
    }, IDLE_TIMEOUT)
}

// function clearIdleTimer(numberClean) {
//     if (idleTimers[numberClean]) {
//         clearTimeout(idleTimers[numberClean])
//         delete idleTimers[numberClean]
//     }
// }

// Función para enviar campaña via template de Meta y registro en Sheets
// headerImageUrl es opcional — solo para templates que tienen header de imagen
async function enviarCampain(bot, adapterProvider, datosCampain, detalleCampain, templateName, headerImageUrl) {
    const { Cliente, ID_Cliente, Modelo, Serie, RRVV, Numero } = datosCampain
    const numberClean = Numero.replace('+', '').replace(/\s/g, '')

    try {
        // 1. Armar componentes del template
        const components = [
            {
                type: 'body',
                parameters: [
                    { type: 'text', text: String(Cliente) },
                    { type: 'text', text: String(Serie) },
                    { type: 'text', text: String(RRVV) }
                ]
            }
        ]

        // Si el template tiene header de imagen, agregarlo
        if (headerImageUrl) {
            components.unshift({
                type: 'header',
                parameters: [
                    { type: 'image', image: { link: headerImageUrl } }
                ]
            })
        }

        // 2. Enviar template de Meta
        const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)

        // Meta API puede retornar un Error sin lanzarlo — verificar
        if (templateResult instanceof Error) {
            const detail = templateResult?.response?.data?.error
            if (detail) {
                const err = new Error(detail.message || JSON.stringify(detail))
                err.response = templateResult.response
                throw err
            }
            throw templateResult
        }
        if (templateResult?.error) {
            throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))
        }

        console.log(`[CAMPAIN] Template '${templateName}' enviado a ${numberClean}`, JSON.stringify(templateResult))

        // 2. Guardar datos de campaña para los flujos de respuesta
        campainDataByNumber[numberClean] = {
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            detalle: detalleCampain,
            fecha: new Date().toISOString()
        }

        // 3. Registrar envío exitoso en Google Sheets
        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            estadoEnvio: 'ENVIADO',
            detalle: detalleCampain
        })

        return { status: 'enviado', message: `Template enviado a ${numberClean}` }

    } catch (error) {
        // Logear detalle completo del error de Meta API
        const metaError = error?.response?.data || error?.error || error
        console.error(`[CAMPAIN] Error enviando a ${numberClean}:`, error.message)
        console.error(`[CAMPAIN] Detalle Meta:`, JSON.stringify(metaError, null, 2))

        // Detectar si el error es por número sin WhatsApp
        const errorMsg = String(error.message || '').toLowerCase()
        const sinWhatsApp = errorMsg.includes('not a valid whatsapp') ||
            errorMsg.includes('recipient') ||
            errorMsg.includes('incapable')

        const estadoEnvio = sinWhatsApp ? 'SIN_WHATSAPP' : 'ERROR'

        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: numberClean,
            estadoEnvio,
            detalle: `${detalleCampain} - ${estadoEnvio}: ${error.message}`
        })

        return { status: sinWhatsApp ? 'sin_whatsapp' : 'error', message: error.message }
    }
}

// ========== FLOWS DE CAMPAÑA (por dispatch + gotoFlow) ==========

// Flow hijo: respuesta SÍ → pide ubicación/fecha y acumula mensajes con timer propio
const campainSiFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        // Inicializar acumulador de respuestas y fase
        campainData.responses = []
        campainData.phase = 'WAITING_UBICACION'

        await flowDynamic('Gracias por su respuesta ✅\n\n📍 ¿Podrías indicarnos la *ubicación y fecha del equipo*?')
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Si ya se procesó (timer expiró y limpió datos), salir del capture
        if (!campainData || campainData.phase !== 'WAITING_UBICACION') return

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)
        console.log(`[CAMPAIN-SI] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${campainData.responses.length})`)

        // Reiniciar timer de inactividad
        resetIdleTimer(numberClean, async () => {
            const data = campainDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_UBICACION') return

            const todasLasRespuestas = data.responses.join('\n')
            console.log(`[CAMPAIN-SI] Idle expirado para ${numberClean}. Respuestas: "${todasLasRespuestas}"`)

            // Registrar en Google Sheets
            await registrarEnSheets({
                type: 'RESPUESTA_SI',
                numero: data.numero,
                cliente: data.cliente,
                idCliente: data.idCliente,
                modelo: data.modelo,
                serie: data.serie,
                rrvv: data.rrvv,
                respuestaPregunta: todasLasRespuestas
            })

            // Enviar despedida directamente por el provider
            try {
                await providerRef.sendMessage(data.numero, '¡Gracias! Su información ha sido registrada correctamente. Un asesor se comunicará contigo pronto. 👋', {})
                console.log(`[CAMPAIN-SI] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[CAMPAIN-SI] Error enviando despedida:`, err)
            }

            // Limpiar datos
            delete campainDataByNumber[numberClean]
        })

        // Seguir esperando más mensajes
        return fallBack()
    })

// Flow hijo: respuesta NO → pregunta si desea asesor y acumula mensajes con timer propio
const campainNoFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        // Inicializar acumulador de respuestas y fase
        campainData.responses = []
        campainData.phase = 'WAITING_ASESOR'

        await flowDynamic([
            'Gracias por su respuesta ❌',
            '',
            '¿Desea ser contactado por un asesor?',
            '1️⃣ Sí, deseo ser contactado',
            '2️⃣ No, gracias'
        ].join('\n'))
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Si ya se procesó (timer expiró y limpió datos), salir del capture
        if (!campainData || campainData.phase !== 'WAITING_ASESOR') return

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)
        console.log(`[CAMPAIN-NO] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${campainData.responses.length})`)

        // Reiniciar timer de inactividad
        resetIdleTimer(numberClean, async () => {
            const data = campainDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_ASESOR') return

            const todasLasRespuestas = data.responses.join('\n').toLowerCase()
            let opcionTexto = todasLasRespuestas
            let mensajeDespedida = ''

            if (todasLasRespuestas.includes('1') || todasLasRespuestas.includes('sí') || todasLasRespuestas.includes('si')) {
                opcionTexto = 'Sí, desea ser contactado'
                mensajeDespedida = 'Entendido. Un asesor se comunicará contigo pronto. 📞'
            } else {
                opcionTexto = 'No desea ser contactado'
                mensajeDespedida = 'Entendido. ¡Gracias por su tiempo! 👋'
            }

            console.log(`[CAMPAIN-NO] Idle expirado para ${numberClean}. Opción: ${opcionTexto}`)

            // Registrar en Google Sheets
            await registrarEnSheets({
                type: 'RESPUESTA_NO',
                numero: data.numero,
                cliente: data.cliente,
                idCliente: data.idCliente,
                modelo: data.modelo,
                serie: data.serie,
                rrvv: data.rrvv,
                opcionContacto: opcionTexto,
                respuestaCompleta: data.responses.join('\n')
            })

            // Enviar despedida directamente por el provider
            try {
                await providerRef.sendMessage(data.numero, mensajeDespedida, {})
                console.log(`[CAMPAIN-NO] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[CAMPAIN-NO] Error enviando despedida:`, err)
            }

            // Limpiar datos
            delete campainDataByNumber[numberClean]
        })

        // Seguir esperando más mensajes
        return fallBack()
    })

// Flow principal unificado: captura botones de campaña y recordatorio_servicio
// Campaña: "Sí, programar" / "No, luego"
// Recordatorio: "Sí, programar visita" / "Tengo una consulta"
const campainResponseFlow = addKeyword(['Sí, programar', 'No, luego', 'Sí, programar visita', 'Tengo una consulta'])
    .addAction(async (ctx, { gotoFlow, flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const respuesta = ctx.body.trim().toLowerCase()

        // --- Recordatorio servicio ---
        const recData = recordatorioDataByNumber[numberClean]
        if (recData) {
            if (respuesta.includes('programar visita')) {
                console.log(`[RECORDATORIO] ${numberClean} eligió: Sí, programar visita`)

                await registrarEnSheets({
                    type: 'RESPUESTA_SI',
                    numero: recData.numero,
                    cliente: recData.cliente || '',
                    idCliente: recData.idCliente || '',
                    modelo: '',
                    serie: '',
                    rrvv: recData.rrvv || '',
                    respuestaPregunta: 'Sí, programar visita',
                    detalle: `Recordatorio Servicio - Programar visita`
                })

                await flowDynamic('✅ Gracias por tu confirmación. Un asesor se comunicará contigo pronto. 📞')
                delete recordatorioDataByNumber[numberClean]
                return
            }

            if (respuesta.includes('consulta')) {
                return gotoFlow(recordatorioConsultaFlow)
            }
        }

        // --- Campaña ---
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        if (respuesta.includes('sí') || respuesta.includes('si') || respuesta.includes('programar')) {
            return gotoFlow(campainSiFlow)
        }

        if (respuesta.includes('no') || respuesta.includes('luego')) {
            return gotoFlow(campainNoFlow)
        }
    })

// ========== FLOWS DE RECORDATORIO SERVICIO ==========

// Almacén temporal para datos de recordatorio por número
const recordatorioDataByNumber = {}

// Flow hijo: "Tengo una consulta" → captura mensajes con idle timer
const recordatorioConsultaFlow = addKeyword(EVENTS.ACTION)
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const recData = recordatorioDataByNumber[numberClean]
        if (!recData) return

        recData.responses = []
        recData.phase = 'WAITING_CONSULTA'

        await flowDynamic('📝 Por favor, cuéntanos tu consulta:')
    })
    .addAnswer(null, { capture: true }, async (ctx, { fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const recData = recordatorioDataByNumber[numberClean]

        if (!recData || recData.phase !== 'WAITING_CONSULTA') return

        recData.responses.push(ctx.body)
        console.log(`[RECORDATORIO-CONSULTA] Mensaje acumulado de ${numberClean}: "${ctx.body}" (total: ${recData.responses.length})`)

        resetIdleTimer(numberClean, async () => {
            const data = recordatorioDataByNumber[numberClean]
            if (!data || data.phase !== 'WAITING_CONSULTA') return

            const todasLasRespuestas = data.responses.join('\n')
            console.log(`[RECORDATORIO-CONSULTA] Idle expirado para ${numberClean}. Consulta: "${todasLasRespuestas}"`)

            await registrarEnSheets({
                type: 'RESPUESTA_SI',
                numero: data.numero,
                cliente: data.cliente || '',
                idCliente: data.idCliente || '',
                modelo: '',
                serie: '',
                rrvv: data.rrvv || '',
                respuestaPregunta: todasLasRespuestas,
                detalle: `Recordatorio Servicio - Consulta`
            })

            try {
                await providerRef.sendMessage(data.numero, '¡Gracias por tu consulta! Un asesor se comunicará contigo pronto. 📞', {})
                console.log(`[RECORDATORIO-CONSULTA] Despedida enviada a ${data.numero}`)
            } catch (err) {
                console.error(`[RECORDATORIO-CONSULTA] Error enviando despedida:`, err)
            }

            delete recordatorioDataByNumber[numberClean]
        })

        return fallBack()
    })

// ========== FLOWS DE INFORME – TEST ==========

// Número fijo para testing de informes
const NUMERO_TEST_INFORME = '51993011824'

// Flow que captura las respuestas de los botones de informe
const informeResponseFlow = addKeyword(['Ya lo envié', 'En proceso', 'Inconveniente', 'Ya regularicé', 'Justificación'])
    .addAction(async (ctx, { flowDynamic }) => {
        const respuesta = ctx.body.trim()
        console.log(`[INFORME] ${ctx.from} respondió: "${respuesta}"`)

        if (respuesta.includes('Ya lo envié') || respuesta.includes('Ya regularicé')) {
            await flowDynamic('✅ Gracias por confirmar. Tu respuesta ha sido registrada exitosamente.')
        } else if (respuesta.includes('En proceso')) {
            await flowDynamic('⏳ Entendido. Por favor indica la hora estimada de envío.')
        } else if (respuesta.includes('Inconveniente')) {
            await flowDynamic('⚠️ Entendido. Por favor especifica el inconveniente que presentas.')
        } else if (respuesta.includes('Justificación')) {
            await flowDynamic('📋 Entendido. Por favor envía tu justificación del retraso.')
        }
    })

// --- MAIN ---

const main = async () => {
    const adapterFlow = createFlow([campainResponseFlow, campainSiFlow, campainNoFlow, informeResponseFlow, recordatorioConsultaFlow])

    const adapterProvider = createProvider(Provider, {
        jwtToken: process.env.JWT_TOKEN,
        numberId: process.env.NUMBER_ID,
        verifyToken: process.env.VERIFY_TOKEN,
        version: 'v22.0',
    })
    // Guardar referencia global al provider para enviar mensajes desde timers
    providerRef = adapterProvider
    const adapterDB = new Database()

    // DEBUG: Interceptar TODAS las solicitudes entrantes
    adapterProvider.server.use((req, res, next) => {
        if (req.method === 'POST' && req.url.includes('webhook')) {
            console.log(`[DEBUG-WEBHOOK] ${req.method} ${req.url}`)
            console.log(`[DEBUG-WEBHOOK] Body:`, JSON.stringify(req.body, null, 2))
        }
        next()
    })

    // DEBUG: Log todos los mensajes entrantes del provider
    adapterProvider.on('message', (payload) => {
        console.log(`[DEBUG-MSG] Mensaje entrante:`, JSON.stringify(payload, null, 2))
    })

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    // ========== ENDPOINTS DE CAMPAÑA ==========

    // Retail → template 'minor'
    adapterProvider.server.post(
        '/v1/campain/retail',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña Retail', 'minor'
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // PL → template 'carrileria' (nombres cruzados en Meta) — tiene header IMAGE
    adapterProvider.server.post(
        '/v1/campain/pl',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña PL', 'carrileria',
                    FLYER_URL
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Carrilería → template 'pl' (nombres cruzados en Meta)
    adapterProvider.server.post(
        '/v1/campain/carrileria',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Campaña Carrilería', 'pl'
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Test → template 'carrileria' (tiene header IMAGE)
    adapterProvider.server.post(
        '/v1/campain/test',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Test', 'carrileria',
                    FLYER_URL
                )
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify(result))
            } catch (error) {
                console.error(error)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // ========== ENDPOINTS DE INFORME – TEST (número fijo) ==========

    // Caso 1: Recordatorio 24h → 3 botones
    adapterProvider.server.post(
        '/v1/informe/recordatorio',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie, fecha } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'
                const f = fecha || '28/02/2026'

                const texto = [
                    `Hola 👷‍♂️,`,
                    `Te recordamos que tienes pendiente el envío del informe del equipo *${ms}*, intervenido el *${f}*.`,
                    ``,
                    `⏳ *Plazo máximo:* 48 horas.`,
                    ``,
                    `Por favor confirmar tu situación:`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya lo envié' },
                    { body: 'En proceso' },
                    { body: 'Inconveniente' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Recordatorio 24h enviado a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'recordatorio_24h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error recordatorio:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Caso 2: Alerta 36h → 2 botones
    adapterProvider.server.post(
        '/v1/informe/alerta36h',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'

                const texto = [
                    `⚠️ *MENSAJE AUTOMÁTICO – 36 HORAS*`,
                    ``,
                    `Hola 👷‍♂️,`,
                    `El informe del equipo *${ms}* aún no figura como enviado.`,
                    ``,
                    `⚠️ Recuerda que el *plazo máximo es 48 horas*.`,
                    ``,
                    `Por favor regularizar hoy y confirmar envío.`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya lo envié' },
                    { body: 'En proceso' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Alerta 36h enviada a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'alerta_36h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error alerta 36h:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // Caso 3: Alerta 48h (CRÍTICA) → 2 botones
    adapterProvider.server.post(
        '/v1/informe/alerta48h',
        handleCtx(async (bot, req, res) => {
            try {
                const { modelo_serie } = req.body || {}
                const ms = modelo_serie || 'CAT 320F / SN12345'

                const texto = [
                    `🚨 *MENSAJE AUTOMÁTICO – 48 HORAS (ALERTA)*`,
                    ``,
                    `Hola 👷‍♂️,`,
                    `El informe del equipo *${ms}* ha superado el plazo establecido de *48 horas*.`,
                    ``,
                    `Se requiere *envío inmediato* y justificación del retraso.`,
                    ``,
                    `Por favor regularizar a la brevedad.`,
                ].join('\n')

                const buttons = [
                    { body: 'Ya regularicé' },
                    { body: 'Justificación' }
                ]

                const result = await adapterProvider.sendButtons(NUMERO_TEST_INFORME, buttons, texto)
                if (result instanceof Error) throw result
                if (result?.error) throw new Error(result.error.message || JSON.stringify(result.error))

                console.log(`[INFORME] Alerta 48h enviada a ${NUMERO_TEST_INFORME}`)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', tipo: 'alerta_48h', numero: NUMERO_TEST_INFORME }))
            } catch (error) {
                console.error('[INFORME] Error alerta 48h:', error.message)
                const detail = error?.response?.data || error
                console.error('[INFORME] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // ========== ENDPOINT DE RECORDATORIO SERVICIO ==========

    adapterProvider.server.post(
        '/v1/recordatorio/servicio',
        handleCtx(async (bot, req, res) => {
            try {
                const { telefono, cliente, idCliente, rrvv } = req.body || {}

                if (!telefono) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ status: 'error', message: 'Se requiere telefono' }))
                }

                const numberClean = telefono.replace('+', '').replace(/\s/g, '')

                // Enviar template sin parámetros
                const components = []
                const templateResult = await adapterProvider.sendTemplate(numberClean, 'recordatorio_servicio', 'es_ES', components)

                if (templateResult instanceof Error) {
                    const detail = templateResult?.response?.data?.error
                    if (detail) {
                        const err = new Error(detail.message || JSON.stringify(detail))
                        err.response = templateResult.response
                        throw err
                    }
                    throw templateResult
                }
                if (templateResult?.error) {
                    throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))
                }

                console.log(`[RECORDATORIO] Template 'recordatorio_servicio' enviado a ${numberClean}`, JSON.stringify(templateResult))

                // Guardar datos para los flows de respuesta
                recordatorioDataByNumber[numberClean] = {
                    numero: numberClean,
                    cliente: cliente || '',
                    idCliente: idCliente || '',
                    rrvv: rrvv || '',
                    fecha: new Date().toISOString()
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'enviado', numero: numberClean }))
            } catch (error) {
                console.error('[RECORDATORIO] Error:', error.message)
                const detail = error?.response?.data || error
                console.error('[RECORDATORIO] Detalle:', JSON.stringify(detail, null, 2))
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // ========== ENDPOINT DE ALERTAS DE INFORME (desde GAS) ==========

    adapterProvider.server.post(
        '/v1/informe/alertas',
        handleCtx(async (bot, req, res) => {
            try {
                const { telefono, datos } = req.body || {}

                if (!telefono || !Array.isArray(datos) || datos.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ status: 'error', message: 'Se requiere telefono y datos[]' }))
                }

                const numberClean = telefono.replace('+', '').replace(/\s/g, '')

                // Agrupar datos por tipo de Alerta
                const grupos = {}
                for (const item of datos) {
                    const alerta = (item.Alerta || '').trim().toLowerCase()
                    if (!grupos[alerta]) {
                        grupos[alerta] = { tecnico: item.Tecnico, items: [] }
                    }
                    grupos[alerta].items.push({ modelo: item.Modelo, serie: item.Serie })
                }

                // Mapeo alerta → nombre de template en Meta
                const templateMap = {
                    '24h': 'alerta',
                    '36h': 'alerta_36h',
                    '48h': 'alerta_48h',
                }

                const resultados = []

                for (const [alerta, grupo] of Object.entries(grupos)) {
                    const templateName = templateMap[alerta]
                    if (!templateName) {
                        // Ignorar alertas sin template (ej: '0h' de nuevos ingresos)
                        console.log(`[INFORME-ALERTA] Alerta '${alerta}' ignorada (sin template asignado)`)
                        resultados.push({ alerta, status: 'ignorado', message: `Alerta '${alerta}' sin template` })
                        continue
                    }

                    const tecnico = grupo.tecnico || 'Técnico'

                    // alerta_36h tiene 3 params: {{1}}=tecnico, {{2}}=modelo, {{3}}=serie
                    // Template muestra "equipo {{2}}-{{3}}", así que repartimos los equipos
                    // concatenados entre {{2}} y {{3}} para que el guion de la plantilla una al último
                    if (alerta === '36h') {
                        const items = grupo.items
                        const allButLast = items.slice(0, -1)
                        const last = items[items.length - 1]
                        const prefix = allButLast.map(e => `${e.modelo}-${e.serie}`).join(', ')
                        const param2 = prefix ? `${prefix}, ${last.modelo}` : last.modelo
                        const param3 = last.serie

                        const components = [
                            {
                                type: 'body',
                                parameters: [
                                    { type: 'text', text: String(tecnico) },
                                    { type: 'text', text: String(param2) },
                                    { type: 'text', text: String(param3) },
                                ]
                            }
                        ]

                        const equiposLog = items.map(e => `${e.modelo}-${e.serie}`).join(', ')
                        try {
                            const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)
                            if (templateResult instanceof Error) {
                                const detail = templateResult?.response?.data?.error
                                if (detail) { const err = new Error(detail.message || JSON.stringify(detail)); err.response = templateResult.response; throw err }
                                throw templateResult
                            }
                            if (templateResult?.error) throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))

                            console.log(`[INFORME-ALERTA] Template '${templateName}' enviado a ${numberClean} (equipos: ${equiposLog})`)
                            resultados.push({ alerta, templateName, status: 'enviado', equipos: equiposLog })
                        } catch (err) {
                            console.error(`[INFORME-ALERTA] Error enviando '${templateName}' a ${numberClean}:`, err.message)
                            resultados.push({ alerta, templateName, status: 'error', equipos: equiposLog, message: err.message })
                        }
                        continue
                    }

                    // alerta (24h) y alerta_48h tienen 2 params: {{1}}=tecnico, {{2}}=equipos concatenados
                    const equiposStr = grupo.items.map(e => `${e.modelo}-${e.serie}`).join(', ')

                    const components = [
                        {
                            type: 'body',
                            parameters: [
                                { type: 'text', text: String(tecnico) },
                                { type: 'text', text: String(equiposStr) },
                            ]
                        }
                    ]

                    try {
                        const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, 'es_PE', components)

                        if (templateResult instanceof Error) {
                            const detail = templateResult?.response?.data?.error
                            if (detail) {
                                const err = new Error(detail.message || JSON.stringify(detail))
                                err.response = templateResult.response
                                throw err
                            }
                            throw templateResult
                        }
                        if (templateResult?.error) {
                            throw new Error(templateResult.error.message || JSON.stringify(templateResult.error))
                        }

                        console.log(`[INFORME-ALERTA] Template '${templateName}' enviado a ${numberClean} (equipos: ${equiposStr})`)
                        resultados.push({ alerta, templateName, status: 'enviado', equipos: equiposStr })
                    } catch (err) {
                        console.error(`[INFORME-ALERTA] Error enviando '${templateName}' a ${numberClean}:`, err.message)
                        resultados.push({ alerta, templateName, status: 'error', message: err.message })
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'ok', numero: numberClean, resultados }))
            } catch (error) {
                console.error('[INFORME-ALERTA] Error general:', error.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ status: 'error', message: error.message }))
            }
        })
    )

    // ========== ENDPOINTS DE BLACKLIST ==========

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    adapterProvider.server.get(
        '/v1/blacklist/list',
        handleCtx(async (bot, req, res) => {
            const blacklist = bot.blacklist.getList()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', blacklist }))
        })
    )

    httpServer(+PORT)
}

main()
