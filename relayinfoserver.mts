import WebSocket from "ws";
import {Filter, signEvent} from "nostr-tools";
import {matchFilters, getEventHash} from "nostr-tools";
import {search} from "./search.mjs";
import {IncomingMessage, Server, ServerResponse} from "http";

const allowGlobalSubscriptions = process.argv.includes(
  "--allow-global-subscriptions"
);
const allowContinuingSubscriptions = process.argv.includes(
  "--allow-continuing-subscriptions"
);

import {generatePrivateKey, getPublicKey} from "nostr-tools";

export class RelayInfoServer {
  wss: WebSocket.Server;
  subs: Map<string, Filter[]> = new Map();
  connections: Set<WebSocket> = new Set();
  totalSubscriptions = 0;
  lastCreatedAtAndRelayIndicesPerPubkey: Map<string, [number, number[]]>;
  lastCreatedAtAndMetadataPerPubkey: Map<string, [number, string]>;
  lastCreatedAtAndContactsPerPubkey: Map<string, [number, string]>;
  allWriteRelays: any[];
  stats: any[];
  errors: [string, any][];
  followers: Map<string, string[]>;
  authors: [string, string, number][];
  serverPubKeyHex: string;
  serverPrivateKeyHex: string;
  signatureCache: Map<string, string> = new Map();

