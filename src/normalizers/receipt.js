import { toNullableText } from '../utils/text.js'
import { normalizeExpenseType, normalizeCurrency, buildFallbackDescription } from './expense.js'

export const normalizeReceiptFields = (raw = {}) => {
    const tipoGasto = normalizeExpenseType(raw.tipoGasto)
    const isFactura = tipoGasto === 'Factura'

    return {
        fechaPago: toNullableText(raw.fechaPago),
        codigoMovimiento: toNullableText(raw.codigoMovimiento),
        montoFinal: toNullableText(raw.montoFinal),
        tipoMoneda: normalizeCurrency(raw.tipoMoneda),
        tipoGasto,
        descripcion: toNullableText(raw.descripcion),
        lenguaje: raw.lenguaje === 'ING' ? 'ING' : 'ESP',
        proveedorRazonSocial: isFactura ? toNullableText(raw.proveedorRazonSocial) : null,
        ruc: isFactura ? toNullableText(raw.ruc) : null,
        igv: toNullableText(raw.igv),
    }
}

export const normalizeStrictReceiptPayload = (raw = {}) => {
    const tipoGastoRaw = String(raw?.tipo_gasto ?? '').toUpperCase()
    let tipoGasto = 'Boleta'

    if (tipoGastoRaw === 'FACTURA') tipoGasto = 'Factura'
    if (tipoGastoRaw === 'RECIBO_HONORARIOS') tipoGasto = 'Recibo por Honorarios'

    const isFactura = tipoGasto === 'Factura'

    return {
        fechaPago: toNullableText(raw?.fecha_pago),
        codigoMovimiento: toNullableText(raw?.codigo_movimiento),
        montoFinal: raw?.monto_final === null || raw?.monto_final === undefined ? null : String(raw.monto_final),
        tipoMoneda: raw?.moneda === 'PEN' ? 'S/' : raw?.moneda === 'USD' ? 'USD' : null,
        tipoGasto,
        descripcion: toNullableText(raw?.descripcion) ?? buildFallbackDescription({ tipoGasto, raw }),
        proveedorRazonSocial: isFactura ? toNullableText(raw?.proveedor_razon_social) : null,
        ruc: isFactura ? toNullableText(raw?.proveedor_ruc) : null,
        igv: raw?.igv === null || raw?.igv === undefined ? null : String(raw.igv),
        lenguaje: raw?.lenguaje === 'ING' ? 'ING' : 'ESP',
        metadatos: raw?.metadatos ?? null,
        confidence: raw?.confidence ?? null,
        evidencias: raw?.evidencias ?? null,
        warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
    }
}
