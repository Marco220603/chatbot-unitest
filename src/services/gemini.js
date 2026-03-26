import { GEMINI_APIKEY, GEMINI_MODEL } from '../config/env.js'
import { dedupe } from '../utils/array.js'
import { debugAiLog } from '../utils/debug.js'
import { extractJsonFromText } from '../utils/json.js'
import { RECEIPT_EXTRACTION_PROMPT } from '../prompts/receipt-extraction.js'
import { normalizeReceiptFields, normalizeStrictReceiptPayload } from '../normalizers/receipt.js'

const normalizeGeminiMimeType = (mimeType = '') => {
    const normalized = String(mimeType).toLowerCase().trim()
    if (normalized === 'image/jpg') return 'image/jpeg'
    return normalized
}

export const analyzeReceiptWithGemini = async ({ fileUrl, mimeType, jwtToken, prefetchedBase64 = null }) => {
    if (!GEMINI_APIKEY) {
        throw new Error('No se encontro GEMINI_APIKEY en variables de entorno.')
    }

    let fileBase64 = prefetchedBase64

    if (!fileBase64) {
        const mediaResponse = await fetch(fileUrl, {
            headers: {
                Authorization: `Bearer ${jwtToken}`,
            },
        })

        if (!mediaResponse.ok) {
            throw new Error('No se pudo descargar el comprobante para su analisis.')
        }

        const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer())
        fileBase64 = mediaBuffer.toString('base64')
    }

    const safeMimeType = normalizeGeminiMimeType(mimeType)
    const candidateModels = dedupe([GEMINI_MODEL, 'gemini-2.0-flash', 'gemini-1.5-flash'])

    debugAiLog('input', {
        mimeType: safeMimeType,
        base64Length: fileBase64.length,
        candidateModels,
    })

    let geminiJson = null
    let lastError = null

    for (const model of candidateModels) {
        const geminiResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_APIKEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    generationConfig: {
                        temperature: 0,
                        responseMimeType: 'application/json',
                    },
                    contents: [
                        {
                            parts: [
                                { text: RECEIPT_EXTRACTION_PROMPT },
                                {
                                    inline_data: {
                                        mime_type: safeMimeType,
                                        data: fileBase64,
                                    },
                                },
                            ],
                        },
                    ],
                }),
            }
        )

        if (geminiResponse.ok) {
            geminiJson = await geminiResponse.json()
            debugAiLog('model_ok', { model })
            break
        }

        let errorBody = ''

        try {
            errorBody = await geminiResponse.text()
        } catch {
            errorBody = ''
        }

        let errorMessage = `HTTP ${geminiResponse.status}`

        try {
            const parsedError = errorBody ? JSON.parse(errorBody) : null
            errorMessage = parsedError?.error?.message ?? errorMessage
        } catch {
            if (errorBody) errorMessage = errorBody
        }

        lastError = `${model}: ${errorMessage}`
        debugAiLog('model_error', { model, errorMessage })
    }

    if (!geminiJson) {
        throw new Error(`Gemini no respondio correctamente durante el analisis. ${lastError ?? ''}`.trim())
    }

    const textResult = geminiJson?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text)
        .filter(Boolean)
        .join('\n')

    debugAiLog('raw_text_preview', textResult ? textResult.slice(0, 1200) : null)

    const directJsonText = typeof textResult === 'string' ? textResult.trim() : ''
    let parsed = null

    if (directJsonText.startsWith('{') && directJsonText.endsWith('}')) {
        try {
            parsed = JSON.parse(directJsonText)
        } catch {
            parsed = null
        }
    }

    if (!parsed) {
        parsed = extractJsonFromText(textResult)
    }

    debugAiLog('parsed_json', parsed)

    if (!parsed) {
        throw new Error('No se pudo interpretar la respuesta del analisis.')
    }

    if (Object.prototype.hasOwnProperty.call(parsed, 'tipo_gasto')) {
        const normalized = normalizeStrictReceiptPayload(parsed)
        debugAiLog('normalized_output', normalized)
        return normalized
    }

    const normalizedLegacy = normalizeReceiptFields(parsed)
    debugAiLog('normalized_output_legacy', normalizedLegacy)
    return normalizedLegacy
}
