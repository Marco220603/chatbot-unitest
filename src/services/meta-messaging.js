import { MAX_META_LIST_ROWS } from '../config/env.js'
import { cutText } from '../utils/text.js'
import { chunk } from '../utils/array.js'
import { debugAiLog } from '../utils/debug.js'
import { getProviderRef } from '../state/session.js'

export const sendMetaListChunks = async ({ to, header, bodyText, buttonText, sectionPrefix, rows, flowDynamic }) => {
    const providerRef = getProviderRef()
    if (!providerRef?.sendList || !rows.length) return false

    const chunks = chunk(rows, MAX_META_LIST_ROWS)

    try {
        for (let i = 0; i < chunks.length; i++) {
            const listPayload = {
                header: { type: 'text', text: cutText(`${header} ${i + 1}/${chunks.length}`, 60) },
                body: { text: bodyText },
                footer: { text: 'Selecciona una opcion del menu.' },
                action: {
                    button: buttonText,
                    sections: [
                        {
                            title: `${sectionPrefix} ${i + 1}`,
                            rows: chunks[i].map((row) => ({
                                id: row.id,
                                title: row.title,
                                description: row.description || '-',
                            })),
                        },
                    ],
                },
            }

            await providerRef.sendList(to, listPayload)
        }

        if (chunks.length > 1) {
            await flowDynamic(`Te enviamos ${chunks.length} listas para que puedas elegir.`)
        }

        return true
    } catch (error) {
        debugAiLog('send_list_error', error?.message ?? error)
        return false
    }
}

export const sendMetaButtonsSafe = async ({ to, text, buttons }) => {
    const providerRef = getProviderRef()
    if (!providerRef?.sendButtons) return false

    try {
        await providerRef.sendButtons(
            to,
            buttons.map((body) => ({ body })),
            text
        )
        return true
    } catch (error) {
        debugAiLog('send_buttons_error', error?.message ?? error)
        return false
    }
}

export const unwrapTemplateError = (templateResult) => {
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
}

export const sendTemplateWithFallback = async ({ adapterProvider, numberClean, templateCandidates, languageCandidates, components }) => {
    const tried = []
    let lastError = null

    for (const templateName of templateCandidates) {
        for (const language of languageCandidates) {
            tried.push(`${templateName}:${language}`)
            try {
                const templateResult = await adapterProvider.sendTemplate(numberClean, templateName, language, components)
                unwrapTemplateError(templateResult)
                return { templateName, language, templateResult, tried }
            } catch (error) {
                lastError = error
            }
        }
    }

    const finalError = new Error(lastError?.message || 'No se pudo enviar ningun template candidato.')
    finalError.tried = tried
    if (lastError?.response) finalError.response = lastError.response
    throw finalError
}
