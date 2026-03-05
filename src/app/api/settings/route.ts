import { NextResponse } from "next/server";
import { setSetting, getSetting, getMaxConcurrent } from "@/lib/settings";
import { getDispatcher } from "@/lib/dispatcher";
import { z } from "zod/v4";

const updateSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

export async function GET() {
  const maxConcurrent = await getMaxConcurrent();
  const editorCommand = await getSetting("editorCommand");
  return NextResponse.json({ maxConcurrent, editorCommand });
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { key, value } = updateSettingSchema.parse(body);

    await setSetting(key, value);

    // If maxConcurrent changed, update the running dispatcher
    if (key === "maxConcurrent") {
      const dispatcher = getDispatcher();
      dispatcher.setMaxConcurrent(parseInt(value, 10));
    }

    return NextResponse.json({ success: true, key, value });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update setting" },
      { status: 500 }
    );
  }
}
