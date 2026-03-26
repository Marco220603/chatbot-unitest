export const dedupe = (items = []) => [...new Set(items.filter(Boolean))]

export const chunk = (arr = [], size = 10) => {
    const result = []
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size))
    }
    return result
}

export const getArrayData = (payload) => {
    if (Array.isArray(payload)) return payload
    if (Array.isArray(payload?.data)) return payload.data
    return []
}
