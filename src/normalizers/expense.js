import { toNullableText } from '../utils/text.js'

export const normalizeExpenseType = (value = '') => {
    const normalized = String(value).toLowerCase()
    if (normalized.includes('factura')) return 'Factura'
    if (normalized.includes('honorarios')) return 'Recibo por Honorarios'
    return 'Boleta'
}

export const normalizeCurrency = (value = '') => {
    const normalized = String(value).toUpperCase()
    if (normalized.includes('USD') || normalized.includes('$')) return 'USD'
    if (normalized.includes('S/') || normalized.includes('PEN') || normalized.includes('SOLES')) return 'S/'
    return null
}

export const buildFallbackDescription = ({ tipoGasto, raw }) => {
    const notesText = Array.isArray(raw?.metadatos?.notas) ? raw.metadatos.notas.join(' - ') : null

    if (tipoGasto === 'Factura') {
        return (
            toNullableText(raw?.metadatos?.observaciones) ??
            toNullableText(notesText) ??
            'Factura procesada. No se identificaron lineas de detalle explicitas; revisar detalle comercial del documento.'
        )
    }

    if (tipoGasto === 'Recibo por Honorarios') {
        return (
            toNullableText(raw?.metadatos?.receptor_razon_social) ??
            toNullableText(raw?.metadatos?.beneficiario) ??
            'Recibo por honorarios procesado. Revisar persona beneficiaria del cobro en el comprobante.'
        )
    }

    return (
        toNullableText(raw?.metadatos?.receptor_razon_social) ??
        toNullableText(notesText) ??
        'Boleta procesada. Revisar destinatario o concepto principal indicado en el comprobante.'
    )
}
