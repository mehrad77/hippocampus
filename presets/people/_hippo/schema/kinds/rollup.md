---
behaviour: interaction
text: forbidden
counts_as_contact: true
data:
  with:
    kind: ref
    required: true
    description: Who the conversation was with.
  channel:
    kind: text
    description: Where (whatsapp, email, signal, call).
  lang:
    kind: text
    description: Language of the conversation (fa, en, tr, pt).
  messages_in:
    kind: number
    description: Messages they sent.
  messages_out:
    kind: number
    description: Messages the human sent.
  avg_words_out:
    kind: number
    description: Average words per message the human sent.
  emoji_out:
    kind: number
    description: Emoji the human used.
  reply_minutes:
    kind: number
    description: Median minutes the human took to reply.
  started_by:
    kind: enum
    values: [human, them]
    description: Who opened the conversation.
---
One conversation on one day, as numbers only: who it was with, where, how many messages each way, and the human's style (length, emoji, reply time). Send at most one per conversation per day. It carries no text at all, so nothing anyone said is stored; it only updates contact stats.

## Is
- 12 messages in, 9 out with a recruiter on email, in English, replies within the hour
- A short WhatsApp exchange with the landlord, opened by them

## Is not
- What was said or agreed (send a `moment`, or a `fact`)
- A first contact, a promise or a change in tone (that's a `moment`)
