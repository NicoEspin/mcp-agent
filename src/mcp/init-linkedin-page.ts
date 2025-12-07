// src/mcp/init-linkedin-page.ts
export default async ({ page }: any) => {
  const warmup =
    process.env.PLAYWRIGHT_MCP_WARMUP_URL ?? "https://www.linkedin.com/";
  try {
    await page.goto(warmup, { waitUntil: "domcontentloaded" });
  } catch {
    // silencioso: el warmup real también lo hacemos del lado del cliente
  }
};
