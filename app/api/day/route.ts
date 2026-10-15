import { NextResponse } from "next/server";
import { buildDay } from "@/lib/data";
import type { IntensityId } from "@/lib/policy";

const INTENSITIES: IntensityId[] = ["rest", "light", "moderate", "vigorous"];

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const date = q.get("date") ?? "";
  const hour = Number(q.get("hour"));
  const intensity = q.get("intensity") as IntensityId;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return NextResponse.json({ error: "hour must be 0-23" }, { status: 400 });
  }
  if (!INTENSITIES.includes(intensity)) {
    return NextResponse.json({ error: `intensity must be one of ${INTENSITIES.join(", ")}` }, { status: 400 });
  }

  try {
    const day = await buildDay({
      placeId: q.get("place") ?? "boulder-high",
      date, hour, intensity,
      sensitive: q.get("sensitive") === "1",
    });
    return NextResponse.json(day);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not reach the AirNow feed" },
      { status: 502 },
    );
  }
}
