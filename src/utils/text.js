export const normalizeText = (value = '') =>
    String(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()

export const cleanNumber = (value = '') => String(value).replace('+', '').replace(/\s/g, '')

export const cutText = (value = '', max = 24) => {
    const text = String(value)
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(1, max - 3))}...`
}

export const toNullableText = (value) => {
    if (value === undefined || value === null) return null
    const text = String(value).trim()
    return text.length ? text : null
}
