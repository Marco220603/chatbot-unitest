export const toNumberOrNull = (value) => {
    if (value === undefined || value === null) return null
    if (typeof value === 'number' && Number.isFinite(value)) return value

    const raw = String(value).trim()
    if (!raw.length) return null

    let normalized = raw.replace(/[^\d,.-]/g, '')

    if (normalized.includes(',') && normalized.includes('.')) {
        const lastComma = normalized.lastIndexOf(',')
        const lastDot = normalized.lastIndexOf('.')

        if (lastComma > lastDot) {
            normalized = normalized.replace(/\./g, '').replace(',', '.')
        } else {
            normalized = normalized.replace(/,/g, '')
        }
    } else if (normalized.includes(',')) {
        normalized = normalized.replace(',', '.')
    }

    const number = Number(normalized)
    return Number.isFinite(number) ? number : null
}

export const round2 = (value) => {
    const number = toNumberOrNull(value)
    if (number === null) return null
    return Math.round((number + Number.EPSILON) * 100) / 100
}
