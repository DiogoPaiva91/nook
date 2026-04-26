const { EventEmitter } = require("events");

class WorkerBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.subscribers = new Set();
  }

  emitEvent(workerId, kind, payload = {}) {
    const evt = { workerId, kind, payload, at: Date.now() };
    for (const sub of this.subscribers) {
      if (sub.workerId && sub.workerId !== workerId) continue;
      try { sub.send(evt); } catch {}
    }
  }

  attachSSE(res, { workerId } = {}) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const sub = {
      workerId: workerId || null,
      send: (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`),
    };
    this.subscribers.add(sub);

    const heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.subscribers.delete(sub);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);

    return sub;
  }
}

module.exports = new WorkerBus();
