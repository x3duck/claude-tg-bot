export function topicTelegramUrl(botUrl, threadId) {
  if (!botUrl) return null
  const id = Number(threadId)
  return Number.isSafeInteger(id) && id > 0 ? `${botUrl.replace(/\/+$/, '')}/${id}` : botUrl
}
