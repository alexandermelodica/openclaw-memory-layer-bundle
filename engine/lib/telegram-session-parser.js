const TELEGRAM_CONVERSATION_RE = /Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;
const TELEGRAM_SENDER_RE = /Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i;
const TELEGRAM_REPLIED_RE = /Replied message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;
const TELEGRAM_QUOTED_RE = /Quoted message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;
const TELEGRAM_FORWARDED_RE = /Forwarded message \(untrusted, for context\):\s*```json\s*([\s\S]*?)\s*```/gi;
const TELEGRAM_ATTACHMENT_RE = /(Document|Attachment|Photo|Video|Audio|Voice|Media) \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/gi;
const INJECTED_MEMORY_BLOCK_RE = /Relevant memory notes:\s*[\s\S]*?Use these only as supporting factual context\.[\s\S]*?(?:\n|$)/gi;
const INJECTED_RECENT_CHAT_BLOCK_RE = /Recent chat context:\s*[\s\S]*?Use this as recent local chat context\.[\s\S]*?(?:\n|$)/gi;
const INJECTED_DOCUMENT_HINT_RE = /Document-intake hint:[\s\S]*?Do not change model routing\.[\s\S]*?(?:\n|$)/gi;
const INJECTED_MEDIA_SEND_HINT_RE = /To send an image back, prefer the message tool[\s\S]*?(?:\n|$)/gi;

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
  const attachments = [];
  let attachmentMatch;
  while ((attachmentMatch = TELEGRAM_ATTACHMENT_RE.exec(rawText)) !== null) {
    const parsed = safeJsonParse(attachmentMatch[2]);
    if (parsed) {
      attachments.push({
        kind: attachmentMatch[1].toLowerCase(),
        metadata: parsed,
      });
    }
  }

  const cleanedText = rawText
    .replace(TELEGRAM_CONVERSATION_RE, "")
    .replace(TELEGRAM_SENDER_RE, "")
    .replace(TELEGRAM_REPLIED_RE, "")
    .replace(TELEGRAM_QUOTED_RE, "")
    .replace(TELEGRAM_FORWARDED_RE, "")
    .replace(TELEGRAM_ATTACHMENT_RE, "")
    .replace(INJECTED_MEMORY_BLOCK_RE, "")
    .replace(INJECTED_RECENT_CHAT_BLOCK_RE, "")
    .replace(INJECTED_DOCUMENT_HINT_RE, "")
    .replace(INJECTED_MEDIA_SEND_HINT_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    conversation,
    sender,
    attachments,
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

function inferAttachmentName(attachments) {
  for (const attachment of attachments || []) {
    const metadata = attachment?.metadata || {};
    const name =
      metadata.file_name ||
      metadata.filename ||
      metadata.name ||
      metadata.title ||
      metadata.original_name;
    if (name) {
      return String(name);
    }
  }
  return null;
}

function inferAttachmentMime(attachments) {
  for (const attachment of attachments || []) {
    const metadata = attachment?.metadata || {};
    const mime = metadata.mime_type || metadata.mime || metadata.content_type;
    if (mime) {
      return String(mime).toLowerCase();
    }
  }
  return null;
}

function detectDocumentSignal(text, attachments = []) {
  const normalized = normalizeForStorage(text).toLowerCase();
  const attachmentName = (inferAttachmentName(attachments) || "").toLowerCase();
  const mime = inferAttachmentMime(attachments) || "";
  const combined = `${normalized}\n${attachmentName}\n${mime}`;

  const specs = [
    {
      type: "ticket",
      label: "билет",
      tags: ["document", "ticket", "travel"],
      re: /\b(билет|ticket|boarding pass|посадочн|рейс|flight|pnr)\b/i,
      question: "Похоже, это билет или данные перелёта. Сохранить детали, проверить маршрут или собрать краткую сводку?"
    },
    {
      type: "booking",
      label: "бронь",
      tags: ["document", "booking", "travel"],
      re: /\b(бронь|booking|reservation|hotel|отель|airbnb|check-in|check out)\b/i,
      question: "Похоже, это бронь. Сохранить ключевые даты и сделать краткую выжимку по бронированию?"
    },
    {
      type: "route-sheet",
      label: "маршрутный лист",
      tags: ["document", "route-sheet", "travel"],
      re: /\b(маршрутн|itinerary|маршрут|route sheet|travel plan)\b/i,
      question: "Похоже, это маршрутный лист. Вытащить даты, сегменты маршрута и важные контрольные точки?"
    },
    {
      type: "invoice",
      label: "счёт или чек",
      tags: ["document", "invoice", "finance"],
      re: /\b(invoice|receipt|сч[её]т|чек|оплат|total|amount due)\b/i,
      question: "Похоже, это счёт или чек. Извлечь сумму, дату и контрагента?"
    },
    {
      type: "manual",
      label: "документация",
      tags: ["document", "documentation", "manual"],
      re: /\b(manual|documentation|docs|инструкц|документац|spec|runbook)\b/i,
      question: "Похоже, это документация. Заиндексировать в память, сделать краткую выжимку или выделить actionable шаги?"
    }
  ];

  for (const spec of specs) {
    if (spec.re.test(combined)) {
      return {
        detected: true,
        confidence: "high",
        type: spec.type,
        label: spec.label,
        tags: spec.tags,
        question: spec.question,
        attachmentName: attachmentName || null,
        mime: mime || null,
      };
    }
  }

  if (attachments.length > 0 || /\b(pdf|docx?|xlsx?|pptx?|jpg|jpeg|png)\b/i.test(combined)) {
    return {
      detected: true,
      confidence: "medium",
      type: "document",
      label: "документ",
      tags: ["document"],
      question: "Похоже, в чат пришёл документ. Нужна краткая выжимка, сохранение в память или разбор по действиям?",
      attachmentName: attachmentName || null,
      mime: mime || null,
    };
  }

  return {
    detected: false,
    confidence: "none",
    type: null,
    label: null,
    tags: [],
    question: null,
    attachmentName: attachmentName || null,
    mime: mime || null,
  };
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

function buildChatLogNote({ sessionEntry, conversation, sender, userText, docSignal }) {
  const cleanUser = stripLeadingMention(normalizeForStorage(userText));
  const senderLabel = sender?.name || conversation?.sender || sender?.label || "User";
  const subject = conversation?.group_subject || sessionEntry?.subject || sessionEntry?.label || "Telegram";
  const header = docSignal?.detected
    ? `Telegram chat message (${docSignal.label})`
    : "Telegram chat message";
  const body = [
    header,
    `Subject: ${subject}`,
    `Sender: ${normalizeForStorage(String(senderLabel))}`,
    `Message: ${cleanUser}`,
  ];

  if (docSignal?.detected && docSignal.question) {
    body.push(`Suggested follow-up: ${docSignal.question}`);
  }

  return {
    kind: docSignal?.detected ? "document_signal" : "chat_message",
    note: body.join("\n"),
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
  buildChatLogNote,
  detectDocumentSignal,
};
