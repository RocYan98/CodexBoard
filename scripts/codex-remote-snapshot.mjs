// Tool media can account for hundreds of MiB in an old Desktop conversation.
// The web view renders text and media metadata, never these embedded bytes.
// Keep Desktop's original state intact for patches, approvals and actions.
function withoutMediaBytes(value) {
  if (typeof value === "string" && /^data:(?:image|audio|video)\//i.test(value))
    return "[媒体内容请在桌面查看]";
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutMediaBytes);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "data" && ["image", "audio", "video"].includes(value.type)
        ? ""
        : withoutMediaBytes(entry),
    ]),
  );
}

export function remoteSnapshot(state) {
  const turn = (value) => ({
    ...value,
    items: value.items?.map((item) =>
      ["mcpToolCall", "dynamicToolCall"].includes(item.type) ? withoutMediaBytes(item) : item,
    ),
  });
  return {
    ...state,
    turns: state.turns?.map(turn),
    ...(state.turnHistory?.kind === "canonical"
      ? {
          turnHistory: {
            ...state.turnHistory,
            history: {
              ...state.turnHistory.history,
              entitiesByKey: Object.fromEntries(
                Object.entries(state.turnHistory.history.entitiesByKey).map(([key, value]) => [
                  key,
                  turn(value),
                ]),
              ),
            },
          },
        }
      : {}),
  };
}
