const TELEGRAM_CONVERSATION_RE = /Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;
const TELEGRAM_SENDER_RE = /Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;
const TELEGRAM_REPLIED_RE = /Replied message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;
const TELEGRAM_QUOTED_RE = /Quoted message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;
const TELEGRAM_FORWARDED_RE = /Forwarded message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractMessageText(message) {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function extractTelegramMetadata(rawText) {
  const conversationMatch = rawText.match(TELEGRAM_CONVERSATION_RE);
  const senderMatch = rawText.match(TELEGRAM_SENDER_RE);
  const conversation = conversationMatch ? safeJsonParse(conversationMatch[1]) : null;
  const sender = senderMatch ? safeJsonParse(senderMatch[1]) : null;

  const cleanedText = rawText
    .replace(TELEGRAM_CONVERSATION_RE, "")
    .replace(TELEGRAM_SENDER_RE, "")
    .replace(TELEGRAM_REPLIED_RE, "")
    .replace(TELEGRAM_QUOTED_RE, "")
    .replace(TELEGRAM_FORWARDED_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    conversation,
    sender,
    cleanedText,
  };
}

function getTelegramSessionScope(sessionEntry, conversation) {
  if (conversation?.is_group_chat || sessionEntry?.chatType === "group" || sessionEntry?.groupId) {
    return "chat";
  }
  if (conversation?.sender_id || sessionEntry?.userId) {
    return "user";
  }
  return "global";
}

function deriveChatId(sessionEntry, conversation) {
  if (sessionEntry?.groupId) {
    return String(sessionEntry.groupId);
  }
  const originTo = sessionEntry?.origin?.to;
  if (originTo && String(originTo).startsWith("telegram:")) {
    return String(originTo).slice("telegram:".length);
  }
  const label = conversation?.conversation_label;
  const match = typeof label === "string" ? label.match(/id:([-\d]+)/) : null;
  return match ? match[1] : null;
}

function deriveUserId(sessionEntry, conversation, sender) {
  return (
    (conversation?.sender_id != null ? String(conversation.sender_id) : null) ||
    (sender?.id != null ? String(sender.id) : null) ||
    (sessionEntry?.userId != null ? String(sessionEntry.userId) : null)
  );
}

function deriveThreadId(_sessionEntry, conversation) {
  if (conversation?.topic_id != null) {
    return String(conversation.topic_id);
  }
  if (conversation?.thread_id != null) {
    return String(conversation.thread_id);
  }
  return null;
}

function normalizeForStorage(text) {
  return text.replace(/\s+/g, " ").trim();
}

function stripLeadingMention(text) {
  return text.replace(/^@\S+\s+/u, "").trim();
}

function classifyTurnKind(userText, assistantText) {
  const joined = `${userText}\n${assistantText}`.toLowerCase();
  if (/(предпочитаю|по умолчанию|говори со мной|обращайся|хочу,? чтобы|нравится)/i.test(joined)) {
    return "preference";
  }
  if (/(решили|делаем|зафиксир|будет так|оставляем|пусть будет|используем)/i.test(joined)) {
    return "decision";
  }
  if (/(календар|встреч|брифинг|напомн|завтра|сегодня|недел)/i.test(joined)) {
    return "schedule";
  }
  if (/(доступ|подключ|настро|интеграц|работает|не работает|ошибк|таймаут|лог)/i.test(joined)) {
    return "fact";
  }
  return "turn";
}

function isWorthKeeping(userText, assistantText) {
  const user = normalizeForStorage(userText);
  const assistant = normalizeForStorage(assistantText);
  const joined = `${user}\n${assistant}`.toLowerCase();

  if (!user || !assistant) {
    return false;
  }

  if (user.length < 8 || assistant.length < 8) {
    return false;
  }

  if (assistant.length < 18 && !/(да|нет|ок|готово|работает)/i.test(assistant)) {
    return false;
  }

  if (/(проверка связи|тест|ok\b|ping\b)/i.test(joined)) {
    return false;
  }

  return /(предпочитаю|по умолчанию|решили|делаем|зафиксир|нужно|хочу|доступ|подключ|настро|интеграц|календар|брифинг|памят|контекст|ошибк|таймаут|работает|не работает|задач|проект|бот)/i.test(
    joined,
  );
}

function buildMemoryNote({ sessionEntry, conversation, sender, userText, assistantText }) {
  const cleanUser = stripLeadingMention(normalizeForStorage(userText));
  const cleanAssistant = normalizeForStorage(assistantText);
  const senderLabel = sender?.name || conversation?.sender || sender?.label || "User";
  const subject = conversation?.group_subject || sessionEntry?.subject || sessionEntry?.label || "Telegram";
  const kind = classifyTurnKind(cleanUser, cleanAssistant);

  const note = [
    `Telegram ${kind} note`,
    `Subject: ${subject}`,
    `Sender: ${normalizeForStorage(String(senderLabel))}`,
    `User: ${cleanUser}`,
    `Assistant: ${cleanAssistant}`,
  ].join("\n");

  return {
    kind,
    note,
  };
}

module.exports = {
  extractMessageText,
  extractTelegramMetadata,
  getTelegramSessionScope,
  deriveChatId,
  deriveUserId,
  deriveThreadId,
  isWorthKeeping,
  buildMemoryNote,
};
