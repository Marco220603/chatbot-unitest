import { RUC_EMPRESA, TIPO_CAMBIO_USD_PEN } from '../config/env.js'
import { toNullableText } from '../utils/text.js'
import { round2 } from '../utils/number.js'

export const buildNomenclatura = ({ analysis }) => {
    const tipoGasto = analysis?.tipoGasto
    const codigo = toNullableText(analysis?.codigoMovimiento)
    const rucDocumento = toNullableText(analysis?.ruc)

    let rucBase = RUC_EMPRESA
    if (tipoGasto === 'Factura' || tipoGasto === 'Recibo por Honorarios') {
        rucBase = rucDocumento ?? RUC_EMPRESA
    }

    if (!rucBase || !codigo) return null

    return `${rucBase} - ${codigo}`
}

export const mapTipoPayload = (tipoGasto) => {
    if (tipoGasto === 'Factura') return 'F'
    if (tipoGasto === 'Recibo por Honorarios') return 'RH'
    return 'B'
}

export const mapTipoMonedaPayload = (tipoMoneda) => {
    if (tipoMoneda === 'USD') return 'Dolar'
    if (tipoMoneda === 'S/') return 'Soles'
    return null
}

export const buildAppScriptPayload = ({ analysis, manual, attachment }) => {
    const now = new Date()
    const montoFinal = round2(analysis?.montoFinal)
    const igv = round2(analysis?.igv)
    const tipoMoneda = analysis?.tipoMoneda
    const montoSoles =
        tipoMoneda === 'USD'
            ? (montoFinal === null ? null : round2(montoFinal * TIPO_CAMBIO_USD_PEN))
            : montoFinal

    const lenguaje = analysis?.lenguaje ?? 'ESP'
    let archivoPdfNombre = attachment?.nombre ?? null

    if (lenguaje === 'ING' && archivoPdfNombre) {
        archivoPdfNombre = `INVOICE ${archivoPdfNombre}`
    }

    return {
        fecha_emision: analysis?.fechaPago ?? null,
        fecha_compra: analysis?.fechaPago ?? null,
        descripcion: analysis?.descripcion ?? null,
        usuario_gasto: manual?.responsable ?? null,
        tipo: mapTipoPayload(analysis?.tipoGasto),
        condicion: manual?.condicion ?? null,
        tipo_moneda: mapTipoMonedaPayload(tipoMoneda),
        rubro: manual?.rubro ?? null,
        proyecto: manual?.proyecto ?? null,
        distribucion: manual?.distribucionMaquinaria ?? null,
        pen_maquinaria: montoFinal,
        monto_total_original: montoFinal,
        monto_soles: montoSoles,
        IGV: igv,
        n_boleta_factura: analysis?.codigoMovimiento ?? null,
        concepto: manual?.concepto ?? null,
        mes: now.getMonth() + 1,
        'año': now.getFullYear(),
        subconcepto: manual?.subconcepto ?? null,
        provincia: manual?.provincia ?? null,
        proveedor: analysis?.proveedorRazonSocial ?? null,
        ruc: analysis?.ruc ?? null,
        nomenclatura: manual?.nomenclatura ?? null,
        responsable_gasto: manual?.responsable ?? null,
        responsable_pago: manual?.responsablePago ?? null,
        archivo_pdf_url: attachment?.url ?? null,
        archivo_pdf_nombre: archivoPdfNombre,
        archivo_pdf_mime_type: attachment?.mimeType ?? null,
        archivo_pdf_base64: attachment?.base64 ?? null,
        lenguaje,
    }
}
