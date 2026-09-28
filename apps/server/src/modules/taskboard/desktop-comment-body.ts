/** Format question replies at read time so historical events need no migration. */
export function desktopCommentBody(text: string): string {
  const match =
    /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(
      text,
    );
  if (!match) return text;
  try {
    const replies: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(replies) || replies.length === 0) return text;
    if (
      !replies.every(
        (reply) =>
          reply &&
          typeof reply === "object" &&
          typeof reply.question === "string" &&
          typeof reply.answer === "string",
      )
    )
      return text;
    return replies.map((reply) => `问题：${reply.question}\n\n回答：${reply.answer}`).join("\n\n");
  } catch {
    // Preserve unrecognized/user-authored text; never discard it on a parse error.
    return text;
  }
}
