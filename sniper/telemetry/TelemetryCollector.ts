import { TelemetryEvent } from "../types";

export class TelemetryCollector {
  private readonly events: TelemetryEvent[] = [];

  record(event: string, payload: Record<string, unknown>): void {
    this.events.push({
      event,
      timestamp: Math.floor(Date.now() / 1000),
      payload,
    });
  }

  flush(): TelemetryEvent[] {
    const snapshot = [...this.events];
    this.events.length = 0;
    return snapshot;
  }

  snapshot(): TelemetryEvent[] {
    return [...this.events];
  }
}
