import { FLYER_URL } from '../config/urls.js'
import { campainDataByNumber } from '../state/session.js'
import { registrarEnSheets } from '../services/google-sheets.js'

// Función para enviar campaña via template de Meta y registro en Sheets
async function enviarCampain(bot, adapterProvider, datosCampain, detalleCampain, templateName, headerImageUrl) {
    const { Cliente, ID_Cliente, Modelo, Serie, RRVV, Numero } = datosCampain

    if (!Numero) {
        console.error(`[CAMPAIN] Campo 'Numero' faltante o undefined. Body recibido:`, JSON.stringify(datosCampain))
        return { status: 'error', message: `Campo 'Numero' es requerido. Verificar el payload enviado desde GAS.` }
    }

    const numberClean = String(Numero).replace('+', '').replace(/\s/g, '')

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

// Endpoints: /v1/campain/retail, /v1/campain/pl, /v1/campain/carrileria, /v1/campain/test
export function registerCampaignRoutes(adapterProvider, handleCtx) {
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
}
