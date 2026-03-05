import { prisma } from "./db";

const DEFAULTS: Record<string, string> = {
  maxConcurrent: "2",
  editorCommand: "code",
};

export async function getSetting(key: string): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key] ?? "";
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function getMaxConcurrent(): Promise<number> {
  const val = await getSetting("maxConcurrent");
  const num = parseInt(val, 10);
  return isNaN(num) || num < 1 ? 2 : Math.min(num, 10);
}
