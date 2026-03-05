import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, EVENTS, utils } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'

const PORT = process.env.PORT ?? 3008
const IDLE_TIMEOUT = 35000 // 35 segundos de inactividad

// URL del webhook de Google Apps Script para registrar envíos
const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwksLwMI7M-RgphlPYYz9EXunhDJluNN1RBQ-nS5j71Nqf2HituNqlNvQo2XOjqe-Xf/exec'

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

// Función para enviar campaña con validación de WhatsApp y registro en Sheets
async function enviarCampain(bot, adapterProvider, datosCampain, detalleCampain, mediaOptions) {
    const { Cliente, ID_Cliente, Modelo, Serie, RRVV, Numero, Mensaje } = datosCampain

    // 1. Verificar si el número tiene WhatsApp
    try {
        const sock = adapterProvider.vendor
        const numberClean = Numero.replace('+', '').replace(/\s/g, '')
        const jid = `${numberClean}@s.whatsapp.net`
        const [result] = await sock.onWhatsApp(jid)

        if (!result || !result.exists) {
            // El número NO tiene WhatsApp
            console.log(`[CAMPAIN] Número ${Numero} NO tiene WhatsApp`)
            await registrarEnSheets({
                type: 'ENVIO',
                cliente: Cliente,
                idCliente: ID_Cliente,
                modelo: Modelo,
                serie: Serie,
                rrvv: RRVV,
                numero: Numero,
                estadoEnvio: 'SIN_WHATSAPP',
                detalle: `${detalleCampain} - Número sin WhatsApp`
            })
            return { status: 'sin_whatsapp', message: `El número ${Numero} no tiene WhatsApp` }
        }

        // 2. El número SÍ tiene WhatsApp, enviar mensaje de campaña
        await bot.sendMessage(Numero, Mensaje, mediaOptions)
        console.log(`[CAMPAIN] Mensaje enviado a ${Numero}`)

        // 3. Guardar datos de campaña ANTES de dispatch
        campainDataByNumber[numberClean] = {
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: Numero,
            detalle: detalleCampain,
            fecha: new Date().toISOString()
        }

        // 4. Registrar envío exitoso
        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: Numero,
            estadoEnvio: 'ENVIADO',
            detalle: detalleCampain
        })

        // 5. Dispatch al flujo de respuesta de campaña (envía la pregunta y espera si/no)
        await bot.dispatch('CAMPAIN_RESPONSE', { from: Numero })
        console.log(`[CAMPAIN] Dispatch CAMPAIN_RESPONSE a ${Numero}`)

        return { status: 'enviado', message: `Mensaje enviado a ${Numero}` }

    } catch (error) {
        console.error(`[CAMPAIN] Error enviando a ${Numero}:`, error.message)

        // Registrar error en Google Sheets
        await registrarEnSheets({
            type: 'ENVIO',
            cliente: Cliente,
            idCliente: ID_Cliente,
            modelo: Modelo,
            serie: Serie,
            rrvv: RRVV,
            numero: Numero,
            estadoEnvio: 'ERROR',
            detalle: `${detalleCampain} - Error: ${error.message}`
        })

        return { status: 'error', message: error.message }
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

// Flow principal: punto de entrada vía bot.dispatch('CAMPAIN_RESPONSE')
// Envía la pregunta de inspección, captura si/no y redirige al flow correspondiente
const campainResponseFlow = addKeyword(utils.setEvent('CAMPAIN_RESPONSE'))
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        await flowDynamic([
            '¿Desea programar la inspección?',
            'Responda por favor:',
            '✅ *Sí*',
            '❌ *No*'
        ].join('\n'))
    })
    .addAnswer(null, { capture: true }, async (ctx, { gotoFlow, fallBack, flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]
        if (!campainData) return

        const respuesta = ctx.body.trim().toLowerCase()

        if (respuesta.includes('si') || respuesta.includes('sí') || respuesta === '1') {
            return gotoFlow(campainSiFlow)
        }

        if (respuesta.includes('no') || respuesta === '2') {
            return gotoFlow(campainNoFlow)
        }

        // Respuesta no reconocida → pedir de nuevo
        await flowDynamic('Por favor, responda *Sí* o *No*.')
        return fallBack()
    })

// --- MAIN ---

const main = async () => {
    const adapterFlow = createFlow([campainResponseFlow, campainSiFlow, campainNoFlow])

    const adapterProvider = createProvider(Provider,
        { version: [2, 3000, 1033927531] }
    )
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

    adapterProvider.server.post(
        '/v1/campain/retail',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot,
                    adapterProvider,
                    req.body,
                    'Campaña Retail',
                    {}
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

    adapterProvider.server.post(
        '/v1/campain/pl',
        handleCtx(async (bot, req, res) => {
            try {
                // Flyer solo para instalación PL
                const flyerPath = join(process.cwd(), 'assets', 'flyers', 'Flayer.jpeg')

                const result = await enviarCampain(
                    bot,
                    adapterProvider,
                    req.body,
                    'Campaña PL - Con Flyer',
                    { media: flyerPath }
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

    adapterProvider.server.post(
        '/v1/campain/carrileria',
        handleCtx(async (bot, req, res) => {
            try {
                const result = await enviarCampain(
                    bot,
                    adapterProvider,
                    req.body,
                    'Campaña Carrilería',
                    {}
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

    adapterProvider.server.post(
        '/v1/campain/test',
        handleCtx(async (bot, req, res) => {
            try {
                // Flyer solo para instalación PL
                const flyerPath = join(process.cwd(), 'assets', 'flyers', 'Flayer.jpeg')

                const result = await enviarCampain(
                    bot,
                    adapterProvider,
                    req.body,
                    'Test',
                    { media: flyerPath }
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
