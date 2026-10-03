import { describe, expect, it } from "vitest";
import { parseSse } from "../src/lib/sse.js";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect(...parts: string[]) {
  const messages = [];
  for await (const message of parseSse(chunks(...parts))) messages.push(message);
  return messages;
}

describe("parseSse", () => {
  it("id_event_data_를_메시지_하나로_묶는다", async () => {
    expect(await collect('id: 7\nevent: logs\ndata: [{"a":1}]\n\n')).toEqual([
      { id: "7", event: "logs", data: '[{"a":1}]' },
    ]);
  });

  it("청크_경계에_걸친_프레임도_이어_붙인다", async () => {
    const messages = await collect("id: 1\nev", "ent: logs\nda", "ta: x\n", "\nid: 2\ndata: y\n\n");

    expect(messages).toEqual([
      { id: "1", event: "logs", data: "x" },
      { id: "2", event: "message", data: "y" },
    ]);
  });

  it("주석_heartbeat_만_있는_프레임은_건너뛴다", async () => {
    expect(await collect(": keep-alive\n\n", "event: logs\ndata: z\n\n")).toEqual([
      { id: undefined, event: "logs", data: "z" },
    ]);
  });

  it("CRLF_줄바꿈과_여러_data_줄을_처리한다", async () => {
    expect(await collect("event: logs\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([
      { id: undefined, event: "logs", data: "a\nb" },
    ]);
  });

  it("끝나지_않은_프레임은_버린다", async () => {
    expect(await collect("event: logs\ndata: partial")).toEqual([]);
  });
});
