// Several link transports seen as one (docs/10 C5): Bluetooth (or the browser-tab simulator)
// plus the internet bridge. The router just sees one set of links. If an extra transport (the
// bridge) fails to start, the main one keeps working.

import type { LinkTransport, LinkTransportEvents } from "./LinkTransport";

export class CompositeTransport implements LinkTransport {
  private owner = new Map<string, LinkTransport>();

  constructor(
    private readonly primary: LinkTransport,
    private readonly extras: LinkTransport[],
  ) {}

  get kind(): LinkTransport["kind"] {
    return this.primary.kind;
  }

  async start(events: LinkTransportEvents): Promise<void> {
    const wrap = (t: LinkTransport): LinkTransportEvents => ({
      linkUp: (info) => {
        this.owner.set(info.linkId, t);
        events.linkUp(info);
      },
      linkDown: (linkId) => {
        if (this.owner.get(linkId) === t) this.owner.delete(linkId);
        events.linkDown(linkId);
      },
      data: (linkId, frame) => events.data(linkId, frame),
      notice: t === this.primary ? events.notice : undefined,
    });
    await this.primary.start(wrap(this.primary));
    for (const t of this.extras) await t.start(wrap(t)).catch(() => {});
  }

  async stop(): Promise<void> {
    await Promise.all([this.primary, ...this.extras].map((t) => t.stop().catch(() => {})));
    this.owner.clear();
  }

  send(linkId: string, frame: Uint8Array): void {
    this.owner.get(linkId)?.send(linkId, frame);
  }
}
