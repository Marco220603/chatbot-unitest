import { createBot, createProvider, createFlow } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'

// Config
import { PORT, JWT_TOKEN, NUMBER_ID, VERIFY_TOKEN } from './config/env.js'

// State
import { setProviderRef } from './state/session.js'

// Flows
import { startConversationFlow } from './flows/payment.js'
import { campainResponseFlow } from './flows/campaign-response.js'
import { campainSiFlow } from './flows/campaign-si.js'
import { campainNoFlow } from './flows/campaign-no.js'
import { informeResponseFlow } from './flows/informe-response.js'
import { recordatorioConsultaFlow } from './flows/recordatorio-consulta.js'

// Routes
import { registerMessageRoutes } from './routes/messages.js'
import { registerCampaignRoutes } from './routes/campaign.js'
import { registerInformeRoutes } from './routes/informe.js'
import { registerRecordatorioRoutes } from './routes/recordatorio.js'
import { registerBlacklistRoutes } from './routes/blacklist.js'

const main = async () => {
    const adapterFlow = createFlow([
        startConversationFlow,
        campainResponseFlow,
        campainSiFlow,
        campainNoFlow,
        informeResponseFlow,
        recordatorioConsultaFlow,
    ])

    const adapterProvider = createProvider(Provider, {
        jwtToken: JWT_TOKEN,
        numberId: NUMBER_ID,
        verifyToken: VERIFY_TOKEN,
        version: 'v22.0',
    })

    // Guardar referencia global al provider para enviar mensajes desde timers
    setProviderRef(adapterProvider)

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

    const { handleCtx, httpServer } = await createBot(
        {
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        },
        {
            queue: {
                timeout: 20000,
                concurrencyLimit: 50,
            },
        }
    )

    // Registrar todas las rutas HTTP
    registerMessageRoutes(adapterProvider, handleCtx)
    registerCampaignRoutes(adapterProvider, handleCtx)
    registerInformeRoutes(adapterProvider, handleCtx)
    registerRecordatorioRoutes(adapterProvider, handleCtx)
    registerBlacklistRoutes(adapterProvider, handleCtx)

    httpServer(+PORT)
}

main()