  #emitEventForAuthor(
    ws: WebSocket.WebSocket,
    sub: string,
    author: string,
    filter: any
  ) {
    if (!filter.kinds || filter.kinds.includes(0)) {
      const last = this.lastCreatedAtAndMetadataPerPubkey.get(author);
      if (last && (!filter.since || filter.since <= last[0])) {
        try {
          ws.send('["EVENT",' + JSON.stringify(sub) + "," + last[1] + "]");
        } catch (err) {}
      }
    }
    if (!filter.kinds || filter.kinds.includes(3)) {
      const last = this.lastCreatedAtAndContactsPerPubkey.get(author);
      if (last && (!filter.since || filter.since <= last[0])) {
        try {
          ws.send('["EVENT",' + JSON.stringify(sub) + "," + last[1] + "]");
        } catch (err) {}
      }
    }
  }

  #emitWriteRelaysEventForAuthor(
    ws: WebSocket.WebSocket,
    sub: string,
    author: string,
    since: number | undefined
  ): boolean {
    const last = this.lastCreatedAtAndRelayIndicesPerPubkey.get(author);
    if (last && (!since || since <= last[0])) {
      let event = {
        id: "",
        kind: 10003,
        pubkey: this.serverPubKeyHex,
        tags: [["p", author]],
        created_at: last[0],
        content: JSON.stringify(last[1].map((i) => this.allWriteRelays[i])),
        sig: "",
      };
      event.id = getEventHash(event);
      if (this.signatureCache.has(event.id)) {
        event.sig = this.signatureCache.get(event.id)!;
      } else {
        event.sig = signEvent(event, this.serverPrivateKeyHex);
        this.signatureCache.set(event.id, event.sig);
      }
      let eventJSON = JSON.stringify(["EVENT", sub, event]);
      try {
        ws.send(eventJSON);
      } catch (err) {
        return false;
      }
      return true;
    }
    return false;
  }

  constructor(
    server: Server<typeof IncomingMessage, typeof ServerResponse> | undefined,
    port: number,
    host: string,
    lastCreatedAtAndRelayIndicesPerPubkey: Map<string, [number, number[]]>,
    lastCreatedAtAndMetadataPerPubkey: Map<string, [number, string]>,
    lastCreatedAtAndContactsPerPubkey: Map<string, [number, string]>,
    allWriteRelays: any[],
    stats: any[],
    errors: [string, any][],
    followers: Map<string, string[]>,
    authors: [string, string, number][]
  ) {
    this.lastCreatedAtAndRelayIndicesPerPubkey =
      lastCreatedAtAndRelayIndicesPerPubkey;
    this.lastCreatedAtAndMetadataPerPubkey = lastCreatedAtAndMetadataPerPubkey;
    this.lastCreatedAtAndContactsPerPubkey = lastCreatedAtAndContactsPerPubkey;
    this.allWriteRelays = allWriteRelays;
    this.stats = stats;
    this.errors = errors;
    this.followers = followers;
    this.authors = authors;
    this.serverPrivateKeyHex = generatePrivateKey();
    this.serverPubKeyHex = getPublicKey(this.serverPrivateKeyHex);

    if (server) {
      this.wss = new WebSocket.Server({server, perMessageDeflate: true});
      console.log("RelayInfoServer listening on the same port as the server");
    } else {
      this.wss = new WebSocket.Server({port, host, perMessageDeflate: true});
      console.log("RelayInfoServer listening on ws://" + host + ":" + port);
    }
    this.wss.on("connection", (ws) => {
      this.connections.add(ws);
      ws.on("message", (message) => {
        const start = performance.now();
        let data;
        try {
          data = JSON.parse(message.toString());
        } catch (e) {
          ws.send(
            JSON.stringify(["NOTICE", "invalid json:", message.toString()])
          );
        }
        try {
          if (data && data[0] === "REQ") {
            const sub = data[1];
            const filters = data.slice(2);
            this.totalSubscriptions++;
            this.subs.set(sub, filters);
            for (const filter of filters) {
              if (filter.kinds && !Array.isArray(filter.kinds)) {
                continue;
              }
              if (
                Array.isArray(filter["#p"]) &&
                (!filter.kinds ||
                  filter.kinds.includes(3) ||
                  filter.kinds.includes(10003))
              ) {
                let limit = 200;
                if (filter.limit && filter.limit < 200) {
                  limit = filter.limit;
                }
                let count = 0;
                for (const author of filter["#p"]) {
                  if (!filter.kinds || filter.kinds.includes(3)) {
                    for (const follower of followers.get(author) || []) {
                      if (count >= limit) {
                        break;
                      }
                      const contactList =
                        lastCreatedAtAndContactsPerPubkey.get(follower);
                      if (
                        contactList &&
                        contactList[1] &&
                        (!filter.since || filter.since <= contactList[0])
                      ) {
                        try {
                          ws.send(
                            '["EVENT",' +
                              JSON.stringify(sub) +
                              "," +
                              contactList[1] +
                              "]"
                          );
                          count++;
                        } catch (err) {}
                      }
                    }
                  }
                  if (count >= limit) {
                    break;
                  }

                  if (!filter.kinds || filter.kinds.includes(10003)) {
                    if (
                      this.#emitWriteRelaysEventForAuthor(
                        ws,
                        sub,
                        author,
                        filter.since
                      )
                    ) {
                      count++;
                    }
                  }
                }
              } else if (typeof filter.search === "string") {
                if (!filter.kinds || filter.kinds.includes(0)) {
                  for (const r of search(
                    filter.search,
                    this.authors,
                    this.lastCreatedAtAndMetadataPerPubkey
                  )) {
                    ws.send(
                      '["EVENT",' + JSON.stringify(sub) + "," + r[1] + "]"
                    );
                  }
                }
              } else {
                if (
                  filter.kinds &&
                  !filter.kinds.includes(10003) &&
                  !filter.kinds.includes(0) &&
                  !filter.kinds.includes(3)
                ) {
                  continue;
                }
                if (filter.authors && Array.isArray(filter.authors)) {
                  for (const author of filter.authors) {
                    this.#emitEventForAuthor(ws, sub, author, filter);
                  }
                } else if (allowGlobalSubscriptions) {
                  const authors = new Set(
                    Array.from(
                      lastCreatedAtAndRelayIndicesPerPubkey.keys()
                    ).concat(
                      Array.from(
                        lastCreatedAtAndMetadataPerPubkey.keys()
                      ).concat(
                        Array.from(lastCreatedAtAndContactsPerPubkey.keys())
                      )
                    )
                  );
                  for (const author of authors) {
                    this.#emitEventForAuthor(ws, sub, author, filter);
                  }
                }
              }
            }
            ws.send(JSON.stringify(["EOSE", sub]));
          } else if (data && data[0] === "EVENT") {
            if (!allowContinuingSubscriptions) {
              return;
            }
            for (let [sub, filters] of this.subs.entries()) {
              if (matchFilters(filters, data[2])) {
                ws.send(JSON.stringify(["EVENT", sub, data[2]]));
              }
            }
          } else if (data && data[0] === "CLOSE") {
            const sub = data[1];
            this.subs.delete(sub);
          } else if (data && data[0] === "COUNT") {
            const sub = data[1];
            const filters = data.slice(2);
            const counts = [];
            for (const filter of filters) {
              if (
                filter &&
                Array.isArray(filter.kinds) &&
                filter.kinds.length === 1 &&
                filter.kinds[0] === 3 &&
                filter["#p"]
              ) {
                if (
                  Array.isArray(filter.group_by) &&
                  filter.group_by.length === 1 &&
                  filter.group_by[0] === "pubkey"
                ) {
                  if (filter["#p"].length === 1) {
                    const fs =
                      followers.get(filter["#p"][0])?.slice(0, 1000) || [];
                    counts.push(fs.map((f) => ({pubkey: f, count: 1})));
                  } else {
                    const byPubKey = new Map();
                    for (const pubkey of filter["#p"]) {
                      for (const follower of followers.get(pubkey) || []) {
                        byPubKey.set(
                          follower,
                          (byPubKey.get(follower) || 0) + 1
                        );
                      }
                    }
                    const r = [];
                    for (const [pubkey, count] of byPubKey.entries()) {
                      r.push({
                        pubkey,
                        count,
                        f: followers.get(pubkey)?.length || 0,
                      });
                    }
                    r.sort((a, b) => b.f - a.f);
                    for (const e of r) {
                      // @ts-ignore
                      e.f = undefined;
                    }
                    counts.push(r);
                  }
                } else if (!filter.group_by) {
                  let count = 0;
                  for (const pubkey of filter["#p"]) {
                    count += followers.get(pubkey)?.length || 0;
                  }
                  counts.push({count});
                } else {
                  counts.push(null);
                }
              } else {
                counts.push(null);
              }
            }
            ws.send(JSON.stringify(["COUNT", sub, ...counts]));
          }
          stats.push([
            performance.now() - start,
            JSON.stringify(data),
            Date.now(),
          ]);
          if (stats.length > 1000) {
            stats.shift();
          }
        } catch (e) {
          ws.send(JSON.stringify(["NOTICE", "error: " + e]));
          errors.push([JSON.stringify(data), e]);
          if (errors.length > 100) {
            errors.shift();
          }
        }
      });
    });
  }
  async close(): Promise<void> {
    new Promise((resolve) => this.wss.close(resolve));
  }
  disconnectAll() {
    for (const ws of this.connections) {
      ws.close();
    }
  }
}
