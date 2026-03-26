import { addKeyword } from '@builderbot/bot'

// Número fijo para testing de informes
export const NUMERO_TEST_INFORME = '51993011824'

// Flow que captura las respuestas de los botones de informe
export const informeResponseFlow = addKeyword(['Ya lo envié', 'En proceso', 'Inconveniente', 'Ya regularicé', 'Justificación'])
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
