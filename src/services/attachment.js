export const downloadAttachmentAsBase64 = async ({ fileUrl, jwtToken }) => {
    if (!fileUrl) {
        throw new Error('No se recibio la URL del comprobante para convertir a base64.')
    }

    const response = await fetch(fileUrl, {
        headers: {
            Authorization: `Bearer ${jwtToken}`,
        },
    })

    if (!response.ok) {
        throw new Error(`No se pudo descargar el comprobante para base64. HTTP ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const base64 = buffer.toString('base64')

    if (!base64) {
        throw new Error('La conversion del comprobante a base64 devolvio vacio.')
    }

    return base64
}
