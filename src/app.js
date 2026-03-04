import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'

const PORT = process.env.PORT ?? 3008

// URL del webhook de Google Apps Script para registrar envíos
const GOOGLE_SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbwksLwMI7M-RgphlPYYz9EXunhDJluNN1RBQ-nS5j71Nqf2HituNqlNvQo2XOjqe-Xf/exec'

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

// Almacén temporal para datos de campaña por número (para rastrear respuestas SI/NO)
const campainDataByNumber = {}

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

        // 2. El número SÍ tiene WhatsApp, enviar mensaje
        await bot.sendMessage(Numero, Mensaje, mediaOptions)
        console.log(`[CAMPAIN] Mensaje enviado a ${Numero}`)

        // 3. Enviar pregunta de inspección
        await bot.sendMessage(Numero, [
            '¿Desea programar la inspección?',
            'Responda por favor:',
            '✅ *Sí*',
            '❌ *No*'
        ].join('\n'), {})
        console.log(`[CAMPAIN] Pregunta de inspección enviada a ${Numero}`)

        // 4. Guardar datos de campaña para rastrear respuesta SI/NO
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

// Flow para respuesta SÍ
const campainSiFlow = addKeyword(['si', 'sí'], { sensitive: false })
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Solo procesar si este número fue parte de una campaña
        if (!campainData) return

        // Inicializar acumulador de respuestas
        campainData.responses = []

        await flowDynamic('Gracias por su respuesta ✅\n\n📍 ¿Podrías indicarnos la *ubicación y fecha del equipo*?')
    })
    .addAnswer(null, { capture: true, idle: 35000 }, async (ctx, { flowDynamic, fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        if (!campainData) return

        // Si se agotó el tiempo de espera (35s sin mensajes), finalizar
        if (ctx?.idleFallBack) {
            const todasLasRespuestas = campainData.responses.join('\n')

            // Registrar respuesta SI con todas las respuestas acumuladas
            await registrarEnSheets({
                type: 'RESPUESTA_SI',
                numero: campainData.numero,
                cliente: campainData.cliente,
                idCliente: campainData.idCliente,
                modelo: campainData.modelo,
                serie: campainData.serie,
                rrvv: campainData.rrvv,
                respuestaPregunta: todasLasRespuestas
            })

            await flowDynamic('¡Gracias! Su información ha sido registrada correctamente. 👋')

            // Limpiar datos de campaña
            delete campainDataByNumber[numberClean]
            return
        }

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)

        // Volver a esperar más mensajes (el idle timer se reinicia)
        return fallBack()
    })

// Flow para respuesta NO
const campainNoFlow = addKeyword(['no'], { sensitive: false })
    .addAction(async (ctx, { flowDynamic }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        // Solo procesar si este número fue parte de una campaña
        if (!campainData) return

        // Inicializar acumulador de respuestas
        campainData.responses = []

        await flowDynamic([
            'Gracias por su respuesta ❌',
            '',
            '¿Desea ser contactado por un asesor?',
            '1️⃣ Sí, deseo ser contactado',
            '2️⃣ No, gracias'
        ].join('\n'))
    })
    .addAnswer(null, { capture: true, idle: 35000 }, async (ctx, { flowDynamic, fallBack }) => {
        const numberClean = ctx.from.replace('+', '').replace(/\s/g, '')
        const campainData = campainDataByNumber[numberClean]

        if (!campainData) return

        // Si se agotó el tiempo de espera (35s sin mensajes), finalizar
        if (ctx?.idleFallBack) {
            const todasLasRespuestas = campainData.responses.join('\n').toLowerCase()
            let opcionTexto = todasLasRespuestas

            // Analizar todas las respuestas acumuladas para determinar la intención
            if (todasLasRespuestas.includes('1') || todasLasRespuestas.includes('sí') || todasLasRespuestas.includes('si')) {
                opcionTexto = 'Sí, desea ser contactado'
                await flowDynamic('Entendido. Un asesor se comunicará con usted pronto. 📞')
            } else {
                opcionTexto = 'No desea ser contactado'
                await flowDynamic('Entendido. ¡Gracias por su tiempo! 👋')
            }

            // Registrar respuesta NO con la opción y todas las respuestas en Google Sheets
            await registrarEnSheets({
                type: 'RESPUESTA_NO',
                numero: campainData.numero,
                cliente: campainData.cliente,
                idCliente: campainData.idCliente,
                modelo: campainData.modelo,
                serie: campainData.serie,
                rrvv: campainData.rrvv,
                opcionContacto: opcionTexto,
                respuestaCompleta: campainData.responses.join('\n')
            })

            // Limpiar datos de campaña
            delete campainDataByNumber[numberClean]
            return
        }

        // Acumular el mensaje del cliente
        campainData.responses.push(ctx.body)

        // Volver a esperar más mensajes (el idle timer se reinicia)
        return fallBack()
    })

// --- MAIN ---

const main = async () => {
    const adapterFlow = createFlow([campainSiFlow, campainNoFlow])

    const adapterProvider = createProvider(Provider,
        { version: [2, 3000, 1033927531] }
    )
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
