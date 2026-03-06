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

// Flow principal: captura la respuesta de los botones del template
// Los botones del template son: "Sí, programar" / "No, luego"
const campainResponseFlow = addKeyword(['Sí, programar', 'No, luego'])
    .addAction(async (ctx, { gotoFlow }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        const respuesta = ctx.body.trim().toLowerCase()

        if (respuesta.includes('sí') || respuesta.includes('si') || respuesta.includes('programar')) {
            return gotoFlow(campainSiFlow)
        }

        if (respuesta.includes('no') || respuesta.includes('luego')) {
            return gotoFlow(campainNoFlow)
        }
    })

// --- MAIN ---

const main = async () => {
    const adapterFlow = createFlow([campainResponseFlow, campainSiFlow, campainNoFlow])

    const adapterProvider = createProvider(Provider, {
        jwtToken: process.env.JWT_TOKEN,
        numberId: process.env.NUMBER_ID,
        verifyToken: process.env.VERIFY_TOKEN,
        version: 'v22.0',
    })
    // Guardar referencia global al provider para enviar mensajes desde timers
    providerRef = adapterProvider
    const adapterDB = new Database()

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

    // Test → template 'pl' (sin header imagen)
    adapterProvider.server.post(
        '/v1/campain/test',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot, adapterProvider, req.body,
                    'Test', 'pl'
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
