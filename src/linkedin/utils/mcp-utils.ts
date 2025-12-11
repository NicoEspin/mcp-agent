// src/linkedin/utils/mcp-utils.ts
export function extractTools(resp: any): any[] {
  return (
    resp?.tools ??
    resp?.result?.tools ??
    resp?.data?.tools ??
    resp?.payload?.tools ??
    []
  );
}

export function extractFirstText(result: any): string | null {
  if (!result) return null;

  if (typeof result === 'string') return result;

  const content =
    result?.content ??
    result?.result?.content ??
    result?.data?.content ??
    result?.payload?.content;

  if (Array.isArray(content)) {
    const textPart = content.find(
      (c: any) => c?.type === 'text' && typeof c?.text === 'string',
    );
    if (textPart) return textPart.text;
  }

  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.content === 'string') return result.content;

  return null;
}
