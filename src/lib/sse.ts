export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

const FRAME_END = /\r?\n\r?\n/;

/** `text/event-stream` 본문을 메시지로 나눈다. 주석(heartbeat)만 있는 프레임은 건너뛴다. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = FRAME_END.exec(buffer); end; end = FRAME_END.exec(buffer)) {
      const message = parseFrame(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
      if (message) yield message;
    }
  }
}

function parseFrame(frame: string): SseMessage | null {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}
